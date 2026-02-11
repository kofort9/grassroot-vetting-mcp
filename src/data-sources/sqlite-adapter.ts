/**
 * SQLite adapter wrapping sql.js (WASM) with a better-sqlite3-compatible API.
 *
 * sql.js runs SQLite entirely in WebAssembly — no native C++ addon, no ABI
 * mismatches across Node versions. The trade-off: databases live in memory and
 * must be explicitly persisted to disk.
 */
import initSqlJs, {
  type Database as SqlJsDatabase,
  type SqlJsStatic,
} from "sql.js";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Singleton WASM initialization
// ---------------------------------------------------------------------------

let SQL: SqlJsStatic | null = null;

/** Load the sql.js WASM binary. Idempotent — safe to call multiple times. */
export async function ensureSqlJs(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

// ---------------------------------------------------------------------------
// PreparedStatement — mirrors better-sqlite3's Statement interface
// ---------------------------------------------------------------------------

export class PreparedStatement {
  private db: SqlJsDatabase;
  private sql: string;
  private parent: SqliteDatabase;

  constructor(db: SqlJsDatabase, sql: string, parent: SqliteDatabase) {
    this.db = db;
    this.sql = sql;
    this.parent = parent;
  }

  /** Execute INSERT/UPDATE/DELETE. Returns { lastInsertRowid }. */
  run(...params: unknown[]): { lastInsertRowid: number | bigint } {
    const flat = this.normalizeParams(params);
    const stmt = this.db.prepare(this.sql);
    try {
      if (flat.length > 0) stmt.bind(flat as initSqlJs.BindParams);
      stmt.step();
    } finally {
      stmt.free();
    }
    this.parent.markDirty();
    const result = this.db.exec("SELECT last_insert_rowid() as id");
    const rowid =
      result.length > 0 && result[0].values.length > 0
        ? (result[0].values[0][0] as number)
        : 0;
    return { lastInsertRowid: rowid };
  }

  /** Execute SELECT, return first row as object or undefined. */
  get(...params: unknown[]): Record<string, unknown> | undefined {
    const flat = this.normalizeParams(params);
    const stmt = this.db.prepare(this.sql);
    try {
      if (flat.length > 0) stmt.bind(flat as initSqlJs.BindParams);
      if (stmt.step()) {
        return stmt.getAsObject() as Record<string, unknown>;
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /** Execute SELECT, return all rows as objects. */
  all(...params: unknown[]): Record<string, unknown>[] {
    const flat = this.normalizeParams(params);
    const stmt = this.db.prepare(this.sql);
    const rows: Record<string, unknown>[] = [];
    try {
      if (flat.length > 0) stmt.bind(flat as initSqlJs.BindParams);
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as Record<string, unknown>);
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  /**
   * Flatten spread params into a single array for sql.js bind().
   * better-sqlite3 accepts .run(a, b, c) or .run([a, b, c]).
   */
  private normalizeParams(params: unknown[]): unknown[] {
    if (params.length === 1 && Array.isArray(params[0])) {
      return params[0];
    }
    return params;
  }
}

// ---------------------------------------------------------------------------
// SqliteDatabase — mirrors better-sqlite3's Database interface
// ---------------------------------------------------------------------------

export class SqliteDatabase {
  private db: SqlJsDatabase;
  private filePath: string | null;
  private dirty = false;

  private constructor(db: SqlJsDatabase, filePath: string | null) {
    this.db = db;
    this.filePath = filePath;
  }

  /** Open a file-backed database (loads existing file or creates new).
   *  Validates the SQLite header to prevent silent data loss from corrupted files. */
  static open(filePath: string): SqliteDatabase {
    if (!SQL) throw new Error("Call ensureSqlJs() before opening a database");
    let db: SqlJsDatabase;
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      if (buffer.length < 100) {
        throw new Error(
          `Database file too small to be valid SQLite: ${filePath} (${buffer.length} bytes)`,
        );
      }
      if (buffer.subarray(0, 15).toString("utf8") !== "SQLite format 3") {
        throw new Error(
          `Not a valid SQLite database (bad header): ${filePath}`,
        );
      }
      db = new SQL.Database(new Uint8Array(buffer));
    } else {
      db = new SQL.Database();
    }
    return new SqliteDatabase(db, filePath);
  }

  /** Create an in-memory database (useful for tests). */
  static inMemory(): SqliteDatabase {
    if (!SQL) throw new Error("Call ensureSqlJs() before opening a database");
    return new SqliteDatabase(new SQL.Database(), null);
  }

  /** Run a PRAGMA statement. WAL mode is silently ignored (in-memory).
   *  Only allowlisted pragma names are accepted to prevent injection. */
  pragma(pragmaStr: string): void {
    if (/journal_mode\s*=\s*WAL/i.test(pragmaStr)) return;
    if (/[\r\n]/.test(pragmaStr)) {
      throw new Error(`Disallowed PRAGMA: ${pragmaStr}`);
    }
    const ALLOWED =
      /^(journal_mode|foreign_keys|cache_size|busy_timeout)\s*=\s*\w+$/i;
    if (!ALLOWED.test(pragmaStr)) {
      throw new Error(`Disallowed PRAGMA: ${pragmaStr}`);
    }
    this.db.run(`PRAGMA ${pragmaStr}`);
  }

  /** Run one or more SQL statements (DDL, multi-statement strings). */
  sqlExec(sql: string): void {
    this.db.run(sql);
    this.dirty = true;
  }

  /** Prepare a parameterized statement. */
  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db, sql, this);
  }

  /**
   * Bulk-insert optimization: compile SQL once, bind+step for each param set,
   * then free. Skips per-row last_insert_rowid() and SQL re-compilation.
   */
  runBulk(sql: string, paramSets: unknown[][]): void {
    const stmt = this.db.prepare(sql);
    try {
      for (const params of paramSets) {
        stmt.bind(params as initSqlJs.BindParams);
        stmt.step();
        stmt.reset();
      }
    } finally {
      stmt.free();
    }
    this.dirty = true;
  }

  /**
   * Create a transaction wrapper, matching better-sqlite3's .transaction() API.
   * Returns a callable that wraps fn in BEGIN/COMMIT/ROLLBACK.
   */
  transaction<T>(fn: (args: T) => void): (args: T) => void {
    return (args: T) => {
      this.db.run("BEGIN");
      try {
        fn(args);
        this.db.run("COMMIT");
        this.dirty = true;
      } catch (err) {
        this.db.run("ROLLBACK");
        throw err;
      }
    };
  }

  /** Write the in-memory database to disk (no-op for in-memory-only DBs).
   *  Uses write-then-rename for atomicity — a crash mid-write won't corrupt
   *  the existing DB file. */
  persist(): void {
    if (this.filePath && this.dirty) {
      const data = this.db.export();
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, Buffer.from(data));
      fs.renameSync(tmpPath, this.filePath);
      this.dirty = false;
    }
  }

  /** Mark the database as dirty (for use after writes via PreparedStatement). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Close the database, persisting to disk first if file-backed. */
  close(): void {
    this.persist();
    this.db.close();
  }
}
