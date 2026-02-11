import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureSqlJs,
  SqliteDatabase,
} from "../src/data-sources/sqlite-adapter.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-adapter-test-"));
}

describe("SqliteDatabase", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await ensureSqlJs();
  });

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // open / inMemory / basic operations
  // ===========================================================================

  describe("open and basic operations", () => {
    it("creates a new file-backed database", () => {
      const dbPath = path.join(tmpDir, "test.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
      db.prepare("INSERT INTO t (val) VALUES (?)").run("hello");
      db.close();

      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("reopens an existing database file", () => {
      const dbPath = path.join(tmpDir, "reopen.db");
      const db1 = SqliteDatabase.open(dbPath);
      db1.sqlExec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
      db1.prepare("INSERT INTO t (val) VALUES (?)").run("persisted");
      db1.close();

      const db2 = SqliteDatabase.open(dbPath);
      const row = db2.prepare("SELECT val FROM t WHERE id = 1").get() as {
        val: string;
      };
      db2.close();

      expect(row.val).toBe("persisted");
    });

    it("inMemory creates a database that works without a file", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (x INT)");
      db.prepare("INSERT INTO t VALUES (?)").run(42);
      const row = db.prepare("SELECT x FROM t").get() as { x: number };
      db.close();

      expect(row.x).toBe(42);
    });

    it("rejects corrupted (non-SQLite) files", () => {
      const dbPath = path.join(tmpDir, "corrupt.db");
      fs.writeFileSync(dbPath, "this is not a sqlite database");

      expect(() => SqliteDatabase.open(dbPath)).toThrow();
    });

    it("rejects empty files (prevents silent data loss)", () => {
      const dbPath = path.join(tmpDir, "empty.db");
      fs.writeFileSync(dbPath, Buffer.alloc(0));

      // Empty file = likely truncated/corrupted — should not silently create fresh DB
      expect(() => SqliteDatabase.open(dbPath)).toThrow();
    });
  });

  // ===========================================================================
  // PreparedStatement — run / get / all
  // ===========================================================================

  describe("PreparedStatement", () => {
    it("run returns lastInsertRowid", () => {
      const db = SqliteDatabase.open(path.join(tmpDir, "rowid.db"));
      db.sqlExec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

      const r1 = db.prepare("INSERT INTO t (v) VALUES (?)").run("a");
      const r2 = db.prepare("INSERT INTO t (v) VALUES (?)").run("b");
      db.close();

      expect(r1.lastInsertRowid).toBe(1);
      expect(r2.lastInsertRowid).toBe(2);
    });

    it("get returns undefined when no rows match", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT)");
      const row = db.prepare("SELECT * FROM t WHERE id = ?").get(999);
      db.close();

      expect(row).toBeUndefined();
    });

    it("all returns empty array when no rows match", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT)");
      const rows = db.prepare("SELECT * FROM t WHERE id = ?").all(999);
      db.close();

      expect(rows).toEqual([]);
    });

    it("run with zero params works", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      const r = db.prepare("INSERT INTO t DEFAULT VALUES").run();
      db.close();

      expect(r.lastInsertRowid).toBe(1);
    });

    it("statement reuse: same PreparedStatement can be called multiple times", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT, val TEXT)");

      const stmt = db.prepare("INSERT INTO t VALUES (?, ?)");
      stmt.run(1, "first");
      stmt.run(2, "second");
      stmt.run(3, "third");

      const rows = db.prepare("SELECT * FROM t ORDER BY id").all();
      db.close();

      expect(rows).toEqual([
        { id: 1, val: "first" },
        { id: 2, val: "second" },
        { id: 3, val: "third" },
      ]);
    });

    it("accepts params as spread args or single array", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (a INT, b INT)");

      // spread style
      db.prepare("INSERT INTO t VALUES (?, ?)").run(1, 2);
      // array style
      db.prepare("INSERT INTO t VALUES (?, ?)").run([3, 4]);

      const rows = db.prepare("SELECT * FROM t ORDER BY a").all();
      db.close();

      expect(rows).toEqual([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]);
    });
  });

  // ===========================================================================
  // Atomic persist (write-then-rename)
  // ===========================================================================

  describe("atomic persist", () => {
    it("no .tmp file lingers after successful persist", () => {
      const dbPath = path.join(tmpDir, "atomic.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INT)");
      db.persist();

      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);

      db.close();
    });

    it("persist creates parent directories if missing", () => {
      const nested = path.join(tmpDir, "deep", "nested", "test.db");
      const db = SqliteDatabase.open(nested);
      db.sqlExec("CREATE TABLE t (id INT)");
      db.persist();

      expect(fs.existsSync(nested)).toBe(true);
      db.close();
    });

    it("persist is a no-op when database is not dirty", () => {
      const dbPath = path.join(tmpDir, "clean.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INT)");
      db.persist();

      const writeSpy = vi.spyOn(fs, "writeFileSync");
      db.persist(); // Should skip — not dirty
      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
      db.close();
    });

    it("persist overwrites leftover .tmp from a previous crash", () => {
      const dbPath = path.join(tmpDir, "recover.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INT)");
      db.persist();

      // Simulate leftover .tmp from a crashed persist
      fs.writeFileSync(`${dbPath}.tmp`, "corrupt leftover");

      db.prepare("INSERT INTO t VALUES (?)").run(42);
      db.persist();

      expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);

      // DB should be intact
      const db2 = SqliteDatabase.open(dbPath);
      const row = db2.prepare("SELECT id FROM t").get() as { id: number };
      db2.close();
      db.close();

      expect(row.id).toBe(42);
    });

    it("persist is a no-op for in-memory databases", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT)");
      // Should not throw — just silently does nothing
      db.persist();
      db.close();
    });

    it("close persists before closing", () => {
      const dbPath = path.join(tmpDir, "close-persist.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INT, val TEXT)");
      db.prepare("INSERT INTO t VALUES (?, ?)").run(1, "saved");
      // Don't call persist() explicitly — close() should handle it
      db.close();

      const db2 = SqliteDatabase.open(dbPath);
      const row = db2.prepare("SELECT val FROM t WHERE id = 1").get() as {
        val: string;
      };
      db2.close();

      expect(row.val).toBe("saved");
    });
  });

  // ===========================================================================
  // runBulk
  // ===========================================================================

  describe("runBulk", () => {
    it("inserts multiple rows in a single prepare cycle", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT, name TEXT)");

      db.runBulk("INSERT INTO t VALUES (?, ?)", [
        [1, "alice"],
        [2, "bob"],
        [3, "carol"],
      ]);

      const rows = db.prepare("SELECT * FROM t ORDER BY id").all();
      db.close();

      expect(rows).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
        { id: 3, name: "carol" },
      ]);
    });

    it("handles empty paramSets without throwing", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT)");

      // Should not throw
      db.runBulk("INSERT INTO t VALUES (?)", []);

      const count = db.prepare("SELECT COUNT(*) as n FROM t").get() as {
        n: number;
      };
      db.close();

      expect(count.n).toBe(0);
    });

    it("marks database as dirty after bulk insert", () => {
      const dbPath = path.join(tmpDir, "bulk-dirty.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INT)");
      db.persist(); // Clear dirty flag

      db.runBulk("INSERT INTO t VALUES (?)", [[1], [2], [3]]);
      db.close(); // close() calls persist() — should write to disk

      const db2 = SqliteDatabase.open(dbPath);
      const count = db2.prepare("SELECT COUNT(*) as n FROM t").get() as {
        n: number;
      };
      db2.close();

      expect(count.n).toBe(3);
    });

    it("propagates errors on constraint violation (partial insert without txn)", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT UNIQUE)");
      db.prepare("INSERT INTO t VALUES (?)").run(1);

      expect(() => {
        db.runBulk("INSERT INTO t VALUES (?)", [[2], [3], [1], [4]]);
      }).toThrow();

      // Without a transaction wrapper, rows before the error survive
      const rows = db
        .prepare("SELECT id FROM t ORDER BY id")
        .all() as { id: number }[];
      db.close();

      expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    });

    it("works inside a transaction wrapper", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT, val TEXT)");

      const insertBatch = db.transaction((rows: [number, string][]) => {
        db.runBulk(
          "INSERT INTO t VALUES (?, ?)",
          rows,
        );
      });

      insertBatch([
        [1, "x"],
        [2, "y"],
      ]);

      const rows = db.prepare("SELECT * FROM t ORDER BY id").all();
      db.close();

      expect(rows).toHaveLength(2);
    });
  });

  // ===========================================================================
  // PRAGMA allowlist
  // ===========================================================================

  describe("pragma allowlist", () => {
    it("WAL mode is silently ignored", () => {
      const db = SqliteDatabase.inMemory();
      // Should not throw
      db.pragma("journal_mode = WAL");
      db.close();
    });

    it("allowed pragmas execute without error", () => {
      const db = SqliteDatabase.inMemory();
      db.pragma("foreign_keys = ON");
      db.pragma("cache_size = 2000");
      db.pragma("busy_timeout = 5000");
      db.close();
    });

    it("rejects unknown pragma names", () => {
      const db = SqliteDatabase.inMemory();
      expect(() => db.pragma("table_info(sqlite_master)")).toThrow(
        "Disallowed PRAGMA",
      );
      db.close();
    });

    it("blocks SQL injection via pragma and preserves data", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE important (data TEXT)");
      db.prepare("INSERT INTO important VALUES (?)").run("sentinel");

      expect(() =>
        db.pragma("x; DROP TABLE important; --"),
      ).toThrow("Disallowed PRAGMA");
      expect(() =>
        db.pragma("x; DELETE FROM important; --"),
      ).toThrow("Disallowed PRAGMA");

      // Sentinel row must survive
      const rows = db.prepare("SELECT * FROM important").all();
      expect(rows).toEqual([{ data: "sentinel" }]);
      db.close();
    });

    it("blocks newline-based pragma injection", () => {
      const db = SqliteDatabase.inMemory();
      expect(() =>
        db.pragma("cache_size = 1\nPRAGMA writable_schema = ON"),
      ).toThrow("Disallowed PRAGMA");
      expect(() =>
        db.pragma("cache_size = 1\rPRAGMA writable_schema = ON"),
      ).toThrow("Disallowed PRAGMA");
      db.close();
    });

    it("rejects special characters in pragma values", () => {
      const db = SqliteDatabase.inMemory();
      expect(() => db.pragma("cache_size = 1; DROP TABLE x")).toThrow(
        "Disallowed PRAGMA",
      );
      expect(() => db.pragma("busy_timeout = 1)--")).toThrow(
        "Disallowed PRAGMA",
      );
      expect(() => db.pragma("foreign_keys = ON'")).toThrow(
        "Disallowed PRAGMA",
      );
      expect(() => db.pragma("cache_size = -1")).toThrow("Disallowed PRAGMA");
      db.close();
    });

    it("is case-insensitive for allowed names", () => {
      const db = SqliteDatabase.inMemory();
      db.pragma("FOREIGN_KEYS = on");
      db.pragma("Cache_Size = 1000");
      db.close();
    });
  });

  // ===========================================================================
  // transaction
  // ===========================================================================

  describe("transaction", () => {
    it("commits on success", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT)");

      const insert = db.transaction((val: number) => {
        db.prepare("INSERT INTO t VALUES (?)").run(val);
      });

      insert(42);

      const row = db.prepare("SELECT id FROM t").get() as { id: number };
      db.close();

      expect(row.id).toBe(42);
    });

    it("rolls back on error and rethrows", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec("CREATE TABLE t (id INT UNIQUE)");
      db.prepare("INSERT INTO t VALUES (?)").run(1);

      const insertDuplicate = db.transaction((_: null) => {
        db.prepare("INSERT INTO t VALUES (?)").run(2);
        db.prepare("INSERT INTO t VALUES (?)").run(1); // unique violation
      });

      expect(() => insertDuplicate(null)).toThrow();

      // Row 2 should NOT exist (rolled back)
      const rows = db.prepare("SELECT id FROM t ORDER BY id").all();
      db.close();

      expect(rows).toEqual([{ id: 1 }]);
    });
  });

  // ===========================================================================
  // sqlExec
  // ===========================================================================

  describe("sqlExec", () => {
    it("executes multi-statement DDL", () => {
      const db = SqliteDatabase.inMemory();
      db.sqlExec(`
        CREATE TABLE a (id INT);
        CREATE TABLE b (id INT);
      `);

      // Both tables should exist
      db.prepare("INSERT INTO a VALUES (?)").run(1);
      db.prepare("INSERT INTO b VALUES (?)").run(2);
      db.close();
    });

    it("marks database as dirty", () => {
      const dbPath = path.join(tmpDir, "exec-dirty.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INT)");
      db.close();

      // close() persists dirty state — file should contain the table
      const db2 = SqliteDatabase.open(dbPath);
      db2.prepare("INSERT INTO t VALUES (?)").run(1);
      db2.close();
    });
  });

  // ===========================================================================
  // dirty flag correctness
  // ===========================================================================

  describe("dirty flag", () => {
    it("read operations (get/all) do not mark database as dirty", () => {
      const dbPath = path.join(tmpDir, "readonly.db");
      const db = SqliteDatabase.open(dbPath);
      db.sqlExec("CREATE TABLE t (id INT)");
      db.prepare("INSERT INTO t VALUES (?)").run(1);
      db.persist();

      const writeSpy = vi.spyOn(fs, "writeFileSync");

      // Read operations only
      db.prepare("SELECT * FROM t").get();
      db.prepare("SELECT * FROM t").all();
      db.persist(); // Should be no-op — reads don't dirty

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
      db.close();
    });
  });
});
