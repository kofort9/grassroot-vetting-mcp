import path from "path";
import { logInfo, logWarn } from "../core/logging.js";
import { SqliteDatabase } from "./sqlite-adapter.js";
import type {
  GtFilingIndexEntry,
  Xml990ExtractedData,
} from "../domain/nonprofit/types.js";

const DB_FILENAME = "xml-990.db";

export class Xml990Store {
  private db: SqliteDatabase | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  initialize(): void {
    const dbPath = path.join(this.dataDir, DB_FILENAME);
    this.db = SqliteDatabase.open(dbPath);

    this.db.pragma("journal_mode = WAL");

    this.db.sqlExec(`
      CREATE TABLE IF NOT EXISTS xml_990_metadata (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ein             TEXT NOT NULL,
        tax_year        INTEGER NOT NULL,
        object_id       TEXT NOT NULL UNIQUE,
        form_type       TEXT NOT NULL,
        schema_version  TEXT NOT NULL,
        file_size_bytes INTEGER,
        file_sha256     TEXT,
        fetched_at      TEXT NOT NULL DEFAULT (datetime('now')),
        parsed_at       TEXT
      );

      CREATE TABLE IF NOT EXISTS xml_990_extracts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ein             TEXT NOT NULL,
        tax_year        INTEGER NOT NULL,
        object_id       TEXT NOT NULL,
        extract_json    TEXT NOT NULL,
        extracted_at    TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (object_id) REFERENCES xml_990_metadata(object_id)
      );

      CREATE INDEX IF NOT EXISTS idx_xml_meta_ein ON xml_990_metadata(ein);
      CREATE INDEX IF NOT EXISTS idx_xml_meta_ein_year ON xml_990_metadata(ein, tax_year);
      CREATE INDEX IF NOT EXISTS idx_xml_extract_ein ON xml_990_extracts(ein);
      CREATE INDEX IF NOT EXISTS idx_xml_extract_ein_year ON xml_990_extracts(ein, tax_year);
    `);

    this.db.persist();
    logInfo("Xml990Store initialized");
  }

  saveMetadata(entry: GtFilingIndexEntry): void {
    this.ensureOpen();

    const ein = entry.EIN.replace(/[-\s]/g, "");
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO xml_990_metadata
        (ein, tax_year, object_id, form_type, schema_version, file_size_bytes, file_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      ein,
      parseInt(entry.TaxYear, 10),
      entry.ObjectId,
      entry.FormType,
      entry.ReturnVersion,
      parseInt(entry.FileSizeBytes, 10) || null,
      entry.FileSha256 || null,
    );
  }

  saveExtract(data: Xml990ExtractedData): void {
    this.ensureOpen();

    const ein = data.ein.replace(/[-\s]/g, "");
    const extractJson = JSON.stringify(data);

    this.db!.prepare(`
      INSERT INTO xml_990_extracts (ein, tax_year, object_id, extract_json)
      VALUES (?, ?, ?, ?)
    `).run(ein, data.taxYear, data.objectId, extractJson);

    // Update parsed_at on metadata
    this.db!.prepare(`
      UPDATE xml_990_metadata SET parsed_at = datetime('now') WHERE object_id = ?
    `).run(data.objectId);
  }

  getLatestExtract(ein: string): Xml990ExtractedData | null {
    this.ensureOpen();

    const normalized = ein.replace(/[-\s]/g, "");
    const row = this.db!.prepare(
      "SELECT extract_json FROM xml_990_extracts WHERE ein = ? ORDER BY tax_year DESC, id DESC LIMIT 1",
    ).get(normalized) as { extract_json: string } | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.extract_json) as Xml990ExtractedData;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Corrupt extract JSON for EIN ${ein}: ${msg}`);
    }
  }

  /** Get all extracts for an EIN, ordered by tax year descending. */
  getAllExtracts(ein: string): Xml990ExtractedData[] {
    this.ensureOpen();

    const normalized = ein.replace(/[-\s]/g, "");
    const rows = this.db!.prepare(
      "SELECT extract_json FROM xml_990_extracts WHERE ein = ? ORDER BY tax_year DESC, id DESC",
    ).all(normalized) as { extract_json: string }[];

    return rows.map((row) => JSON.parse(row.extract_json) as Xml990ExtractedData);
  }

  hasExtract(ein: string, objectId: string): boolean {
    this.ensureOpen();

    const normalized = ein.replace(/[-\s]/g, "");
    const row = this.db!.prepare(
      "SELECT 1 FROM xml_990_extracts WHERE ein = ? AND object_id = ? LIMIT 1",
    ).get(normalized, objectId) as Record<string, unknown> | undefined;

    return row !== undefined;
  }

  persist(): void {
    if (this.db) {
      this.db.persist();
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logWarn(
          `Xml990Store.close(): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.db = null;
    }
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error("Xml990Store not initialized. Call initialize() first.");
    }
  }
}
