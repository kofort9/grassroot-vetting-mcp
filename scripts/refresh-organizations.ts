#!/usr/bin/env npx tsx
/**
 * BON-92: Refresh organizations table from IRS BMF CSV data.
 *
 * Downloads 4 regional BMF CSVs, parses them, and upserts into
 * Supabase `organizations` table. Does NOT touch `vetting_results`.
 *
 * Reuses the same BMF CSV format/parsing as discovery-index.ts.
 * Orgs removed from BMF are intentionally NOT deleted — they may
 * still have valid vetting_results via FK.
 *
 * Usage:
 *   npx tsx scripts/refresh-organizations.ts
 *
 * Required env vars:
 *   SUPABASE_URL            - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Service role key (write access)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import axios from "axios";
import { parse } from "csv-parse";
import type { Readable } from "stream";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BMF_BASE_URL = "https://www.irs.gov/pub/irs-soi";
const BMF_REGIONS = ["eo1", "eo2", "eo3", "eo4"];
const MIN_BMF_ROWS = 500_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB per file
const BATCH_SIZE = 1000;
const MAX_RETRIES = 3;

// Field validation limits
const MAX_NAME_LENGTH = 200;
const MAX_STATE_LENGTH = 2;
const MAX_NTEE_LENGTH = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrgRow {
  ein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
  subsection: number;
  ruling_date: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeField(value: string, maxLength: number): string {
  return value
    .replace(/[<>]/g, "") // strip angle brackets (org names never need them)
    .replace(/[\x00-\x1F\x7F]/g, "") // strip control characters
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "") // strip Unicode directional overrides
    .trim()
    .slice(0, maxLength);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// BMF CSV Parsing (mirrors discovery-index.ts parseBmfStream)
// ---------------------------------------------------------------------------

function parseBmfStream(stream: Readable): Promise<OrgRow[]> {
  return new Promise((resolve, reject) => {
    const rows: OrgRow[] = [];
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    parser.on("readable", () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        const ein = (record.EIN || "").replace(/[-\s]/g, "");
        if (!/^\d{9}$/.test(ein)) continue;

        const name = sanitizeField(record.NAME || "", MAX_NAME_LENGTH);
        if (!name) continue; // name is NOT NULL

        rows.push({
          ein,
          name,
          city: sanitizeField(record.CITY || "", 100),
          state: sanitizeField(record.STATE || "", MAX_STATE_LENGTH),
          ntee_code: sanitizeField(record.NTEE_CD || "", MAX_NTEE_LENGTH),
          subsection: parseInt(record.SUBSECTION || "0", 10) || 0,
          ruling_date: sanitizeField(record.RULING || "", 10),
        });
      }
    });

    parser.on("error", reject);
    parser.on("end", () => resolve(rows));
    stream.pipe(parser);
  });
}

// ---------------------------------------------------------------------------
// Download with retry
// ---------------------------------------------------------------------------

async function downloadRegion(region: string): Promise<OrgRow[]> {
  const url = `${BMF_BASE_URL}/${region}.csv`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`  Downloading ${region} (attempt ${attempt})...`);
      const response = await axios.get(url, {
        responseType: "stream",
        timeout: 120_000,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
      });

      const rows = await parseBmfStream(response.data as Readable);
      console.log(`  Parsed ${rows.length.toLocaleString()} rows from ${region}`);
      return rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed ${region} attempt ${attempt}: ${msg}`);

      if (attempt === MAX_RETRIES) {
        throw new Error(`Failed to download ${region} after ${MAX_RETRIES} attempts: ${msg}`);
      }

      const backoffMs = Math.pow(2, attempt) * 1000;
      console.log(`  Retrying in ${backoffMs / 1000}s...`);
      await sleep(backoffMs);
    }
  }

  throw new Error("Unreachable");
}

// ---------------------------------------------------------------------------
// Supabase upsert in batches
// ---------------------------------------------------------------------------

async function upsertBatches(
  supabase: SupabaseClient,
  rows: OrgRow[],
  refreshedAt: string,
): Promise<number> {
  let upserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("organizations")
      .upsert(
        batch.map((r) => ({
          ein: r.ein,
          name: r.name,
          city: r.city,
          state: r.state,
          ntee_code: r.ntee_code,
          subsection: r.subsection,
          ruling_date: r.ruling_date,
          updated_at: refreshedAt,
        })),
        { onConflict: "ein" },
      );

    if (error) {
      throw new Error(`Upsert failed at batch ${Math.floor(i / BATCH_SIZE)}: ${error.message}`);
    }

    upserted += batch.length;

    if (upserted % 50_000 === 0 || upserted === rows.length) {
      console.log(`  Upserted ${upserted.toLocaleString()} / ${rows.length.toLocaleString()}`);
    }
  }

  return upserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  console.log("=== BMF → Supabase Organizations Refresh ===\n");
  const start = Date.now();
  const refreshedAt = new Date().toISOString();

  // 1. Download, parse, and deduplicate all regions
  // Rows go directly into the dedup Map to halve peak memory (~1.8M rows)
  console.log("Downloading BMF CSVs...");
  const byEin = new Map<string, OrgRow>();
  let totalParsed = 0;
  for (const region of BMF_REGIONS) {
    const rows = await downloadRegion(region);
    for (const row of rows) {
      byEin.set(row.ein, row); // later regions overwrite earlier
    }
    totalParsed += rows.length;
  }

  console.log(`\nTotal parsed: ${totalParsed.toLocaleString()} rows`);

  const dedupedRows = Array.from(byEin.values());
  console.log(`Unique EINs: ${dedupedRows.length.toLocaleString()}\n`);

  // 2. Safety check (post-dedup to catch real unique count, not inflated by cross-region dupes)
  if (dedupedRows.length < MIN_BMF_ROWS) {
    console.error(
      `BMF data too small: ${dedupedRows.length.toLocaleString()} unique EINs (expected >= ${MIN_BMF_ROWS.toLocaleString()}). Aborting.`,
    );
    process.exit(1);
  }

  // 4. Upsert to Supabase
  console.log("Upserting to Supabase...");
  const upserted = await upsertBatches(supabase, dedupedRows, refreshedAt);

  // 5. Post-upsert validation
  console.log("\nVerifying data integrity...");
  const { count, error: countError } = await supabase
    .from("organizations")
    .select("*", { count: "exact", head: true });

  if (countError) {
    throw new Error(`Failed to verify row count: ${countError.message}`);
  }

  console.log(`Supabase organizations row count: ${count?.toLocaleString()}`);

  // Threshold: 99% — allows for minor transient write failures but catches
  // catastrophic data loss. 1% of 1.8M ≈ 18K rows max tolerance.
  if (count !== null && count < dedupedRows.length * 0.99) {
    throw new Error(
      `Data integrity check failed: expected ~${dedupedRows.length.toLocaleString()} rows, found ${count.toLocaleString()}`,
    );
  }

  const duration = ((Date.now() - start) / 1000 / 60).toFixed(1);
  console.log(`\n=== Complete ===`);
  console.log(`Upserted: ${upserted.toLocaleString()} organizations`);
  console.log(`Duration: ${duration} minutes`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
