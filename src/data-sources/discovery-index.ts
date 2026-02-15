import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import axios from "axios";
import { parse } from "csv-parse";
import {
  BmfRow,
  DiscoveryCandidate,
  DiscoveryFilters,
  DiscoveryResult,
  DiscoveryIndexConfig,
  DiscoveryManifest,
} from "../domain/discovery/types.js";
import {
  logInfo,
  logWarn,
  logError,
  getErrorMessage,
} from "../core/logging.js";
import { SqliteDatabase } from "./sqlite-adapter.js";

const DB_FILENAME = "discovery-index.db";
const MANIFEST_FILENAME = "discovery-manifest.json";
const BMF_BASE_URL = "https://www.irs.gov/pub/irs-soi";

// Safety constants
const MIN_BMF_ROWS = 500_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB per file
const REFRESH_COOLDOWN_MS = 300_000; // 5 min between rebuilds
const BATCH_INSERT_SIZE = 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class DiscoveryIndex {
  private db: SqliteDatabase | null = null;
  private config: DiscoveryIndexConfig;
  private lastBuildAt = 0;

  constructor(config: DiscoveryIndexConfig) {
    this.config = config;
  }

  /** Initialize DB schema. Does NOT download data -- call buildIndex() for that. */
  initialize(): void {
    const dbPath = path.join(this.config.dataDir, DB_FILENAME);
    this.db = SqliteDatabase.open(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.sqlExec(`
      CREATE TABLE IF NOT EXISTS bmf_orgs (
        ein        TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        city       TEXT NOT NULL DEFAULT '',
        state      TEXT NOT NULL DEFAULT '',
        ntee_code  TEXT NOT NULL DEFAULT '',
        subsection INTEGER NOT NULL DEFAULT 0,
        ruling_date TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_bmf_state ON bmf_orgs(state);
      CREATE INDEX IF NOT EXISTS idx_bmf_ntee ON bmf_orgs(ntee_code);
      CREATE INDEX IF NOT EXISTS idx_bmf_subsection ON bmf_orgs(subsection);
      CREATE INDEX IF NOT EXISTS idx_bmf_state_ntee ON bmf_orgs(state, ntee_code);
    `);

    this.db.persist();
    logInfo("DiscoveryIndex initialized");
  }

  /** Check if index exists and is fresh enough. */
  isReady(): boolean {
    const manifest = this.loadManifestSync();
    if (!manifest.bmf_index) return false;

    const builtAt = new Date(manifest.bmf_index.built_at);
    const now = new Date();
    const ageDays = (now.getTime() - builtAt.getTime()) / (1000 * 60 * 60 * 24);

    return ageDays <= this.config.dataMaxAgeDays;
  }

  /** Download BMF CSVs and build the SQLite index. Idempotent -- rebuilds from scratch. */
  async buildIndex(): Promise<{ rowCount: number; duration: number }> {
    this.ensureOpen();

    const now = Date.now();
    if (now - this.lastBuildAt < REFRESH_COOLDOWN_MS) {
      const waitSec = Math.ceil(
        (REFRESH_COOLDOWN_MS - (now - this.lastBuildAt)) / 1000,
      );
      throw new Error(`Build cooldown: try again in ${waitSec}s`);
    }

    const start = Date.now();
    await fsp.mkdir(this.config.dataDir, { recursive: true });

    // Download and parse all region CSVs
    const allRows: BmfRow[] = [];
    const regionUrls: string[] = [];

    for (const region of this.config.bmfRegions) {
      const url = `${BMF_BASE_URL}/${region}.csv`;
      regionUrls.push(url);
      logInfo(`Downloading BMF region: ${region}`);

      try {
        const response = await axios.get(url, {
          responseType: "stream",
          timeout: 120_000,
          maxContentLength: MAX_DOWNLOAD_BYTES,
          maxBodyLength: MAX_DOWNLOAD_BYTES,
        });

        const rows = await this.parseBmfStream(response.data);
        for (const row of rows) allRows.push(row);
        logInfo(`Parsed ${rows.length} rows from ${region}`);
      } catch (error) {
        const msg = getErrorMessage(error);
        logError(`Failed to download BMF region ${region}:`, msg);
        throw new Error(`Failed to download BMF region ${region}: ${msg}`);
      }
    }

    if (allRows.length < MIN_BMF_ROWS) {
      throw new Error(
        `BMF data too small: ${allRows.length} rows (expected >= ${MIN_BMF_ROWS}). Possible corruption.`,
      );
    }

    // Rebuild table from scratch inside a transaction
    this.db!.sqlExec("DROP TABLE IF EXISTS bmf_orgs");
    this.db!.sqlExec(`
      CREATE TABLE bmf_orgs (
        ein        TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        city       TEXT NOT NULL DEFAULT '',
        state      TEXT NOT NULL DEFAULT '',
        ntee_code  TEXT NOT NULL DEFAULT '',
        subsection INTEGER NOT NULL DEFAULT 0,
        ruling_date TEXT NOT NULL DEFAULT ''
      );
    `);

    const INSERT_SQL = `
      INSERT OR REPLACE INTO bmf_orgs (ein, name, city, state, ntee_code, subsection, ruling_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const insertBatch = this.db!.transaction((rows: BmfRow[]) => {
      this.db!.runBulk(
        INSERT_SQL,
        rows.map((r) => [
          r.ein,
          r.name,
          r.city,
          r.state,
          r.ntee_code,
          r.subsection,
          r.ruling_date,
        ]),
      );
    });

    // Insert in batches
    for (let i = 0; i < allRows.length; i += BATCH_INSERT_SIZE) {
      const batch = allRows.slice(i, i + BATCH_INSERT_SIZE);
      insertBatch(batch);
    }

    // Create indexes after bulk insert (avoids maintaining B-trees during inserts)
    this.db!.sqlExec(`
      CREATE INDEX idx_bmf_state ON bmf_orgs(state);
      CREATE INDEX idx_bmf_ntee ON bmf_orgs(ntee_code);
      CREATE INDEX idx_bmf_subsection ON bmf_orgs(subsection);
      CREATE INDEX idx_bmf_state_ntee ON bmf_orgs(state, ntee_code);
    `);

    this.db!.persist();

    const duration = Date.now() - start;
    const rowCount = (
      this.db!.prepare(
        "SELECT COUNT(*) as count FROM bmf_orgs",
      ).get() as unknown as {
        count: number;
      }
    ).count;

    // Save manifest
    const manifest: DiscoveryManifest = {
      bmf_index: {
        built_at: new Date().toISOString(),
        row_count: rowCount,
        regions_loaded: this.config.bmfRegions,
        source_urls: regionUrls,
      },
    };
    await this.saveManifest(manifest);

    this.lastBuildAt = Date.now();
    logInfo(
      `Discovery index built: ${rowCount} orgs in ${(duration / 1000).toFixed(1)}s`,
    );

    return { rowCount, duration };
  }

  /** Query the index with filters. Returns paginated results. */
  query(filters: DiscoveryFilters): DiscoveryResult {
    this.ensureOpen();

    const conditions: string[] = [];
    const params: unknown[] = [];
    const filtersApplied: string[] = [];

    // State filter
    if (filters.state) {
      conditions.push("state = ?");
      params.push(filters.state.toUpperCase());
      filtersApplied.push(`state=${filters.state.toUpperCase()}`);
    }

    // City filter (case-insensitive)
    if (filters.city) {
      conditions.push("LOWER(city) = LOWER(?)");
      params.push(filters.city);
      filtersApplied.push(`city=${filters.city}`);
    }

    // NTEE category prefix matching (OR within, AND with other filters)
    if (filters.nteeCategories && filters.nteeCategories.length > 0) {
      const nteeClauses = filters.nteeCategories.map(
        () => "ntee_code LIKE ? || '%'",
      );
      conditions.push(`(${nteeClauses.join(" OR ")})`);
      params.push(...filters.nteeCategories.map((c) => c.toUpperCase()));
      filtersApplied.push(`ntee_include=[${filters.nteeCategories.join(",")}]`);
    }

    // NTEE exclude prefix matching
    if (filters.nteeExclude && filters.nteeExclude.length > 0) {
      const excludeClauses = filters.nteeExclude.map(
        () => "ntee_code NOT LIKE ? || '%'",
      );
      conditions.push(excludeClauses.join(" AND "));
      params.push(...filters.nteeExclude.map((c) => c.toUpperCase()));
      filtersApplied.push(`ntee_exclude=[${filters.nteeExclude.join(",")}]`);
    }

    // Subsection filter (default: 3 for 501(c)(3))
    if (filters.subsection !== undefined) {
      conditions.push("subsection = ?");
      params.push(filters.subsection);
      filtersApplied.push(`subsection=${filters.subsection}`);
    }

    // Ruling year range
    if (filters.minRulingYear !== undefined) {
      conditions.push("CAST(SUBSTR(ruling_date, 1, 4) AS INTEGER) >= ?");
      params.push(filters.minRulingYear);
      filtersApplied.push(`minRulingYear=${filters.minRulingYear}`);
    }

    if (filters.maxRulingYear !== undefined) {
      conditions.push("CAST(SUBSTR(ruling_date, 1, 4) AS INTEGER) <= ?");
      params.push(filters.maxRulingYear);
      filtersApplied.push(`maxRulingYear=${filters.maxRulingYear}`);
    }

    // Name substring search (parameterized, NOT string concat)
    if (filters.nameContains) {
      conditions.push("name LIKE '%' || ? || '%'");
      params.push(filters.nameContains.toUpperCase());
      filtersApplied.push(`nameContains=${filters.nameContains}`);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count total matching rows
    const countRow = this.db!.prepare(
      `SELECT COUNT(*) as total FROM bmf_orgs ${where}`,
    ).get(...params) as unknown as { total: number };

    // Apply pagination
    const limit = Math.max(
      1,
      Math.min(
        filters.limit ?? DEFAULT_LIMIT,
        this.config.maxOrgsPerQuery ?? MAX_LIMIT,
      ),
    );
    const offset = Math.max(0, filters.offset ?? 0);

    const rows = this.db!.prepare(
      `SELECT ein, name, city, state, ntee_code, subsection, ruling_date
       FROM bmf_orgs ${where}
       ORDER BY name
       LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as unknown as DiscoveryCandidate[];

    const stats = this.getStats();

    return {
      candidates: rows,
      total: countRow.total,
      filters_applied: filtersApplied,
      index_stats: {
        total_orgs: stats.totalOrgs,
        last_updated: stats.lastUpdated,
      },
    };
  }

  /** Look up a single org by EIN. Returns null if not found. */
  getByEin(ein: string): DiscoveryCandidate | null {
    this.ensureOpen();

    const normalized = ein.replace(/[-\s]/g, "");
    const row = this.db!.prepare(
      "SELECT ein, name, city, state, ntee_code, subsection, ruling_date FROM bmf_orgs WHERE ein = ?",
    ).get(normalized) as unknown as DiscoveryCandidate | undefined;

    return row ?? null;
  }

  /** Get index statistics. */
  getStats(): { totalOrgs: number; lastUpdated: string | null } {
    this.ensureOpen();

    const row = this.db!.prepare(
      "SELECT COUNT(*) as total FROM bmf_orgs",
    ).get() as unknown as { total: number };

    const manifest = this.loadManifestSync();
    return {
      totalOrgs: row.total,
      lastUpdated: manifest.bmf_index?.built_at ?? null,
    };
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logWarn(
          `DiscoveryIndex.close(): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.db = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error(
        "DiscoveryIndex not initialized. Call initialize() first.",
      );
    }
  }

  private parseBmfStream(stream: import("stream").Readable): Promise<BmfRow[]> {
    return new Promise((resolve, reject) => {
      const rows: BmfRow[] = [];
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

          rows.push({
            ein,
            name: record.NAME || "",
            city: record.CITY || "",
            state: record.STATE || "",
            ntee_code: record.NTEE_CD || "",
            subsection: parseInt(record.SUBSECTION || "0", 10) || 0,
            ruling_date: record.RULING || "",
          });
        }
      });

      parser.on("error", reject);
      parser.on("end", () => resolve(rows));
      stream.pipe(parser);
    });
  }

  private loadManifestSync(): DiscoveryManifest {
    const manifestPath = path.join(this.config.dataDir, MANIFEST_FILENAME);
    try {
      const content = fs.readFileSync(manifestPath, "utf-8");
      return JSON.parse(content) as DiscoveryManifest;
    } catch {
      return {};
    }
  }

  private async saveManifest(manifest: DiscoveryManifest): Promise<void> {
    const manifestPath = path.join(this.config.dataDir, MANIFEST_FILENAME);
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
}
