export interface Guest {
  id: string;
  name: string;
  createdAt: string;
}

export interface Project {
  id: string;
  guestId: string;
  name: string;
  previewCapable: boolean;
  previewStatus: "none" | "starting" | "ready" | "failed" | "stopped";
  previewUrl: string | null;
  previewError: string | null;
  thumbnailUrl: string | null;
  activeWorkItemId?: string | null;
  currentCodeVersionId?: string | null;
  createdAt: string;
  updatedAt: string;
  activeWorkItem?: WorkItem | null;
  currentCodeVersion?: CodeVersion | null;
}

export type WorkItemType = "structured_requirement" | "direct_coding";
export type WorkflowState =
  | "requirements_discussion"
  | "requirements_pending_confirmation"
  | "technical_design"
  | "technical_pending_confirmation"
  | "development"
  | "testing_admission"
  | "testing"
  | "pending_release"
  | "published"
  | "abandoned"
  | "direct_coding";

export interface WorkItem {
  id: string;
  projectId: string;
  type: WorkItemType;
  requirementSequence: number | null;
  title: string;
  workflowState: WorkflowState;
  executionState: "idle" | "running" | "stopped" | "failed";
  baseCommit: string;
  branchRef: string;
  revision: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  publishedVersionId: string | null;
}

export interface WorkItemEvent {
  id: string;
  projectId: string;
  workItemId: string;
  kind: string;
  source: string;
  fromState: WorkflowState | null;
  toState: WorkflowState | null;
  actorGuestId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CodeVersion {
  id: string;
  projectId: string;
  sequence: number;
  sourceType: WorkItemType;
  workItemId: string;
  requirementSequence: number | null;
  title: string;
  summary: string;
  commitSha: string;
  tagRef: string;
  baseVersionId: string | null;
  publishedAt: string;
}

export interface VersionFileChange {
  status: "added" | "modified" | "deleted" | "renamed";
  path: string;
  previousPath?: string;
}

export interface CodeVersionDetails {
  version: CodeVersion;
  workItem: WorkItem;
  baseVersion: CodeVersion | null;
  initiatedGuest: Guest | null;
  confirmedGuest: Guest | null;
  changes: VersionFileChange[];
  fileStats: Record<VersionFileChange["status"], number>;
  documents: {
    requirements: string[];
    technical: string[];
    tests: string[];
    release: string[];
  };
}

export interface ConversationTurn {
  id: string;
  projectId: string;
  workItemId?: string;
  sequence: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  items: ConversationItem[];
}

export interface MessageAttachment {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
}

interface ConversationItemBase {
  id: string;
  projectId: string;
  turnId: string;
  ordinal: number;
  status: "in_progress" | "completed" | "failed" | "cancelled";
  createdAt: string;
  completedAt: string | null;
}

export interface UserMessageItem extends ConversationItemBase {
  type: "user_message";
  status: "completed";
  text: string;
  attachments: MessageAttachment[];
}

export interface AssistantMessageItem extends ConversationItemBase {
  type: "assistant_message";
  phase: "commentary" | "final_answer" | "unknown";
  text: string;
}

export interface ReasoningSummaryItem extends ConversationItemBase {
  type: "reasoning_summary";
  summary: string[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

export interface TodoListItem extends ConversationItemBase {
  type: "todo_list";
  todos: Todo[];
}

export interface CommandExecutionItem extends ConversationItemBase {
  type: "command_execution";
  command: string;
  description: string;
  output: string;
  outputTruncated?: boolean;
  exitCode: number | null;
}

export interface FileChangeItem extends ConversationItemBase {
  type: "file_change";
  action: "create" | "update" | "delete" | "rename" | "move";
  path: string;
  previousPath?: string;
  description: string;
  contentSnapshot: string | null;
  output: string;
  outputTruncated?: boolean;
}

export interface FileCreateEvent {
  turnId: string;
  streamId: string;
  path: string;
  action: "create" | "update";
}

export interface FileAppendEvent {
  turnId: string;
  streamId: string;
  path: string;
  offset: number;
  delta: string;
}

export interface ToolCallItem extends ConversationItemBase {
  type: "tool_call";
  toolName: string;
  target: string;
  description: string;
  output: string;
  outputTruncated?: boolean;
}

export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | ReasoningSummaryItem
  | TodoListItem
  | CommandExecutionItem
  | FileChangeItem
  | ToolCallItem;

export interface Notification {
  id: string;
  turnId: string;
  projectId: string;
  guestId: string;
  projectName: string;
  result: "completed" | "failed" | "cancelled";
  createdAt: string;
  message?: string;
  targetUrl?: string;
  workItemId?: string;
  versionId?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  change?: "new" | "updated";
  children?: FileTreeNode[];
}

export type FileView =
  | { kind: "text"; name: string; path: string; size: number; content: string; language: string }
  | { kind: "image"; name: string; path: string; size: number; mimeType: string; data: string }
  | { kind: "large"; name: string; path: string; size: number; message: string }
  | { kind: "binary"; name: string; path: string; size: number; mimeType: string; message: string };
