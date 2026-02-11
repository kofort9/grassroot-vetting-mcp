import path from "path";
import { Tier1Result } from "../domain/nonprofit/types.js";
import { logInfo, logWarn } from "../core/logging.js";
import { SqliteDatabase } from "./sqlite-adapter.js";

export interface VettedRecord {
  id: number;
  ein: string;
  name: string;
  recommendation: "PASS" | "REVIEW" | "REJECT";
  score: number | null;
  passed: boolean;
  gate_blocked: boolean;
  red_flag_count: number;
  result_json: string;
  vetted_at: string;
  vetted_by: string;
}

export interface ListVettedOptions {
  recommendation?: "PASS" | "REVIEW" | "REJECT";
  since?: string;
  limit?: number;
}

export interface VettingStats {
  total: number;
  pass: number;
  review: number;
  reject: number;
}

const DB_FILENAME = "vetting.db";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class VettingStore {
  private db: SqliteDatabase | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  initialize(): void {
    const dbPath = path.join(this.dataDir, DB_FILENAME);
    this.db = SqliteDatabase.open(dbPath);

    // WAL pragma is silently ignored by sql.js (in-memory), kept for documentation
    this.db.pragma("journal_mode = WAL");

    this.db.sqlExec(`
      CREATE TABLE IF NOT EXISTS vetting_results (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ein            TEXT NOT NULL,
        name           TEXT NOT NULL,
        recommendation TEXT NOT NULL CHECK(recommendation IN ('PASS','REVIEW','REJECT')),
        score          REAL,
        passed         INTEGER NOT NULL,
        gate_blocked   INTEGER NOT NULL,
        red_flag_count INTEGER NOT NULL DEFAULT 0,
        result_json    TEXT NOT NULL,
        vetted_at      TEXT NOT NULL DEFAULT (datetime('now')),
        vetted_by      TEXT NOT NULL DEFAULT 'kofi'
      );

      CREATE INDEX IF NOT EXISTS idx_vetting_ein ON vetting_results(ein);
      CREATE INDEX IF NOT EXISTS idx_vetting_recommendation ON vetting_results(recommendation);
      CREATE INDEX IF NOT EXISTS idx_vetting_vetted_at ON vetting_results(vetted_at);
    `);

    this.db.persist();
    logInfo("VettingStore initialized");
  }

  saveResult(result: Tier1Result, vettedBy: string = "kofi"): VettedRecord {
    this.ensureOpen();

    const ein = result.ein.replace(/[-\s]/g, "");
    const resultJson = JSON.stringify(result);

    const stmt = this.db!.prepare(`
      INSERT INTO vetting_results (ein, name, recommendation, score, passed, gate_blocked, red_flag_count, result_json, vetted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      ein,
      result.name,
      result.recommendation,
      result.score,
      result.passed ? 1 : 0,
      result.gate_blocked ? 1 : 0,
      result.red_flags.length,
      resultJson,
      vettedBy,
    );

    const row = this.db!.prepare(
      "SELECT * FROM vetting_results WHERE id = ?",
    ).get(info.lastInsertRowid) as unknown as RawVettedRow;

    this.db!.persist();

    return this.mapRow(row);
  }

  getLatestByEin(ein: string): VettedRecord | null {
    this.ensureOpen();

    const normalized = ein.replace(/[-\s]/g, "");
    const row = this.db!.prepare(
      "SELECT * FROM vetting_results WHERE ein = ? ORDER BY vetted_at DESC, id DESC LIMIT 1",
    ).get(normalized) as unknown as RawVettedRow | undefined;

    return row ? this.mapRow(row) : null;
  }

  listVetted(options?: ListVettedOptions): VettedRecord[] {
    this.ensureOpen();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.recommendation) {
      conditions.push("recommendation = ?");
      params.push(options.recommendation);
    }

    if (options?.since) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(options.since)) {
        throw new Error(
          `Invalid since date format: "${options.since}". Expected ISO 8601 (e.g., "2026-01-01").`,
        );
      }
      conditions.push("vetted_at >= ?");
      params.push(options.since);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(
      1,
      Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    );

    const rows = this.db!.prepare(
      `SELECT * FROM vetting_results ${where} ORDER BY vetted_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as unknown as RawVettedRow[];

    return rows.map((row) => this.mapRow(row));
  }

  getStats(): VettingStats {
    this.ensureOpen();

    const row = this.db!.prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN recommendation = 'PASS' THEN 1 ELSE 0 END) as pass,
        SUM(CASE WHEN recommendation = 'REVIEW' THEN 1 ELSE 0 END) as review,
        SUM(CASE WHEN recommendation = 'REJECT' THEN 1 ELSE 0 END) as reject
      FROM vetting_results
    `,
    ).get() as unknown as {
      total: number;
      pass: number;
      review: number;
      reject: number;
    };

    return {
      total: row.total,
      pass: row.pass,
      review: row.review,
      reject: row.reject,
    };
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        logWarn(
          `VettingStore.close(): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.db = null;
    }
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error("VettingStore not initialized. Call initialize() first.");
    }
  }

  private mapRow(row: RawVettedRow): VettedRecord {
    return {
      id: row.id,
      ein: row.ein,
      name: row.name,
      recommendation: row.recommendation as "PASS" | "REVIEW" | "REJECT",
      score: row.score,
      passed: row.passed === 1,
      gate_blocked: row.gate_blocked === 1,
      red_flag_count: row.red_flag_count,
      result_json: row.result_json,
      vetted_at: row.vetted_at,
      vetted_by: row.vetted_by,
    };
  }
}

/** Raw row shape from SQLite (booleans are 0/1 integers) */
interface RawVettedRow {
  id: number;
  ein: string;
  name: string;
  recommendation: string;
  score: number | null;
  passed: number;
  gate_blocked: number;
  red_flag_count: number;
  result_json: string;
  vetted_at: string;
  vetted_by: string;
}
