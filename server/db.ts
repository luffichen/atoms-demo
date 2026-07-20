import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id),
  name TEXT NOT NULL,
  preview_capable INTEGER NOT NULL DEFAULT 0,
  preview_status TEXT NOT NULL DEFAULT 'none',
  preview_url TEXT,
  preview_error TEXT,
  thumbnail_url TEXT,
  active_work_item_id TEXT,
  current_code_version_id TEXT,
  next_requirement_sequence INTEGER NOT NULL DEFAULT 1,
  next_code_version_sequence INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_guest_updated
  ON projects(guest_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL,
  requirement_sequence INTEGER,
  title TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  execution_state TEXT NOT NULL DEFAULT 'idle',
  base_commit TEXT NOT NULL DEFAULT '',
  branch_ref TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  published_version_id TEXT,
  UNIQUE(project_id, requirement_sequence)
);
CREATE INDEX IF NOT EXISTS work_items_project_created
  ON work_items(project_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS work_items_one_active
  ON work_items(project_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS code_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sequence INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),
  requirement_sequence INTEGER,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL,
  tag_ref TEXT NOT NULL,
  base_version_id TEXT,
  published_at TEXT NOT NULL,
  UNIQUE(project_id, sequence),
  UNIQUE(project_id, tag_ref)
);
CREATE INDEX IF NOT EXISTS code_versions_project_sequence
  ON code_versions(project_id, sequence DESC);

CREATE TABLE IF NOT EXISTS work_item_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor_guest_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_events_item_created
  ON work_item_events(work_item_id, created_at, id);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  sequence INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(work_item_id, sequence)
);
CREATE INDEX IF NOT EXISTS turns_project_sequence
  ON conversation_turns(project_id, sequence);
CREATE INDEX IF NOT EXISTS turns_project_status
  ON conversation_turns(project_id, status, sequence);

CREATE TABLE IF NOT EXISTS conversation_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
  ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,
  phase TEXT,
  status TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '[]',
  todos TEXT NOT NULL DEFAULT '[]',
  action TEXT,
  target TEXT NOT NULL DEFAULT '',
  previous_path TEXT,
  description TEXT NOT NULL DEFAULT '',
  content_snapshot TEXT,
  output TEXT NOT NULL DEFAULT '',
  output_truncated INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(turn_id, ordinal)
);
CREATE INDEX IF NOT EXISTS items_turn_ordinal
  ON conversation_items(turn_id, ordinal);

