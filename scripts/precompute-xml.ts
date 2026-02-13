#!/usr/bin/env npx tsx
/**
 * Pre-compute XML 990 enrichment for vetted nonprofits.
 *
 * Two-pass design: reads PASS/REVIEW EINs from vetting.db (pass 1 output),
 * downloads XML from GivingTuesday, extracts structured data, stores in xml-990.db.
 *
 * Safe to Ctrl+C and resume: skips EINs already in xml_990_extracts.
 *
 * Usage:
 *   npx tsx scripts/precompute-xml.ts
 *   npx tsx scripts/precompute-xml.ts --rate-limit 1500
 *   npx tsx scripts/precompute-xml.ts --metro bay_area
 */

import path from "path";
import { fileURLToPath } from "url";
import { ensureSqlJs, SqliteDatabase } from "../src/data-sources/sqlite-adapter.js";
import { ConcordanceIndex } from "../src/data-sources/concordance.js";
import { GivingTuesdayClient } from "../src/data-sources/givingtuesday-client.js";
import { Xml990Parser } from "../src/domain/nonprofit/xml-parser.js";
import { Xml990Store } from "../src/data-sources/xml-990-store.js";
import { loadGivingTuesdayConfig } from "../src/core/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");

// ============================================================================
// CLI Args
// ============================================================================

