import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { Store } from "./store.js";

describe("conversation schema migration", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("一次性导入旧消息、工具事件和 final reply 后移除旧表", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-db-migration-"));
    const path = join(root, "atoms.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE guests (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, guest_id TEXT NOT NULL REFERENCES guests(id), name TEXT NOT NULL,
        preview_capable INTEGER NOT NULL DEFAULT 0, preview_status TEXT NOT NULL DEFAULT 'none',
        preview_url TEXT, thumbnail_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), sequence INTEGER NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, final_reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE timeline_events (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        message_id TEXT NOT NULL REFERENCES messages(id), sequence INTEGER NOT NULL,
        kind TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', exit_code INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
        original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        storage_path TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        project_id TEXT NOT NULL REFERENCES projects(id), guest_id TEXT NOT NULL REFERENCES guests(id),
        result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO guests VALUES ('guest', 'default', 'default', '2026-01-01');
      INSERT INTO projects VALUES (
        'project', 'guest', '旧项目', 0, 'none', NULL, NULL, '2026-01-01', '2026-01-01'
      );
      INSERT INTO messages VALUES (
        'turn', 'project', 1, '创建网页', 'completed', NULL, '已完成网页。',
        '2026-01-01', '2026-01-01', '2026-01-02'
      );
      INSERT INTO timeline_events VALUES (
        'command', 'project', 'turn', 1, 'terminal', '执行命令', 'pwd', '',
        'success', '/project', 0, '2026-01-01', '2026-01-01'
      );
    `);
    legacy.close();

    const db = openDatabase(path);
    const store = new Store(db);
    expect(store.getTurn("turn")?.items.map(({ type }) => type)).toEqual([
      "user_message",
      "command_execution",
      "assistant_message"
    ]);
    expect(store.listAssistantItems("turn")[0]).toMatchObject({
      phase: "final_answer",
      text: "已完成网页。"
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name IN ('messages', 'timeline_events')").all()
    ).toEqual([]);
    db.close();
  });

  it("为现有 conversation_items 增加 todos 快照列", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-db-todos-migration-"));
    const path = join(root, "atoms.sqlite");
    const existing = new Database(path);
    existing.exec(`
      CREATE TABLE conversation_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        phase TEXT,
        status TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '[]',
        action TEXT,
        target TEXT NOT NULL DEFAULT '',
        output TEXT NOT NULL DEFAULT '',
        exit_code INTEGER,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(turn_id, ordinal)
      );
    `);
    existing.close();

    const db = openDatabase(path);
    const columns = db.prepare("PRAGMA table_info(conversation_items)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toContain("todos");
    db.close();
  });
});
