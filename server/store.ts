import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  compareGuests,
  MAX_CUSTOM_GUESTS,
  normalizeGuestName,
  validateGuestName
} from "./domain/guest.js";
import type {
  AssistantMessageItem,
  CommandExecutionItem,
  ConversationItem,
  ConversationTurn,
  FileChangeItem,
  Guest,
  MessageAttachment,
  Notification,
  PendingUpload,
  Project,
  WorkItem,
  WorkItemEvent,
  WorkItemType,
  CodeVersion,
  Todo,
  TodoListItem,
  ToolCallItem,
  UserMessageItem
} from "./domain/types.js";

export class StoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "StoreError";
  }
}

type GuestRow = {
  id: string;
  name: string;
  created_at: string;
};

type ProjectRow = {
  id: string;
  guest_id: string;
  name: string;
  preview_capable: number;
  preview_status: Project["previewStatus"];
  preview_url: string | null;
  preview_error: string | null;
  thumbnail_url: string | null;
  active_work_item_id: string | null;
  current_code_version_id: string | null;
  created_at: string;
  updated_at: string;
};

type TurnRow = {
  id: string;
  project_id: string;
  work_item_id: string;
  sequence: number;
  status: ConversationTurn["status"];
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type WorkItemRow = {
  id: string;
  project_id: string;
  type: WorkItemType;
  requirement_sequence: number | null;
  title: string;
  workflow_state: WorkItem["workflowState"];
  execution_state: WorkItem["executionState"];
  base_commit: string;
  branch_ref: string;
  revision: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  published_version_id: string | null;
};

type CodeVersionRow = {
  id: string;
  project_id: string;
  sequence: number;
  source_type: WorkItemType;
  work_item_id: string;
  requirement_sequence: number | null;
  title: string;
  summary: string;
  commit_sha: string;
  tag_ref: string;
  base_version_id: string | null;
  published_at: string;
};

type ItemRow = {
  id: string;
  project_id: string;
  turn_id: string;
  ordinal: number;
  type: ConversationItem["type"];
  phase: AssistantMessageItem["phase"] | null;
  status: ConversationItem["status"];
  text: string;
  summary: string;
  todos: string;
  action: string | null;
  target: string;
  previous_path: string | null;
  description: string;
  content_snapshot: string | null;
  output: string;
  output_truncated: number;
  exit_code: number | null;
  created_at: string;
  completed_at: string | null;
};

type TimelineCursor = {
  sequence: number;
  ordinal: number;
};

function parseTimelineCursor(cursor?: string): TimelineCursor | null {
  if (!cursor) return null;
  const match = /^(\d+):(\d+)$/.exec(cursor);
  if (!match) throw new StoreError("invalid_cursor", "历史消息游标无效");
  const sequence = Number(match[1]);
  const ordinal = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(ordinal)) {
    throw new StoreError("invalid_cursor", "历史消息游标无效");
  }
  return { sequence, ordinal };
}

function now(): string {
  return new Date().toISOString();
}

function guestFromRow(row: GuestRow): Guest {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    guestId: row.guest_id,
    name: row.name,
    previewCapable: Boolean(row.preview_capable),
    previewStatus: row.preview_status,
    previewUrl: row.preview_url,
    previewError: row.preview_error,
    thumbnailUrl: row.thumbnail_url,
    activeWorkItemId: row.active_work_item_id,
    currentCodeVersionId: row.current_code_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function turnFromRow(row: TurnRow, items: ConversationItem[] = []): ConversationTurn {
  return {
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    sequence: row.sequence,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    items
  };
}

function workItemFromRow(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    requirementSequence: row.requirement_sequence,
    title: row.title,
    workflowState: row.workflow_state,
    executionState: row.execution_state,
    baseCommit: row.base_commit,
    branchRef: row.branch_ref,
    revision: row.revision,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    publishedVersionId: row.published_version_id
  };
}

function codeVersionFromRow(row: CodeVersionRow): CodeVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    sourceType: row.source_type,
    workItemId: row.work_item_id,
    requirementSequence: row.requirement_sequence,
    title: row.title,
    summary: row.summary,
    commitSha: row.commit_sha,
    tagRef: row.tag_ref,
    baseVersionId: row.base_version_id,
    publishedAt: row.published_at
  };
}

