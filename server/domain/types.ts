export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ItemStatus = "in_progress" | "completed" | "failed" | "cancelled";
export type PreviewStatus = "none" | "starting" | "ready" | "failed" | "stopped";
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
export type WorkExecutionState = "idle" | "running" | "stopped" | "failed";

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
  previewStatus: PreviewStatus;
  previewUrl: string | null;
  previewError: string | null;
  thumbnailUrl: string | null;
  activeWorkItemId: string | null;
  currentCodeVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  type: WorkItemType;
  requirementSequence: number | null;
  title: string;
  workflowState: WorkflowState;
  executionState: WorkExecutionState;
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

export interface PendingUpload {
  id: string;
  guestId: string;
  originalName: string;
  mimeType: string;
  size: number;
  storagePath: string;
  createdAt: string;
  consumedAt: string | null;
}

export interface ConversationTurn {
  id: string;
  projectId: string;
  workItemId: string;
  sequence: number;
  status: TurnStatus;
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
  status: ItemStatus;
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
