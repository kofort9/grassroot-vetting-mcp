import { logInfo } from "../core/logging.js";
import { SqliteDatabase } from "./sqlite-adapter.js";

export interface SearchHistoryRecord {
  id: number;
  tool: string;
  query_json: string;
  result_count: number;
  searched_at: string;
}

export interface ListSearchOptions {
  tool?: string;
  since?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * SearchHistoryStore logs search/discovery queries for replay and audit.
 * Shares the same SQLite database as VettingStore (vetting.db).
 */
export class SearchHistoryStore {
  private db: SqliteDatabase | null = null;

  /**
   * Initialize with an existing open SqliteDatabase instance.
   * This shares the db with VettingStore to avoid multiple WASM instances.
   */
  initialize(db: SqliteDatabase): void {
    this.db = db;

    this.db.sqlExec(`
      CREATE TABLE IF NOT EXISTS search_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        tool         TEXT NOT NULL,
        query_json   TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        searched_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_search_tool ON search_history(tool);
      CREATE INDEX IF NOT EXISTS idx_search_searched_at ON search_history(searched_at);
    `);

    this.db.persist();
    logInfo("SearchHistoryStore initialized");
  }

  logSearch(
    tool: string,
    queryArgs: Record<string, unknown>,
    resultCount: number,
  ): void {
    this.ensureOpen();

    const queryJson = JSON.stringify(queryArgs);
    this.db!.prepare(
      "INSERT INTO search_history (tool, query_json, result_count) VALUES (?, ?, ?)",
    ).run(tool, queryJson, resultCount);

    this.db!.persist();
  }

  listSearches(options?: ListSearchOptions): SearchHistoryRecord[] {
    this.ensureOpen();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.tool) {
      conditions.push("tool = ?");
      params.push(options.tool);
    }

    if (options?.since) {
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(options.since)) {
        throw new Error(
          `Invalid since date format: "${options.since}". Expected ISO 8601 (e.g., "2026-01-01").`,
        );
      }
      conditions.push("searched_at >= ?");
      params.push(options.since);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(
      1,
      Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    );

    const rows = this.db!.prepare(
      `SELECT * FROM search_history ${where} ORDER BY searched_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as unknown as SearchHistoryRecord[];

    return rows;
  }

  getById(id: number): SearchHistoryRecord | null {
    this.ensureOpen();

    const row = this.db!.prepare(
      "SELECT * FROM search_history WHERE id = ?",
    ).get(id) as unknown as SearchHistoryRecord | undefined;

    return row ?? null;
  }

  close(): void {
    // Don't close the db here — VettingStore owns it.
    this.db = null;
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error(
        "SearchHistoryStore not initialized. Call initialize() first.",
      );
    }
  }
}