CREATE TABLE IF NOT EXISTS item_attachments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES conversation_items(id),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_uploads (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS pending_uploads_guest_created
  ON pending_uploads(guest_id, created_at);

CREATE TABLE IF NOT EXISTS turn_notifications (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE REFERENCES conversation_turns(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  guest_id TEXT NOT NULL REFERENCES guests(id),
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_notifications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES work_item_events(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  guest_id TEXT NOT NULL REFERENCES guests(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  version_id TEXT,
  message TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_notifications_guest_created
  ON workflow_notifications(guest_id, created_at, id);
`;

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column) !== undefined
  );
}

/**
 * One-time import from the pre-item demo schema. Runtime code never reads or
 * writes the legacy tables. Old data cannot recover lost text/tool interleaving,
 * so legacy final text is imported after its tool cards.
 */
function migrateLegacyConversation(db: Database.Database): void {
  if (!tableExists(db, "messages")) return;
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO work_items
        (id, project_id, type, title, workflow_state, execution_state, branch_ref,
         created_at, updated_at)
      SELECT
        'legacy-' || p.id,
        p.id,
        'direct_coding',
        p.name,
        'direct_coding',
        'idle',
        'refs/heads/work/legacy-' || p.id,
        p.created_at,
        p.updated_at
      FROM projects p
      WHERE EXISTS (SELECT 1 FROM messages m WHERE m.project_id = p.id);

      UPDATE projects
      SET active_work_item_id = 'legacy-' || id
      WHERE EXISTS (SELECT 1 FROM messages m WHERE m.project_id = projects.id);

      INSERT OR IGNORE INTO conversation_turns
        (id, project_id, work_item_id, sequence, status, error, created_at, started_at, completed_at)
      SELECT id, project_id, 'legacy-' || project_id, sequence, status, error,
             created_at, started_at, finished_at
      FROM messages;

      INSERT OR IGNORE INTO conversation_items
        (id, project_id, work_item_id, turn_id, ordinal, type, status, text,
         created_at, completed_at)
      SELECT 'user-' || id, project_id, 'legacy-' || project_id, id, 1,
             'user_message', 'completed', text, created_at, created_at
      FROM messages;
    `);

    if (tableExists(db, "timeline_events")) {
      db.exec(`
        INSERT OR IGNORE INTO conversation_items
          (id, project_id, work_item_id, turn_id, ordinal, type, status, action,
           target, output, exit_code, created_at, completed_at)
        SELECT
          e.id,
          e.project_id,
          'legacy-' || e.project_id,
          e.message_id,
          1 + ROW_NUMBER() OVER (PARTITION BY e.message_id ORDER BY e.sequence),
          CASE e.kind
            WHEN 'terminal' THEN 'command_execution'
            WHEN 'file' THEN 'file_change'
            ELSE 'tool_call'
          END,
          CASE e.status
            WHEN 'running' THEN 'in_progress'
            WHEN 'success' THEN 'completed'
            ELSE e.status
          END,
          CASE
            WHEN e.kind = 'file' AND e.action = '新建文件' THEN 'create'
            WHEN e.kind = 'file' THEN 'update'
            ELSE e.action
          END,
          e.target,
          e.output,
          e.exit_code,
          e.created_at,
          CASE WHEN e.status = 'running' THEN NULL ELSE e.updated_at END
        FROM timeline_events e;
      `);
    }

    db.exec(`
      INSERT OR IGNORE INTO conversation_items
        (id, project_id, work_item_id, turn_id, ordinal, type, phase, status,
         text, created_at, completed_at)
      SELECT
        'assistant-' || m.id,
        m.project_id,
        'legacy-' || m.project_id,
        m.id,
        2 + (
          SELECT COUNT(*) FROM conversation_items i
          WHERE i.turn_id = m.id AND i.type <> 'user_message'
        ),
        'assistant_message',
        'final_answer',
        'completed',
        m.final_reply,
        COALESCE(m.finished_at, m.created_at),
        COALESCE(m.finished_at, m.created_at)
      FROM messages m
      WHERE m.final_reply <> '';
    `);

    if (tableExists(db, "attachments")) {
      db.exec(`
        INSERT OR IGNORE INTO item_attachments
          (id, item_id, original_name, mime_type, size, storage_path, created_at)
        SELECT id, 'user-' || message_id, original_name, mime_type, size, storage_path, created_at
        FROM attachments;
      `);
    }
    if (tableExists(db, "notifications")) {
      db.exec(`
        INSERT OR IGNORE INTO turn_notifications
          (id, turn_id, project_id, guest_id, result, created_at)
        SELECT id, message_id, project_id, guest_id, result, created_at
        FROM notifications;
      `);
    }

    db.exec(`
      DROP TABLE IF EXISTS attachments;
      DROP TABLE IF EXISTS timeline_events;
      DROP TABLE IF EXISTS notifications;
      DROP TABLE messages;
    `);
  })();
}

function initialize(db: Database.Database): Database.Database {
  db.exec(SCHEMA);
  if (!columnExists(db, "projects", "active_work_item_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN active_work_item_id TEXT");
  }
  if (!columnExists(db, "projects", "current_code_version_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN current_code_version_id TEXT");
  }
  if (!columnExists(db, "projects", "preview_error")) {
    db.exec("ALTER TABLE projects ADD COLUMN preview_error TEXT");
  }
  if (!columnExists(db, "projects", "next_requirement_sequence")) {
    db.exec("ALTER TABLE projects ADD COLUMN next_requirement_sequence INTEGER NOT NULL DEFAULT 1");
  }
  if (!columnExists(db, "projects", "next_code_version_sequence")) {
    db.exec("ALTER TABLE projects ADD COLUMN next_code_version_sequence INTEGER NOT NULL DEFAULT 1");
  }
  if (!columnExists(db, "conversation_turns", "work_item_id")) {
    db.exec("ALTER TABLE conversation_turns ADD COLUMN work_item_id TEXT NOT NULL DEFAULT ''");
  }
  if (!columnExists(db, "conversation_turns", "priority")) {
    db.exec("ALTER TABLE conversation_turns ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnExists(db, "conversation_items", "work_item_id")) {
    db.exec("ALTER TABLE conversation_items ADD COLUMN work_item_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS turns_work_item_sequence
      ON conversation_turns(work_item_id, sequence);
    CREATE INDEX IF NOT EXISTS items_work_item_ordinal
      ON conversation_items(work_item_id, turn_id, ordinal);
  `);
  if (!columnExists(db, "conversation_items", "todos")) {
    db.exec("ALTER TABLE conversation_items ADD COLUMN todos TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columnExists(db, "conversation_items", "content_snapshot")) {
    db.exec("ALTER TABLE conversation_items ADD COLUMN content_snapshot TEXT");
  }
  if (!columnExists(db, "conversation_items", "description")) {
    db.exec("ALTER TABLE conversation_items ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!columnExists(db, "conversation_items", "output_truncated")) {
    db.exec(
      "ALTER TABLE conversation_items ADD COLUMN output_truncated INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!columnExists(db, "conversation_items", "previous_path")) {
    db.exec("ALTER TABLE conversation_items ADD COLUMN previous_path TEXT");
  }
  migrateLegacyConversation(db);
  return db;
}

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  return initialize(new Database(path));
}

export function openMemoryDatabase(): Database.Database {
  return initialize(new Database(":memory:"));
}