function parseArgs(): { rateLimitMs: number; metroFilter: string | null } {
  const args = process.argv.slice(2);
  let rateLimitMs = 1000;
  let metroFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rate-limit" && args[i + 1]) {
      rateLimitMs = Math.max(200, parseInt(args[i + 1], 10) || 1000);
      i++;
    } else if (args[i] === "--metro" && args[i + 1]) {
      metroFilter = args[i + 1];
      i++;
    }
  }

  return { rateLimitMs, metroFilter };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { rateLimitMs, metroFilter } = parseArgs();

  console.log("=== XML 990 Enrichment Pipeline ===");
  console.log(`Rate limit: ${rateLimitMs}ms between requests`);
  if (metroFilter) console.log(`Metro filter: ${metroFilter}`);
  console.log();

  // 1. Initialize sql.js WASM
  await ensureSqlJs();

  // 2. Open vetting.db read-only to get PASS/REVIEW EINs
  const vettingDbPath = path.join(DATA_DIR, "vetting.db");
  let vettingDb: SqliteDatabase;
  try {
    vettingDb = SqliteDatabase.open(vettingDbPath);
  } catch (err) {
    console.error(`Cannot open vetting.db at ${vettingDbPath}: ${err}`);
    console.error("Run the Tier 1 precompute first.");
    process.exit(1);
  }

  const einRows = vettingDb.prepare(
    "SELECT DISTINCT ein FROM vetting_results WHERE recommendation IN ('PASS', 'REVIEW')",
  ).all() as { ein: string }[];

  console.log(`Found ${einRows.length} PASS/REVIEW EINs in vetting.db`);

  // Metro filtering: if specified, filter to EINs in that metro's cities
  let targetEins = einRows.map((r) => r.ein);
  if (metroFilter) {
    const cityRows = vettingDb.prepare(`
      SELECT DISTINCT ein FROM vetting_results
      WHERE recommendation IN ('PASS', 'REVIEW')
      AND result_json LIKE ?
    `).all(`%${metroFilter}%`) as { ein: string }[];
    targetEins = cityRows.map((r) => r.ein);
    console.log(`Filtered to ${targetEins.length} EINs for metro: ${metroFilter}`);
  }

  // Close vetting.db — we're done reading from it
  vettingDb.close();

  if (targetEins.length === 0) {
    console.log("No EINs to process.");
    process.exit(0);
  }

  // 3. Initialize XML pipeline components
  const concordance = new ConcordanceIndex(
    path.join(DATA_DIR, "concordance/concordance.csv"),
  );
  await concordance.initialize();

  const gtConfig = loadGivingTuesdayConfig();
  const gtClient = new GivingTuesdayClient({
    ...gtConfig,
    rateLimitMs,
  });

  const parser = new Xml990Parser(concordance);

  const xml990Store = new Xml990Store(DATA_DIR);
  xml990Store.initialize();

  // 4. Process each EIN — with extraction yield tracking
  let processed = 0;
  let skippedCached = 0;
  let skippedNoXml = 0;
  let errors = 0;
  let emptyExtracts = 0;
  let partialExtracts = 0;
  let fullExtracts = 0;
  const schemaVersions = new Map<string, number>();
  const startTime = Date.now();

  for (const ein of targetEins) {
    processed++;

    try {
      // Resume-safe: get the latest filing, then check if already extracted
      const result = await gtClient.getLatestXml(ein);

      if (!result) {
        skippedNoXml++;
      } else if (xml990Store.hasExtract(ein, result.metadata.ObjectId)) {
        skippedCached++;
      } else {
        const { xml, metadata } = result;

        // Track schema version distribution
        const ver = metadata.ReturnVersion ?? "unknown";
        schemaVersions.set(ver, (schemaVersions.get(ver) ?? 0) + 1);

        const extracted = parser.parse(xml, {
          formType: metadata.FormType,
          schemaVersion: metadata.ReturnVersion,
          ein: ein.replace(/[-\s]/g, ""),
          taxYear: parseInt(metadata.TaxYear, 10),
          objectId: metadata.ObjectId,
        });

        // Yield classification
        const isEmpty = Xml990Parser.isEmptyExtract(extracted);
        const parts = [
          extracted.partIX ? "IX" : null,
          extracted.partVI ? "VI" : null,
          extracted.partVII.length > 0 ? "VII" : null,
          extracted.partVIII ? "VIII" : null,
        ].filter(Boolean);

        if (isEmpty) {
          emptyExtracts++;
          console.warn(
            `  [${processed}/${targetEins.length}] EIN ${ein} — EMPTY EXTRACT ` +
            `(schema ${ver}, form ${metadata.FormType}) — skipping storage`,
          );
          // Don't store empty extracts — they'd block retry on resume
          continue;
        }

        const isFull = parts.length === 4;
        if (isFull) fullExtracts++;
        else partialExtracts++;

        xml990Store.saveMetadata(metadata);
        xml990Store.saveExtract(extracted);

        console.log(
          `  [${processed}/${targetEins.length}] EIN ${ein} — extracted Part ${parts.join(", ")}`,
        );
      }
    } catch (err: unknown) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] EIN ${ein}: ${msg}`);
    }

    // Periodic persist and progress report every 100 EINs
    if (processed % 100 === 0) {
      xml990Store.persist();
      printProgress(processed, targetEins.length, skippedCached, skippedNoXml, errors, startTime);
    }
  }

  // Final persist
  xml990Store.persist();

  // Yield summary
  const extractedCount = fullExtracts + partialExtracts;
  const yieldPct = extractedCount > 0
    ? ((fullExtracts / extractedCount) * 100).toFixed(1)
    : "N/A";

  console.log("\n=== XML Enrichment Complete ===");
  console.log(`Total processed:  ${processed}`);
  console.log(`  Full extracts:  ${fullExtracts}`);
  console.log(`  Partial:        ${partialExtracts}`);
  console.log(`  Empty (skip):   ${emptyExtracts}`);
  console.log(`  Cached (skip):  ${skippedCached}`);
  console.log(`  No XML (skip):  ${skippedNoXml}`);
  console.log(`  Errors:         ${errors}`);
  console.log(`  Full yield:     ${yieldPct}%`);
  console.log(`Duration: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);

  // Schema version distribution (helps detect new IRS versions)
  if (schemaVersions.size > 0) {
    console.log("\nSchema version distribution:");
    const sorted = [...schemaVersions.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ver, count] of sorted) {
      console.log(`  ${ver}: ${count}`);
    }
  }

  // Alert on high empty rate (possible schema drift)
  if (emptyExtracts > 0 && extractedCount > 0) {
    const emptyRate = emptyExtracts / (extractedCount + emptyExtracts);
    if (emptyRate > 0.1) {
      console.warn(
        `\n⚠ WARNING: ${(emptyRate * 100).toFixed(1)}% empty extract rate — ` +
        `concordance may need updating for new IRS schema versions`,
      );
    }
  }

  xml990Store.close();
}

function printProgress(
  processed: number,
  total: number,
  cached: number,
  noXml: number,
  errors: number,
  startTime: number,
): void {
  const elapsedSec = (Date.now() - startTime) / 1000;
  const pct = ((processed / total) * 100).toFixed(1);
  const rate = elapsedSec > 0 ? (processed / elapsedSec).toFixed(1) : "0";
  console.log(
    `  [${pct}%] ${processed}/${total} ` +
    `(${cached} cached, ${noXml} no-xml, ${errors} errors) ` +
    `${elapsedSec.toFixed(0)}s elapsed, ${rate}/s`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