function itemBase(row: ItemRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function itemFromRow(row: ItemRow, attachments: MessageAttachment[] = []): ConversationItem {
  const base = itemBase(row);
  switch (row.type) {
    case "user_message":
      return { ...base, type: row.type, status: "completed", text: row.text, attachments };
    case "assistant_message":
      return {
        ...base,
        type: row.type,
        phase: row.phase ?? "unknown",
        text: row.text
      } as AssistantMessageItem;
    case "reasoning_summary":
      return {
        ...base,
        type: row.type,
        summary: JSON.parse(row.summary) as string[]
      };
    case "todo_list":
      return {
        ...base,
        type: row.type,
        todos: JSON.parse(row.todos) as Todo[]
      } as TodoListItem;
    case "command_execution":
      return {
        ...base,
        type: row.type,
        command: row.target,
        description: row.description,
        output: row.output,
        outputTruncated: Boolean(row.output_truncated),
        exitCode: row.exit_code
      } as CommandExecutionItem;
    case "file_change":
      return {
        ...base,
        type: row.type,
        action: (row.action ?? "update") as FileChangeItem["action"],
        path: row.target,
        previousPath: row.previous_path ?? undefined,
        description: row.description,
        contentSnapshot: row.content_snapshot,
        output: row.output,
        outputTruncated: Boolean(row.output_truncated)
      } as FileChangeItem;
    case "tool_call":
      return {
        ...base,
        type: row.type,
        toolName: row.action ?? "",
        target: row.target,
        description: row.description,
        output: row.output,
        outputTruncated: Boolean(row.output_truncated)
      } as ToolCallItem;
  }
}

export class Store {
  private readonly notificationListeners = new Set<(notification: Notification) => void>();

  constructor(private readonly db: Database.Database) {
    this.ensureDefaultGuest();
  }

  ensureDefaultGuest(): Guest {
    const existing = this.db
      .prepare("SELECT id, name, created_at FROM guests WHERE normalized_name = ?")
      .get("default") as GuestRow | undefined;
    if (existing) return guestFromRow(existing);
    const guest: Guest = { id: randomUUID(), name: "default", createdAt: now() };
    this.db
      .prepare("INSERT INTO guests (id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)")
      .run(guest.id, guest.name, "default", guest.createdAt);
    return guest;
  }

  onNotification(listener: (notification: Notification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  private emitNotification(notification: Notification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }

  listGuests(): Guest[] {
    const rows = this.db.prepare("SELECT id, name, created_at FROM guests").all() as GuestRow[];
    return rows.map(guestFromRow).sort(compareGuests);
  }

  getGuest(id: string): Guest | null {
    const row = this.db
      .prepare("SELECT id, name, created_at FROM guests WHERE id = ?")
      .get(id) as GuestRow | undefined;
    return row ? guestFromRow(row) : null;
  }

  createGuest(input: string): Guest {
    const validation = validateGuestName(input);
    if (!validation.valid) throw new StoreError(validation.code, validation.message);
    const customCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM guests WHERE normalized_name <> 'default'").get() as {
        count: number;
      }
    ).count;
    if (customCount >= MAX_CUSTOM_GUESTS) {
      throw new StoreError("guest_limit", "游客数量已达上限");
    }
    const normalized = normalizeGuestName(validation.name);
    const timestamp = now();
    const guest: Guest = { id: randomUUID(), name: validation.name, createdAt: timestamp };
    try {
      this.db
        .prepare("INSERT INTO guests (id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)")
        .run(guest.id, guest.name, normalized, timestamp);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new StoreError("guest_exists", "游客名称已存在");
      }
      throw error;
    }
    return guest;
  }

  createProjectWithTurn(
    guestId: string,
    name: string,
    text: string,
    type: WorkItemType = "direct_coding"
  ): {
    project: Project;
    workItem: WorkItem;
    turn: ConversationTurn;
  } {
    if (!this.getGuest(guestId)) throw new StoreError("guest_not_found", "游客不存在", 404);
    return this.db.transaction(() => {
      const timestamp = now();
      const projectId = randomUUID();
      const workItemId = randomUUID();
      const turnId = randomUUID();
      const itemId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO projects
           (id, guest_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(projectId, guestId, name, timestamp, timestamp);
      const requirementSequence = type === "structured_requirement" ? 1 : null;
      this.db
        .prepare(
          `INSERT INTO work_items
           (id, project_id, type, requirement_sequence, title, workflow_state,
            execution_state, branch_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`
        )
        .run(
          workItemId,
          projectId,
          type,
          requirementSequence,
          name,
          type === "structured_requirement" ? "requirements_discussion" : "direct_coding",
          `refs/heads/work/${workItemId}`,
          timestamp,
          timestamp
        );
      this.db
        .prepare(
          `UPDATE projects
           SET active_work_item_id = ?, next_requirement_sequence = ?
           WHERE id = ?`
        )
        .run(workItemId, type === "structured_requirement" ? 2 : 1, projectId);
      this.db
        .prepare(
          `INSERT INTO conversation_turns
           (id, project_id, work_item_id, sequence, status, created_at)
           VALUES (?, ?, ?, 1, 'queued', ?)`
        )
        .run(turnId, projectId, workItemId, timestamp);
      this.db
        .prepare(
          `INSERT INTO conversation_items
           (id, project_id, work_item_id, turn_id, ordinal, type, status, text, created_at, completed_at)
           VALUES (?, ?, ?, ?, 1, 'user_message', 'completed', ?, ?, ?)`
        )
        .run(itemId, projectId, workItemId, turnId, text, timestamp, timestamp);
      return {
        project: this.getProjectForGuest(projectId, guestId)!,
        workItem: this.getWorkItem(workItemId)!,
        turn: this.getTurn(turnId)!
      };
    })();
  }

  getProjectForGuest(projectId: string, guestId: string): Project | null {
    const row = this.db
      .prepare(
        `SELECT id, guest_id, name, preview_capable, preview_status, preview_url, preview_error,
                thumbnail_url, active_work_item_id, current_code_version_id,
                created_at, updated_at
         FROM projects WHERE id = ? AND guest_id = ?`
      )
      .get(projectId, guestId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  getProject(projectId: string): Project | null {
    const row = this.db
      .prepare(
        `SELECT id, guest_id, name, preview_capable, preview_status, preview_url, preview_error,
                thumbnail_url, active_work_item_id, current_code_version_id,
                created_at, updated_at
         FROM projects WHERE id = ?`
      )
      .get(projectId) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as
      | WorkItemRow
      | undefined;
    return row ? workItemFromRow(row) : null;
  }

  getActiveWorkItem(projectId: string): WorkItem | null {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE project_id = ? AND archived_at IS NULL")
      .get(projectId) as WorkItemRow | undefined;
    return row ? workItemFromRow(row) : null;
  }

  listWorkItems(projectId: string, offset = 0, limit = 20): {
    items: WorkItem[];
    hasMore: boolean;
  } {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_items WHERE project_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(projectId, limit + 1, offset) as WorkItemRow[];
    return {
      items: rows.slice(0, limit).map(workItemFromRow),
      hasMore: rows.length > limit
    };
  }

  listWorkItemEvents(workItemId: string): WorkItemEvent[] {
    return (
      this.db
        .prepare(
          `SELECT id, project_id, work_item_id, kind, source, from_state, to_state,
                  actor_guest_id, details_json, created_at
           FROM work_item_events WHERE work_item_id = ?
           ORDER BY created_at, id`
        )
        .all(workItemId) as Array<{
          id: string;
          project_id: string;
          work_item_id: string;
          kind: string;
          source: string;
          from_state: WorkItemEvent["fromState"];
          to_state: WorkItemEvent["toState"];
          actor_guest_id: string | null;
          details_json: string;
          created_at: string;
        }>
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      workItemId: row.work_item_id,
      kind: row.kind,
      source: row.source,
      fromState: row.from_state,
      toState: row.to_state,
      actorGuestId: row.actor_guest_id,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  createWorkItem(
    projectId: string,
    type: WorkItemType,
    title: string,
    baseCommit: string,
    source: "button" | "natural_language" = "button"
  ): WorkItem {
    return this.db.transaction(() => {
      const project = this.getProject(projectId);
      if (!project) throw new StoreError("project_not_found", "项目不可用", 404);
      if (this.getActiveWorkItem(projectId)) {
        throw new StoreError("work_item_active", "请先完成或放弃当前工作", 409);
      }
      const sequence =
        type === "structured_requirement"
          ? (
              this.db
                .prepare("SELECT next_requirement_sequence AS value FROM projects WHERE id = ?")
                .get(projectId) as { value: number }
            ).value
          : null;
      const id = randomUUID();
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO work_items
           (id, project_id, type, requirement_sequence, title, workflow_state,
            execution_state, base_commit, branch_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`
        )
        .run(
          id,
          projectId,
          type,
          sequence,
          title,
          type === "structured_requirement" ? "requirements_discussion" : "direct_coding",
          baseCommit,
          `refs/heads/work/${id}`,
          timestamp,
          timestamp
        );
      this.db
        .prepare(
          `UPDATE projects SET active_work_item_id = ?,
           next_requirement_sequence = next_requirement_sequence + ?
           WHERE id = ?`
        )
        .run(id, type === "structured_requirement" ? 1 : 0, projectId);
      this.addWorkItemEvent(id, "created", source, null, null, project.guestId);
      return this.getWorkItem(id)!;
    })();
  }

  setWorkItemBase(id: string, baseCommit: string): WorkItem {
    this.db
      .prepare(
        `UPDATE work_items SET base_commit = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND archived_at IS NULL`
      )
      .run(baseCommit, now(), id);
    const item = this.getWorkItem(id);
    if (!item) throw new StoreError("work_item_not_found", "工作项不存在", 404);
    return item;
  }

  updateWorkItemTitle(id: string, title: string, revision: number): WorkItem {
    const normalized = title.trim();
    if (!normalized) throw new StoreError("work_item_title_required", "工作标题不能为空");
    if (normalized.length > 100) {
      throw new StoreError("work_item_title_too_long", "工作标题不能超过 100 个字符");
    }
    return this.db.transaction(() => {
      const current = this.getWorkItem(id);
      if (!current || current.archivedAt) {
        throw new StoreError("work_item_not_found", "工作项不存在或已归档", 404);
      }
      if (current.revision !== revision) {
        throw new StoreError("revision_conflict", "工作项已更新，请基于最新状态重试", 409);
      }
      this.db
        .prepare(
          `UPDATE work_items SET title = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND archived_at IS NULL AND revision = ?`
        )
        .run(normalized, now(), id, revision);
      this.addWorkItemEvent(
        id,
        "title_updated",
        "button",
        current.workflowState,
        current.workflowState,
        undefined,
        { previousTitle: current.title, title: normalized }
      );
      return this.getWorkItem(id)!;
    })();
  }

  setWorkItemExecution(
    id: string,
    executionState: WorkItem["executionState"],
    error: string | null = null
  ): WorkItem {
    const previous = this.getWorkItem(id);
    this.db
      .prepare(
        `UPDATE work_items SET execution_state = ?, error = ?,
         revision = revision + 1, updated_at = ? WHERE id = ? AND archived_at IS NULL`
      )
      .run(executionState, error, now(), id);
    const item = this.getWorkItem(id);
    if (!item) throw new StoreError("work_item_not_found", "工作项不存在", 404);
    if (executionState === "failed") {
      this.addWorkItemEvent(
        id,
        "failed",
        "system",
        item.workflowState,
        item.workflowState,
        undefined,
        { error }
      );
    } else if (executionState === "stopped") {
      this.addWorkItemEvent(
        id,
        "stopped",
        "system",
        item.workflowState,
        item.workflowState
      );
    } else if (
      executionState === "idle" &&
      (previous?.executionState === "failed" || previous?.executionState === "stopped")
    ) {
      this.addWorkItemEvent(
        id,
        "retried",
        "button",
        item.workflowState,
        item.workflowState
      );
    }
    return item;
  }

  transitionWorkItem(
    id: string,
    workflowState: WorkItem["workflowState"],
    source: "button" | "natural_language" | "system" = "button",
    actorGuestId?: string,
    details: Record<string, unknown> = {}
  ): WorkItem {
    const current = this.getWorkItem(id);
    if (!current || current.archivedAt) {
      throw new StoreError("work_item_not_found", "工作项不存在", 404);
    }
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE work_items SET workflow_state = ?, execution_state = 'idle', error = NULL,
         revision = revision + 1, updated_at = ? WHERE id = ?`
      )
      .run(workflowState, timestamp, id);
    this.addWorkItemEvent(
      id,
      "transition",
      source,
      current.workflowState,
      workflowState,
      actorGuestId,
      details
    );
    return this.getWorkItem(id)!;
  }

  archiveWorkItem(
    id: string,
    state: "abandoned" | "published",
    source: "button" | "natural_language" | "system" = "button",
    actorGuestId?: string,
    details: Record<string, unknown> = {}
  ): WorkItem {
    return this.db.transaction(() => {
      const item = this.getWorkItem(id);
      if (!item || item.archivedAt) {
        throw new StoreError("work_item_not_found", "工作项不存在", 404);
      }
      const timestamp = now();
      this.db
        .prepare(
          `UPDATE work_items SET workflow_state = ?, execution_state = 'idle',
           archived_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
        )
        .run(state, timestamp, timestamp, id);
      this.db
        .prepare(
          "UPDATE projects SET active_work_item_id = NULL, updated_at = ? WHERE id = ?"
        )
        .run(timestamp, item.projectId);
      this.addWorkItemEvent(
        id,
        state,
        source,
        item.workflowState,
        state,
        actorGuestId,
        details
      );
      return this.getWorkItem(id)!;
    })();
  }

  addWorkItemEvent(
    workItemId: string,
    kind: string,
    source: string,
    fromState: string | null,
    toState: string | null,
    actorGuestId?: string,
    details: Record<string, unknown> = {},
    idempotencyKey?: string
  ): void {
    const item = this.getWorkItem(workItemId);
    if (!item) throw new StoreError("work_item_not_found", "工作项不存在", 404);
    const eventId = randomUUID();
    const createdAt = now();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO work_item_events
         (id, project_id, work_item_id, kind, source, from_state, to_state,
          actor_guest_id, details_json, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        item.projectId,
        item.id,
        kind,
        source,
        fromState,
        toState,
        actorGuestId ?? null,
        JSON.stringify(details),
        idempotencyKey ?? null,
        createdAt
      );
    if (!inserted.changes) return;
    const notificationMessage =
      kind === "published"
        ? "版本发布成功"
        : kind === "failed" || kind === "publish_failed"
          ? "开发、测试或发布失败"
          : toState === "requirements_pending_confirmation"
            ? "需求文档等待确认"
            : toState === "technical_pending_confirmation"
              ? "技术方案等待确认"
              : toState === "testing_admission"
                ? "开发完成，等待测试准入"
                : toState === "pending_release"
                  ? "测试通过，等待上线"
                  : null;
    if (!notificationMessage) return;
    const project = this.getProject(item.projectId);
    if (!project) return;
    const versionId = typeof details.versionId === "string" ? details.versionId : undefined;
    const targetUrl = versionId
      ? `/projects/${project.id}?viewer=versions&section=versions&version=${encodeURIComponent(versionId)}`
      : `/projects/${project.id}?viewer=versions&section=current&workItem=${encodeURIComponent(item.id)}`;
    const notificationId = randomUUID();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_notifications
         (id, event_id, project_id, guest_id, work_item_id, version_id,
          message, target_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        notificationId,
        eventId,
        project.id,
        project.guestId,
        item.id,
        versionId ?? null,
        notificationMessage,
        targetUrl,
        createdAt
      );
    this.emitNotification({
      id: notificationId,
      turnId: `workflow:${eventId}`,
      projectId: project.id,
      guestId: project.guestId,
      projectName: project.name,
      result: kind === "failed" || kind === "publish_failed" ? "failed" : "completed",
      createdAt,
      message: notificationMessage,
      targetUrl,
      workItemId: item.id,
      versionId
    });
  }

  reserveWorkflowAction(input: {
    workItemId: string;
    action: string;
    revision: number;
    idempotencyKey: string;
    source: "button" | "natural_language";
    actorGuestId: string;
  }): WorkItem {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT 1 FROM work_item_events WHERE idempotency_key = ?")
        .get(input.idempotencyKey);
      if (existing) {
        throw new StoreError(
          "action_already_processed",
          "该确认操作已经处理，请勿重复提交",
          409
        );
      }
      const item = this.getWorkItem(input.workItemId);
      if (!item || item.archivedAt) {
        throw new StoreError("work_item_not_found", "工作项不存在", 404);
      }
      if (item.revision !== input.revision) {
        throw new StoreError("revision_conflict", "工作项已更新，请基于最新状态重试", 409);
      }
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO work_item_events
           (id, project_id, work_item_id, kind, source, from_state, to_state,
            actor_guest_id, details_json, idempotency_key, created_at)
           VALUES (?, ?, ?, 'action_reserved', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          item.projectId,
          item.id,
          input.source,
          item.workflowState,
          item.workflowState,
          input.actorGuestId,
          JSON.stringify({ action: input.action, revision: input.revision }),
          input.idempotencyKey,
          now()
        );
      if (!result.changes) {
        throw new StoreError(
          "action_already_processed",
          "该确认操作已经处理，请勿重复提交",
          409
        );
      }
      this.db
        .prepare(
          `UPDATE work_items
           SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND archived_at IS NULL AND revision = ?`
        )
        .run(now(), item.id, input.revision);
      return this.getWorkItem(item.id)!;
    })();
  }

  hasWorkflowActionKey(idempotencyKey: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM work_item_events WHERE idempotency_key = ?")
        .get(idempotencyKey)
    );
  }

  listCodeVersions(projectId: string, offset = 0, limit = 20): {
    items: CodeVersion[];
    hasMore: boolean;
  } {
    const rows = this.db
      .prepare(
        `SELECT * FROM code_versions WHERE project_id = ?
         ORDER BY sequence DESC LIMIT ? OFFSET ?`
      )
      .all(projectId, limit + 1, offset) as CodeVersionRow[];
    return {
      items: rows.slice(0, limit).map(codeVersionFromRow),
      hasMore: rows.length > limit
    };
  }

  getCodeVersion(id: string): CodeVersion | null {
    const row = this.db.prepare("SELECT * FROM code_versions WHERE id = ?").get(id) as
      | CodeVersionRow
      | undefined;
    return row ? codeVersionFromRow(row) : null;
  }

  nextCodeVersionSequence(projectId: string): number {
    const row = this.db
      .prepare("SELECT next_code_version_sequence AS value FROM projects WHERE id = ?")
      .get(projectId) as { value: number } | undefined;
    if (!row) throw new StoreError("project_not_found", "项目不可用", 404);
    return row.value;
  }

  publishCodeVersion(input: {
    workItemId: string;
    title: string;
    summary: string;
    commitSha: string;
    tagRef: string;
  }): CodeVersion {
    return this.db.transaction(() => {
      const item = this.getWorkItem(input.workItemId);
      if (!item || item.archivedAt) {
        throw new StoreError("work_item_not_found", "工作项不存在", 404);
      }
      const project = this.getProject(item.projectId)!;
      const sequence = (
        this.db
          .prepare("SELECT next_code_version_sequence AS value FROM projects WHERE id = ?")
          .get(project.id) as { value: number }
      ).value;
      const id = randomUUID();
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO code_versions
           (id, project_id, sequence, source_type, work_item_id, requirement_sequence,
            title, summary, commit_sha, tag_ref, base_version_id, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          project.id,
          sequence,
          item.type,
          item.id,
          item.requirementSequence,
          input.title,
          input.summary,
          input.commitSha,
          input.tagRef,
          project.currentCodeVersionId,
          timestamp
        );
      this.db
        .prepare(
          `UPDATE work_items SET workflow_state = 'published', execution_state = 'idle',
           error = NULL, published_version_id = ?, archived_at = ?, updated_at = ?,
           revision = revision + 1
           WHERE id = ?`
        )
        .run(id, timestamp, timestamp, item.id);
      this.db
        .prepare(
          `UPDATE projects SET active_work_item_id = NULL, current_code_version_id = ?,
           next_code_version_sequence = next_code_version_sequence + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(id, timestamp, project.id);
      this.addWorkItemEvent(
        item.id,
        "published",
        "button",
        item.workflowState,
        "published",
        project.guestId,
        { versionId: id, sequence }
      );
      return this.getCodeVersion(id)!;
    })();
  }

  updatePreview(
    projectId: string,
    values: {
      previewCapable: boolean;
      previewStatus: Project["previewStatus"];
      previewUrl?: string | null;
      previewError?: string | null;
      thumbnailUrl?: string | null;
    }
  ): Project {
    this.db
      .prepare(
        `UPDATE projects
         SET preview_capable = ?, preview_status = ?, preview_url = ?, preview_error = ?,
             thumbnail_url = COALESCE(?, thumbnail_url)
         WHERE id = ?`
      )
      .run(
        values.previewCapable ? 1 : 0,
        values.previewStatus,
        values.previewUrl ?? null,
        values.previewError ?? null,
        values.thumbnailUrl ?? null,
        projectId
      );
    const project = this.getProject(projectId);
    if (!project) throw new StoreError("project_not_found", "项目不可用", 404);
    return project;
  }

  updateThumbnail(projectId: string, thumbnailUrl: string): Project {
    this.db
      .prepare("UPDATE projects SET thumbnail_url = ? WHERE id = ?")
      .run(thumbnailUrl, projectId);
    const project = this.getProject(projectId);
    if (!project) throw new StoreError("project_not_found", "项目不可用", 404);
    return project;
  }

  listProjects(guestId: string, offset = 0, limit = 20): {
    items: Project[];
    hasMore: boolean;
  } {
    const rows = this.db
      .prepare(
        `SELECT id, guest_id, name, preview_capable, preview_status, preview_url, preview_error,
                thumbnail_url, active_work_item_id, current_code_version_id,
                created_at, updated_at
         FROM projects
         WHERE guest_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(guestId, limit + 1, offset) as ProjectRow[];
    return {
      items: rows.slice(0, limit).map(projectFromRow),
      hasMore: rows.length > limit
    };
  }

  enqueueTurn(
    projectId: string,
    text: string,
    options: { priority?: number; bypassQueueLimit?: boolean } = {}
  ): ConversationTurn {
    return this.db.transaction(() => {
      const workItem = this.getActiveWorkItem(projectId);
      if (!workItem) throw new StoreError("work_item_required", "请先开始一项新工作", 409);
      const queued = (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE work_item_id = ? AND status = 'queued'")
          .get(workItem.id) as { count: number }
      ).count;
      if (queued >= 10 && !options.bypassQueueLimit) {
        throw new StoreError("queue_full", "队列已满", 409);
      }
      if (!this.getProject(projectId)) throw new StoreError("project_not_found", "项目不可用", 404);
      const sequence = (
        this.db
          .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM conversation_turns WHERE work_item_id = ?")
          .get(workItem.id) as { sequence: number }
      ).sequence;
      const timestamp = now();
      const id = randomUUID();
      const itemId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO conversation_turns
           (id, project_id, work_item_id, sequence, priority, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?)`
        )
        .run(id, projectId, workItem.id, sequence, options.priority ?? 0, timestamp);
      this.db
        .prepare(
          `INSERT INTO conversation_items
           (id, project_id, work_item_id, turn_id, ordinal, type, status, text, created_at, completed_at)
           VALUES (?, ?, ?, ?, 1, 'user_message', 'completed', ?, ?, ?)`
        )
        .run(itemId, projectId, workItem.id, id, text, timestamp, timestamp);
      this.touchProject(projectId, timestamp);
      return this.getTurn(id)!;
    })();
  }

  getTurn(turnId: string): ConversationTurn | null {
    const row = this.db.prepare("SELECT * FROM conversation_turns WHERE id = ?").get(turnId) as
      | TurnRow
      | undefined;
    return row ? turnFromRow(row, this.listItems(row.id)) : null;
  }

  listTurns(
    projectId: string,
    beforeSequence?: number,
    limit = 50,
    workItemId?: string
  ): {
    items: ConversationTurn[];
    hasMore: boolean;
  } {
    const selectedWorkItemId =
      workItemId ??
      this.getActiveWorkItem(projectId)?.id ??
      this.listWorkItems(projectId, 0, 1).items[0]?.id;
    if (!selectedWorkItemId) return { items: [], hasMore: false };
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_turns
         WHERE project_id = ? AND work_item_id = ? AND sequence < ?
         ORDER BY sequence DESC LIMIT ?`
      )
      .all(
        projectId,
        selectedWorkItemId,
        beforeSequence ?? Number.MAX_SAFE_INTEGER,
        limit + 1
      ) as TurnRow[];
    return {
      items: rows.slice(0, limit).reverse().map((row) => turnFromRow(row, this.listItems(row.id))),
      hasMore: rows.length > limit
    };
  }

  listTimelineTurns(
    projectId: string,
    beforeCursor?: string,
    limit = 50,
    workItemId?: string
  ): {
    items: ConversationTurn[];
    hasMore: boolean;
    nextCursor: string | null;
  } {
    const selectedWorkItemId =
      workItemId ??
      this.getActiveWorkItem(projectId)?.id ??
      this.listWorkItems(projectId, 0, 1).items[0]?.id;
    if (!selectedWorkItemId) return { items: [], hasMore: false, nextCursor: null };
    const cursor = parseTimelineCursor(beforeCursor);
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT i.id, i.turn_id, i.ordinal, t.sequence
         FROM conversation_items i
         JOIN conversation_turns t ON t.id = i.turn_id
         WHERE t.project_id = ? AND t.work_item_id = ?
           AND (? IS NULL OR t.sequence < ? OR (t.sequence = ? AND i.ordinal < ?))
         ORDER BY t.sequence DESC, i.ordinal DESC
         LIMIT ?`
      )
      .all(
        projectId,
        selectedWorkItemId,
        cursor?.sequence ?? null,
        cursor?.sequence ?? 0,
        cursor?.sequence ?? 0,
        cursor?.ordinal ?? 0,
        boundedLimit + 1
      ) as Array<{ id: string; turn_id: string; ordinal: number; sequence: number }>;
    const selected = rows.slice(0, boundedLimit);
    const selectedItemIds = new Set(selected.map(({ id }) => id));
    const turnIds = [...new Set(selected.map(({ turn_id }) => turn_id))];
    const items = turnIds
      .map((turnId) => this.getTurn(turnId))
      .filter((turn): turn is ConversationTurn => turn !== null)
      .map((turn) => ({
        ...turn,
        items: turn.items.filter((item) => selectedItemIds.has(item.id))
      }))
      .sort((left, right) => left.sequence - right.sequence);
    const oldest = selected.at(-1);
    return {
      items,
      hasMore: rows.length > boundedLimit,
      nextCursor: oldest ? `${oldest.sequence}:${oldest.ordinal}` : null
    };
  }

  claimNextTurn(projectId: string): ConversationTurn | null {
    return this.db.transaction(() => {
      const workItem = this.getActiveWorkItem(projectId);
      if (!workItem) return null;
      const running = this.db
        .prepare("SELECT id FROM conversation_turns WHERE work_item_id = ? AND status = 'running' LIMIT 1")
        .get(workItem.id);
      if (running) return null;
      const row = this.db
        .prepare(
          `SELECT id FROM conversation_turns
           WHERE work_item_id = ? AND status = 'queued'
           ORDER BY priority DESC, sequence LIMIT 1`
        )
        .get(workItem.id) as { id: string } | undefined;
      if (!row) return null;
      const timestamp = now();
      this.db
        .prepare("UPDATE conversation_turns SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .run(timestamp, row.id);
      this.setWorkItemExecution(workItem.id, "running");
      return this.getTurn(row.id);
    })();
  }

  peekNextQueuedTurn(workItemId: string): ConversationTurn | null {
    const row = this.db
      .prepare(
        `SELECT id FROM conversation_turns
         WHERE work_item_id = ? AND status = 'queued'
         ORDER BY priority DESC, sequence LIMIT 1`
      )
      .get(workItemId) as { id: string } | undefined;
    return row ? this.getTurn(row.id) : null;
  }

  cancelQueuedTurn(turnId: string): ConversationTurn {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE conversation_turns SET status = 'cancelled', completed_at = ?
         WHERE id = ? AND status = 'queued'`
      )
      .run(timestamp, turnId);
    if (!result.changes) throw new StoreError("turn_not_queued", "任务已不在队列中", 409);
    const turn = this.getTurn(turnId)!;
    this.setWorkItemExecution(turn.workItemId, "idle");
    this.touchProject(turn.projectId, timestamp);
    return turn;
  }

  finishTurn(
    turnId: string,
    status: "completed" | "failed" | "cancelled",
    options: { error?: string } = {}
  ): ConversationTurn {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE conversation_turns
         SET status = ?, error = ?, completed_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(status, options.error ?? null, timestamp, turnId);
    if (!result.changes) throw new StoreError("turn_not_running", "任务已不在执行中", 409);
    const turn = this.getTurn(turnId)!;
    this.setWorkItemExecution(
      turn.workItemId,
      status === "failed" ? "failed" : status === "cancelled" ? "stopped" : "idle",
      options.error ?? null
    );
    this.touchProject(turn.projectId, timestamp);
    return turn;
  }

  recoverInterruptedTurns(): ConversationTurn[] {
    const interrupted = this.db
      .prepare("SELECT id FROM conversation_turns WHERE status = 'running' ORDER BY project_id, sequence")
      .all() as Array<{ id: string }>;
    return interrupted.map(({ id }) =>
      this.finishTurn(id, "failed", { error: "服务重启导致中断" })
    );
  }

  listRunnableProjectIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT project_id
         FROM conversation_turns
         WHERE status = 'queued'
         ORDER BY project_id`
      )
      .all() as Array<{ project_id: string }>;
    return rows.map((row) => row.project_id);
  }

  hasOpenTurns(workItemId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM conversation_turns
           WHERE work_item_id = ? AND status IN ('queued', 'running') LIMIT 1`
        )
        .get(workItemId)
    );
  }

  addAttachments(
    turnId: string,
    attachments: Array<MessageAttachment & { storagePath: string }>
  ): ConversationTurn {
    const userItem = this.getUserMessageItem(turnId);
    if (!userItem) throw new StoreError("turn_not_found", "任务不存在", 404);
    this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO item_attachments
         (id, item_id, original_name, mime_type, size, storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const timestamp = now();
      for (const attachment of attachments) {
        insert.run(
          attachment.id,
          userItem.id,
          attachment.originalName,
          attachment.mimeType,
          attachment.size,
          attachment.storagePath,
          timestamp
        );
      }
    })();
    return this.getTurn(turnId)!;
  }

  createPendingUpload(input: {
    id: string;
    guestId: string;
    originalName: string;
    mimeType: string;
    size: number;
    storagePath: string;
  }): PendingUpload {
    if (!this.getGuest(input.guestId)) {
      throw new StoreError("guest_not_found", "游客不存在", 404);
    }
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO pending_uploads
         (id, guest_id, original_name, mime_type, size, storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.guestId,
        input.originalName,
        input.mimeType,
        input.size,
        input.storagePath,
        createdAt
      );
    return { ...input, createdAt, consumedAt: null };
  }

  getPendingUploads(guestId: string, ids: string[]): PendingUpload[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, guest_id, original_name, mime_type, size, storage_path,
                created_at, consumed_at
         FROM pending_uploads
         WHERE guest_id = ? AND consumed_at IS NULL AND id IN (${placeholders})`
      )
      .all(guestId, ...ids) as Array<{
        id: string;
        guest_id: string;
        original_name: string;
        mime_type: string;
        size: number;
        storage_path: string;
        created_at: string;
        consumed_at: string | null;
      }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [{
            id: row.id,
            guestId: row.guest_id,
            originalName: row.original_name,
            mimeType: row.mime_type,
            size: row.size,
            storagePath: row.storage_path,
            createdAt: row.created_at,
            consumedAt: row.consumed_at
          }]
        : [];
    });
  }

  consumePendingUploads(ids: string[]): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE pending_uploads SET consumed_at = ? WHERE id IN (${placeholders})`)
      .run(now(), ...ids);
  }

  deletePendingUpload(guestId: string, id: string): PendingUpload {
    return this.db.transaction(() => {
      const uploads = this.getPendingUploads(guestId, [id]);
      const upload = uploads[0];
      if (!upload) {
        throw new StoreError("upload_unavailable", "图片已发送、删除或失效", 404);
      }
      this.db
        .prepare(
          "DELETE FROM pending_uploads WHERE id = ? AND guest_id = ? AND consumed_at IS NULL"
        )
        .run(id, guestId);
      return upload;
    })();
  }

  deleteExpiredPendingUploads(cutoff: string): PendingUpload[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, guest_id, original_name, mime_type, size, storage_path,
                  created_at, consumed_at
           FROM pending_uploads
           WHERE consumed_at IS NULL AND created_at < ?
           ORDER BY created_at, id`
        )
        .all(cutoff) as Array<{
          id: string;
          guest_id: string;
          original_name: string;
          mime_type: string;
          size: number;
          storage_path: string;
          created_at: string;
          consumed_at: string | null;
        }>;
      if (rows.length) {
        const placeholders = rows.map(() => "?").join(",");
        this.db
          .prepare(`DELETE FROM pending_uploads WHERE id IN (${placeholders})`)
          .run(...rows.map(({ id }) => id));
      }
      return rows.map((row) => ({
        id: row.id,
        guestId: row.guest_id,
        originalName: row.original_name,
        mimeType: row.mime_type,
        size: row.size,
        storagePath: row.storage_path,
        createdAt: row.created_at,
        consumedAt: row.consumed_at
      }));
    })();
  }

  listAttachments(itemId: string): MessageAttachment[] {
    const rows = this.db
      .prepare(
        `SELECT id, original_name, mime_type, size
         FROM item_attachments WHERE item_id = ? ORDER BY created_at, id`
      )
      .all(itemId) as Array<{
        id: string;
        original_name: string;
        mime_type: string;
        size: number;
      }>;
    return rows.map((row) => ({
      id: row.id,
      originalName: row.original_name,
      mimeType: row.mime_type,
      size: row.size
    }));
  }

  getAttachmentPath(turnId: string, itemId: string, attachmentId: string): {
    path: string;
    mimeType: string;
    originalName: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT storage_path, mime_type, original_name
         FROM item_attachments a
         JOIN conversation_items i ON i.id = a.item_id
         WHERE a.id = ? AND a.item_id = ? AND i.turn_id = ? AND i.type = 'user_message'`
      )
      .get(attachmentId, itemId, turnId) as
      | { storage_path: string; mime_type: string; original_name: string }
      | undefined;
    return row
      ? { path: row.storage_path, mimeType: row.mime_type, originalName: row.original_name }
      : null;
  }

  listAttachmentFiles(turnId: string): Array<{
    path: string;
    mimeType: "image/png" | "image/jpeg";
  }> {
    return this.db
      .prepare(
        `SELECT storage_path AS path, mime_type AS mimeType
         FROM item_attachments a
         JOIN conversation_items i ON i.id = a.item_id
         WHERE i.turn_id = ? AND i.type = 'user_message'
         ORDER BY a.created_at, a.id`
      )
      .all(turnId) as Array<{ path: string; mimeType: "image/png" | "image/jpeg" }>;
  }

  createNotification(turnId: string): Notification {
    const turn = this.getTurn(turnId);
    if (!turn || !["completed", "failed", "cancelled"].includes(turn.status)) {
      throw new StoreError("turn_not_terminal", "任务尚未结束", 409);
    }
    const project = this.getProject(turn.projectId);
    if (!project) throw new StoreError("project_not_found", "项目不可用", 404);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO turn_notifications
         (id, turn_id, project_id, guest_id, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), turn.id, project.id, project.guestId, turn.status, now());
    const row = this.db
      .prepare(
        `SELECT n.id, n.turn_id, n.project_id, n.guest_id, n.result, n.created_at,
                p.name AS project_name
         FROM turn_notifications n JOIN projects p ON p.id = n.project_id
         WHERE n.turn_id = ?`
      )
      .get(turn.id) as {
        id: string;
        turn_id: string;
        project_id: string;
        guest_id: string;
        project_name: string;
        result: Notification["result"];
        created_at: string;
      };
    const notification = {
      id: row.id,
      turnId: row.turn_id,
      projectId: row.project_id,
      guestId: row.guest_id,
      projectName: row.project_name,
      result: row.result,
      createdAt: row.created_at
    };
    return notification;
  }

  listNotifications(guestId: string, limit = 50): Notification[] {
    const rows = this.db
      .prepare(
        `SELECT n.id, n.turn_id, n.project_id, n.guest_id, n.result, n.created_at,
                p.name AS project_name
         FROM turn_notifications n JOIN projects p ON p.id = n.project_id
         WHERE n.guest_id = ?
         ORDER BY n.created_at DESC LIMIT ?`
      )
      .all(guestId, limit) as Array<{
        id: string;
        turn_id: string;
        project_id: string;
        guest_id: string;
        project_name: string;
        result: Notification["result"];
        created_at: string;
      }>;
    const turnNotifications = rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      projectId: row.project_id,
      guestId: row.guest_id,
      projectName: row.project_name,
      result: row.result,
      createdAt: row.created_at
    }));
    const workflowRows = this.db
      .prepare(
        `SELECT n.id, n.event_id, n.project_id, n.guest_id, n.work_item_id,
                n.version_id, n.message, n.target_url, n.created_at,
                p.name AS project_name
         FROM workflow_notifications n JOIN projects p ON p.id = n.project_id
         WHERE n.guest_id = ?
         ORDER BY n.created_at DESC LIMIT ?`
      )
      .all(guestId, limit) as Array<{
        id: string;
        event_id: string;
        project_id: string;
        guest_id: string;
        work_item_id: string;
        version_id: string | null;
        message: string;
        target_url: string;
        created_at: string;
        project_name: string;
      }>;
    return [
      ...turnNotifications,
      ...workflowRows.map((row) => ({
        id: row.id,
        turnId: `workflow:${row.event_id}`,
        projectId: row.project_id,
        guestId: row.guest_id,
        projectName: row.project_name,
        result: row.message.includes("失败") ? "failed" as const : "completed" as const,
        createdAt: row.created_at,
        message: row.message,
        targetUrl: row.target_url,
        workItemId: row.work_item_id,
        versionId: row.version_id ?? undefined
      }))
    ]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  deleteProject(projectId: string): void {
    this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM item_attachments WHERE item_id IN
         (SELECT id FROM conversation_items WHERE project_id = ?)`
      ).run(projectId);
      this.db.prepare("DELETE FROM conversation_items WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM turn_notifications WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM conversation_turns WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM work_item_events WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM code_versions WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM work_items WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    })();
  }

  deleteQueuedTurn(turnId: string): void {
    this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM item_attachments WHERE item_id IN
         (SELECT id FROM conversation_items WHERE turn_id = ?)`
      ).run(turnId);
      this.db.prepare("DELETE FROM conversation_items WHERE turn_id = ?").run(turnId);
      this.db.prepare("DELETE FROM conversation_turns WHERE id = ? AND status = 'queued'").run(turnId);
    })();
  }

  nextItemOrdinal(turnId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM conversation_items WHERE turn_id = ?"
        )
        .get(turnId) as { ordinal: number }
    ).ordinal;
  }

  getItem(id: string): ConversationItem | null {
    const row = this.db.prepare("SELECT * FROM conversation_items WHERE id = ?").get(id) as
      | ItemRow
      | undefined;
    return row
      ? itemFromRow(row, row.type === "user_message" ? this.listAttachments(row.id) : [])
      : null;
  }

  listItems(turnId: string): ConversationItem[] {
    const rows = this.db
      .prepare("SELECT * FROM conversation_items WHERE turn_id = ? ORDER BY ordinal")
      .all(turnId) as ItemRow[];
    return rows.map((row) =>
      itemFromRow(row, row.type === "user_message" ? this.listAttachments(row.id) : [])
    );
  }

  getUserMessageItem(turnId: string): UserMessageItem | null {
    const item = this.listItems(turnId).find(
      (candidate): candidate is UserMessageItem => candidate.type === "user_message"
    );
    return item ?? null;
  }

  createAssistantItem(
    projectId: string,
    turnId: string,
    phase: AssistantMessageItem["phase"] = "unknown"
  ): AssistantMessageItem {
    const turn = this.getTurn(turnId);
    if (!turn) throw new StoreError("turn_not_found", "任务不存在", 404);
    const timestamp = now();
    const id = randomUUID();
    const ordinal = this.nextItemOrdinal(turnId);
    this.db
      .prepare(
        `INSERT INTO conversation_items
         (id, project_id, work_item_id, turn_id, ordinal, type, phase, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'assistant_message', ?, 'in_progress', ?)`
      )
      .run(id, projectId, turn.workItemId, turnId, ordinal, phase, timestamp);
    return this.getItem(id) as AssistantMessageItem;
  }

  createActionItem(input: {
    projectId: string;
    turnId: string;
    type: "command_execution" | "file_change" | "tool_call" | "todo_list";
    action?: string;
    target: string;
    previousPath?: string;
    description?: string;
    todos?: Todo[];
    contentSnapshot?: string | null;
  }): CommandExecutionItem | FileChangeItem | ToolCallItem | TodoListItem {
    const turn = this.getTurn(input.turnId);
    if (!turn) throw new StoreError("turn_not_found", "任务不存在", 404);
    const timestamp = now();
    const id = randomUUID();
    const ordinal = this.nextItemOrdinal(input.turnId);
    this.db
      .prepare(
        `INSERT INTO conversation_items
         (id, project_id, work_item_id, turn_id, ordinal, type, status, action, target, previous_path, description, content_snapshot, todos, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        turn.workItemId,
        input.turnId,
        ordinal,
        input.type,
        input.action ?? null,
        input.target,
        input.previousPath ?? null,
        input.description ?? "",
        input.contentSnapshot ?? null,
        JSON.stringify(input.todos ?? []),
        timestamp
      );
    return this.getItem(id) as CommandExecutionItem | FileChangeItem | ToolCallItem | TodoListItem;
  }

  appendAssistantText(id: string, delta: string): AssistantMessageItem {
    this.db
      .prepare(
        `UPDATE conversation_items SET text = text || ?
         WHERE id = ? AND type = 'assistant_message' AND status = 'in_progress'`
      )
      .run(delta, id);
    const item = this.getItem(id);
    if (!item || item.type !== "assistant_message") {
      throw new StoreError("item_not_found", "对话内容不存在", 404);
    }
    return item;
  }

  completeAssistantItem(id: string, text?: string): AssistantMessageItem {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE conversation_items
         SET text = COALESCE(?, text), status = 'completed', completed_at = ?
         WHERE id = ? AND type = 'assistant_message' AND status = 'in_progress'`
      )
      .run(text ?? null, timestamp, id);
    const item = this.getItem(id);
    if (!item || item.type !== "assistant_message") {
      throw new StoreError("item_not_found", "对话内容不存在", 404);
    }
    if (!result.changes && item.status === "in_progress") {
      throw new StoreError("item_update_failed", "对话内容更新失败", 409);
    }
    return item;
  }

  replaceItemOutput(
    id: string,
    output: string,
    maxBytes = 5 * 1024 * 1024
  ): CommandExecutionItem | FileChangeItem | ToolCallItem {
    const current = this.getItem(id);
    if (
      !current ||
      !["command_execution", "file_change", "tool_call"].includes(current.type)
    ) {
      throw new StoreError("item_not_found", "对话内容不存在", 404);
    }
    const raw = Buffer.from(output);
    const outputTruncated = raw.length > maxBytes;
    const snapshot = raw.subarray(0, maxBytes).toString();
    this.db
      .prepare(
        "UPDATE conversation_items SET output = ?, output_truncated = ? WHERE id = ?"
      )
      .run(snapshot, outputTruncated ? 1 : 0, id);
    return this.getItem(id) as CommandExecutionItem | FileChangeItem | ToolCallItem;
  }

  finishItem(
    id: string,
    status: "completed" | "failed" | "cancelled",
    exitCode: number | null = null
  ): ConversationItem {
    const result = this.db
      .prepare(
        `UPDATE conversation_items
         SET status = ?, exit_code = ?, completed_at = ?
         WHERE id = ? AND status = 'in_progress'`
      )
      .run(status, exitCode, now(), id);
    if (!result.changes) {
      const existing = this.getItem(id);
      if (existing) return existing;
      throw new StoreError("item_not_found", "对话内容不存在", 404);
    }
    return this.getItem(id)!;
  }

  setAssistantPhase(
    id: string,
    phase: "commentary" | "final_answer"
  ): AssistantMessageItem {
    this.db
      .prepare(
        "UPDATE conversation_items SET phase = ? WHERE id = ? AND type = 'assistant_message'"
      )
      .run(phase, id);
    const item = this.getItem(id);
    if (!item || item.type !== "assistant_message") {
      throw new StoreError("item_not_found", "对话内容不存在", 404);
    }
    return item;
  }

  listAssistantItems(turnId: string): AssistantMessageItem[] {
    return this.listItems(turnId).filter(
      (item): item is AssistantMessageItem => item.type === "assistant_message"
    );
  }

  private touchProject(projectId: string, timestamp = now()): void {
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
  }
}
