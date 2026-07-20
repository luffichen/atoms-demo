import {
  AppWindow,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileCode2,
  GitBranch,
  Info,
  MoreHorizontal,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  TerminalSquare,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { FileTree } from "../components/FileTree";
import { FileViewer, type FileViewerState } from "../components/FileViewer";
import { LocalTime } from "../components/Time";
import { Markdown } from "../components/Markdown";
import { Shell } from "../components/Shell";
import { TodoProgress } from "../components/TodoProgress";
import { VersionViewer } from "../components/VersionViewer";
import { avatarText, navigate } from "../lib";
import { selectTodoProgress } from "../todo-progress";
import { mergeConversationTurn, promoteTurnForActivity } from "../turn-state";
import { clampConversationRatio } from "../workspace-layout";
import {
  rememberedWorkMode,
  rememberWorkMode,
  WorkCreationConfirmationRequired
} from "../work-mode";
import type {
  CommandExecutionItem,
  CodeVersion,
  ConversationItem,
  ConversationTurn,
  FileAppendEvent,
  FileChangeItem,
  FileCreateEvent,
  FileTreeNode,
  FileView,
  Guest,
  Project,
  WorkItem,
  WorkItemEvent,
  WorkItemType,
  WorkflowState
} from "../types";

type Viewer = "app" | "files" | "terminal" | "versions";
type ProjectSync = {
  connected: true;
  project: Project;
  activeWorkItem?: WorkItem | null;
  workItemEvents?: WorkItemEvent[];
  turns: ConversationTurn[];
};
type ThinkingUpdate = {
  turnId: string;
  active: boolean;
};
type WorkflowErrorDetails = {
  kind?: string;
  actionLabel?: string;
  currentStateLabel?: string;
  allowedStateLabels?: string[];
  targetStateLabel?: string;
  executionStateLabel?: string;
  guidance?: string;
};

const statusText: Record<ConversationTurn["status"], string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

function viewerFromLocation(): Viewer | null {
  const viewer = new URLSearchParams(location.search).get("viewer");
  return viewer === "app" || viewer === "files" || viewer === "terminal" || viewer === "versions"
    ? viewer
    : null;
}

function writeViewerLocation(viewer: Viewer): void {
  const url = new URL(location.href);
  if (viewer === "versions") {
    url.searchParams.set("viewer", viewer);
  } else {
    for (const key of ["viewer", "section", "detail", "version", "workItem"]) {
      url.searchParams.delete(key);
    }
  }
  history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function treeContains(nodes: FileTreeNode[], path: string): boolean {
  return nodes.some(
    (node) => node.path === path || (node.children ? treeContains(node.children, path) : false)
  );
}

function rootReadmePath(nodes: FileTreeNode[]): string | null {
  return nodes.find(
    (node) =>
      node.type === "file" &&
      /^readme(?:\.[^.]+)?$/iu.test(node.name) &&
      !node.path.includes("/")
  )?.path ?? null;
}

function upsertFileTreePath(
  nodes: FileTreeNode[],
  path: string,
  change: "new" | "updated"
): FileTreeNode[] {
  const parts = path.split("/").filter(Boolean);
  const insert = (
    current: FileTreeNode[],
    index: number,
    parentPath: string
  ): FileTreeNode[] => {
    const name = parts[index];
    if (!name) return current;
    const nodePath = parentPath ? `${parentPath}/${name}` : name;
    const existingIndex = current.findIndex((node) => node.path === nodePath);
    const isFile = index === parts.length - 1;
    const nextNode: FileTreeNode = isFile
      ? { name, path: nodePath, type: "file", change }
      : {
          name,
          path: nodePath,
          type: "directory",
          children: insert(
            existingIndex >= 0 ? current[existingIndex].children ?? [] : [],
            index + 1,
            nodePath
          )
        };
    if (existingIndex < 0) return [...current, nextNode];
    const next = [...current];
    next[existingIndex] = isFile
      ? { ...current[existingIndex], change }
      : { ...current[existingIndex], children: nextNode.children };
    return next;
  };
  return insert(nodes, 0, "");
}

function fileChangeAtPath(nodes: FileTreeNode[], path: string): FileTreeNode["change"] {
  for (const node of nodes) {
    if (node.path === path) return node.change;
    const childChange = node.children ? fileChangeAtPath(node.children, path) : undefined;
    if (childChange) return childChange;
  }
  return undefined;
}

function removeFileTreePath(nodes: FileTreeNode[], path: string): FileTreeNode[] {
  return nodes
    .filter((node) => node.path !== path)
    .map((node) =>
      node.children
        ? { ...node, children: removeFileTreePath(node.children, path) }
        : node
    );
}

function mergeById<T extends { id: string }>(
  current: T[],
  incoming: T[],
  compare: (left: T, right: T) => number
): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].sort(compare);
}

function fileViewFromSnapshot(item: FileChangeItem): FileView | null {
  if (item.contentSnapshot === null) return null;
  return fileViewFromContent(item.path, item.contentSnapshot);
}

function fileViewFromContent(path: string, content: string): FileView {
  const size = new TextEncoder().encode(content).byteLength;
  if (size > 1024 * 1024) {
    return {
      kind: "large",
      name: path.split("/").pop() ?? path,
      path,
      size,
      message: "文件过大，无法预览"
    };
  }
  return {
    kind: "text",
    name: path.split("/").pop() ?? path,
    path,
    size,
    content,
    language: "text"
  };
}

const workflowLabel: Record<WorkflowState, string> = {
  requirements_discussion: "需求讨论",
  requirements_pending_confirmation: "需求待确认",
  technical_design: "技术方案",
  technical_pending_confirmation: "技术方案待确认",
  development: "开发",
  testing_admission: "测试准入",
  testing: "测试",
  pending_release: "待上线",
  published: "已发布",
  abandoned: "已放弃",
  direct_coding: "直接编码"
};

function workflowEventDescription(event: WorkItemEvent): string | null {
  if (event.kind === "created") return "工作项已创建";
  if (event.kind === "title_updated") return "工作标题已更新";
  if (event.kind === "transition" && event.toState) {
    return event.fromState && event.fromState !== event.toState
      ? `${workflowLabel[event.fromState]} → ${workflowLabel[event.toState]}`
      : `进入${workflowLabel[event.toState]}`;
  }
  if (event.kind === "published") return "工作项已发布";
  if (event.kind === "abandoned") return "工作项已放弃";
  if (event.kind === "confirmed_action") return "关键操作已二次确认";
  if (event.kind === "publish_attempt") return "已发起版本发布";
  if (event.kind === "publish_failed") return "版本发布失败";
  if (event.kind === "checkpoint") return "已创建内部检查点";
  if (event.kind === "stopped") return "执行已停止";
  if (event.kind === "retried") return "已人工重试";
  if (event.kind === "failed") return "执行失败";
  return null;
}

type ConversationTimelineEntry =
  | { kind: "turn"; createdAt: string; turn: ConversationTurn }
  | { kind: "workflow_event"; createdAt: string; event: WorkItemEvent };

export function buildConversationTimeline(
  turns: ConversationTurn[],
  events: WorkItemEvent[]
): ConversationTimelineEntry[] {
  return [
    ...turns.map((turn): ConversationTimelineEntry => ({
      kind: "turn",
      createdAt: turn.createdAt,
      turn
    })),
    ...events
      .filter((event) => workflowEventDescription(event) !== null)
      .map((event): ConversationTimelineEntry => ({
        kind: "workflow_event",
        createdAt: event.createdAt,
        event
      }))
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function WorkflowEventCard({ event }: { event: WorkItemEvent }) {
  const description = workflowEventDescription(event);
  if (!description) return null;
  return (
    <div className="workflow-event-card">
      <GitBranch size={14} aria-hidden="true" />
      <span>
        <strong>{description}</strong>
        <small>
          {event.source === "natural_language"
            ? "通过自然语言触发"
            : event.source === "system"
              ? "由系统自动推进"
              : "通过界面操作"}
        </small>
        {typeof event.details.reason === "string" && (
          <small>原因：{event.details.reason}</small>
        )}
      </span>
      <LocalTime value={event.createdAt} />
    </div>
  );
}

function WorkflowBar({
  item,
  disabledReason,
  nextType,
  onAction,
  onCreate,
  onRename
}: {
  item: WorkItem | null;
  disabledReason: string | null;
  nextType: WorkItemType;
  onAction: (action: string, targetState?: WorkflowState) => void;
  onCreate: (type: WorkItemType) => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(item?.title ?? "");
  const disabled = Boolean(disabledReason);
  useEffect(() => setTitleDraft(item?.title ?? ""), [item?.title]);
  if (!item) {
    return (
      <div className="workflow-bar empty">
        <span>开始新的工作</span>
        <div>
          <button className={nextType === "direct_coding" ? "active" : ""} onClick={() => onCreate("direct_coding")}>直接编码</button>
          <button className={nextType === "structured_requirement" ? "active" : ""} onClick={() => onCreate("structured_requirement")}>需求规划</button>
        </div>
      </div>
    );
  }
  const state = item.workflowState;
  const stateLabel =
    item.executionState === "running" &&
    state === "pending_release"
      ? "发布处理中"
      : workflowLabel[state];
  const executionLabel = {
    idle: "空闲",
    running: "执行中",
    stopped: "已停止",
    failed: "执行失败"
  }[item.executionState];
  const primary =
    item.executionState === "stopped" || item.executionState === "failed"
      ? ["continue_execution", "重新执行"] as const
      : state === "requirements_discussion"
      ? ["confirm_requirements", "确认需求"] as const
      : state === "technical_pending_confirmation"
        ? ["confirm_technical", "确认方案并开发"] as const
        : state === "development"
          ? ["start_testing", "开始测试"] as const
          : state === "testing_admission"
            ? null
          : state === "testing"
            ? ["ready_release", "测试完成"] as const
            : state === "pending_release" || state === "direct_coding"
              ? ["publish", "发布版本"] as const
              : null;
  const previous: Partial<Record<WorkflowState, WorkflowState>> = {
    technical_design: "requirements_discussion",
    technical_pending_confirmation: "requirements_discussion",
    development: "technical_design",
    testing_admission: "development",
    testing: "development",
    pending_release: "testing"
  };
  return (
    <div className="workflow-bar">
      <span>
        <i />
        {item.requirementSequence
          ? `R${String(item.requirementSequence).padStart(3, "0")}`
          : "编码工作"}{" "}
        · {stateLabel} · {executionLabel} · {item.title}
        <button
          className="workflow-title-edit"
          aria-label="修改工作标题"
          disabled={disabled}
          aria-describedby={disabledReason ? "workflow-disabled-reason" : undefined}
          title={disabledReason ?? undefined}
          onClick={() => setEditingTitle(true)}
        >
          <Pencil size={12} />
        </button>
      </span>
      <div>
        {primary && (
          <button
            className="primary"
            disabled={disabled}
            aria-describedby={disabledReason ? "workflow-disabled-reason" : undefined}
            title={disabledReason ?? undefined}
            onClick={() => onAction(primary[0])}
          >
            {primary[1]}
          </button>
        )}
        <button
          aria-label="更多工作操作"
          aria-expanded={moreOpen}
          disabled={disabled}
          aria-describedby={disabledReason ? "workflow-disabled-reason" : undefined}
          title={disabledReason ?? undefined}
          onClick={() => setMoreOpen((current) => !current)}
        >
          <MoreHorizontal size={14} />
        </button>
        {moreOpen && (
          <div className="workflow-more-menu" role="menu">
            {previous[state] && (
              <button role="menuitem" onClick={() => {
                setMoreOpen(false);
                onAction("return_to_stage", previous[state]);
              }}>退回阶段</button>
            )}
            <button className="danger" role="menuitem" onClick={() => {
              setMoreOpen(false);
              onAction("abandon");
            }}>放弃当前工作</button>
          </div>
        )}
      </div>
      {disabledReason && (
        <p
          id="workflow-disabled-reason"
          className="workflow-disabled-reason"
          role="status"
          aria-live="polite"
        >
          <Info size={13} aria-hidden="true" />
          <span>{disabledReason}</span>
        </p>
      )}
      {editingTitle && (
        <div className="workflow-title-editor" role="dialog" aria-label="修改工作标题">
          <input
            value={titleDraft}
            maxLength={100}
            autoFocus
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingTitle(false);
            }}
          />
          <button onClick={() => setEditingTitle(false)}>取消</button>
          <button
            className="primary"
            disabled={!titleDraft.trim()}
            onClick={async () => {
              await onRename(titleDraft);
              setEditingTitle(false);
            }}
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

export function ProjectPage({
  guest,
  projectId,
  onGuestChange
}: {
  guest: Guest;
  projectId: string;
  onGuestChange: (guest: Guest) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [activeWorkItem, setActiveWorkItem] = useState<WorkItem | null>(null);
  const [currentCodeVersion, setCurrentCodeVersion] = useState<CodeVersion | null>(null);
  const [workItemEvents, setWorkItemEvents] = useState<WorkItemEvent[]>([]);
  const [workItemModelLoaded, setWorkItemModelLoaded] = useState(false);
  const [workflowError, setWorkflowError] = useState<WorkflowErrorDetails | null>(null);
  const [versionRefresh, setVersionRefresh] = useState(0);
  const [nextWorkType, setNextWorkType] = useState<WorkItemType>(rememberedWorkMode);
  const [pendingWorkCreation, setPendingWorkCreation] = useState<{
    text: string;
    images: File[];
    uploadIds: string[];
    source: "button" | "natural_language";
  } | null>(null);
  const [composerReset, setComposerReset] = useState(0);
  const [pendingWorkAction, setPendingWorkAction] = useState<{
    action: string;
    targetState?: WorkflowState;
    message: string;
    source: "button" | "natural_language";
    title?: string;
    summary?: string;
    reason?: string;
    revision: number;
    idempotencyKey: string;
  } | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [thinkingByMessage, setThinkingByMessage] = useState<Map<string, boolean>>(
    () => new Map()
  );
  const todoProgress = useMemo(() => selectTodoProgress(turns), [turns]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(null);
  const [olderMessagesError, setOlderMessagesError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"connected" | "reconnecting" | "failed">("connected");
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [draft, setDraft] = useState("");
  const [viewer, setViewer] = useState<Viewer>(() => viewerFromLocation() ?? "files");
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileViewerState, setFileViewerState] = useState<FileViewerState>("idle");
  const [fileViewerError, setFileViewerError] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [workspaceAutoFollow, setWorkspaceAutoFollow] = useState(true);
  const [mobileSurface, setMobileSurface] = useState<"conversation" | "workspace">("conversation");
  const [conversationCollapsed, setConversationCollapsed] = useState(false);
  const [ratio, setRatio] = useState(() => Number(localStorage.getItem("atoms.workspaceRatio") ?? 30));
  const [confirmStop, setConfirmStop] = useState<{
    turn: ConversationTurn;
    source: "button" | "natural_language";
  } | null>(null);
  const [stopSubmitting, setStopSubmitting] = useState(false);
  const [stopError, setStopError] = useState("");
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [newConversationActivity, setNewConversationActivity] = useState(false);
  const [newTerminalOutput, setNewTerminalOutput] = useState(false);
  const [workspaceActivity, setWorkspaceActivity] = useState(false);
  const [previewHistory, setPreviewHistory] = useState<string[]>([]);
  const [previewIndex, setPreviewIndex] = useState(-1);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewRetrying, setPreviewRetrying] = useState(false);
  const reconnectStarted = useRef(0);
  const ws = useRef<WebSocket | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const fileContentRef = useRef<HTMLDivElement | null>(null);
  const fileRequestSequence = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const conversationPaused = useRef(false);
  const manualViewer = useRef<Viewer | null>(null);
  const manualFileSelection = useRef(false);
  const viewerTurn = useRef<string | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const streamingFiles = useRef(new Map<string, { path: string; content: string }>());
  const followingFilePath = useRef<string | null>(null);
  const workspaceAutoFollowRef = useRef(true);
  const latestWorkspaceActivity = useRef<"files" | "terminal" | null>(null);

  const selectPath = useCallback((path: string) => {
    selectedPathRef.current = path;
    setSelectedPath(path);
  }, []);

  const updateWorkspaceAutoFollow = useCallback((enabled: boolean) => {
    workspaceAutoFollowRef.current = enabled;
    setWorkspaceAutoFollow(enabled);
  }, []);

  useEffect(() => {
    const restoreViewer = () => setViewer(viewerFromLocation() ?? "files");
    window.addEventListener("popstate", restoreViewer);
    return () => window.removeEventListener("popstate", restoreViewer);
  }, []);

  const openFile = useCallback(async (path: string, manual = false) => {
    if (manual) {
      followingFilePath.current = null;
      updateWorkspaceAutoFollow(false);
    }
    const requestSequence = fileRequestSequence.current + 1;
    fileRequestSequence.current = requestSequence;
    selectPath(path);
    setFileView(null);
    setFileViewerError("");
    setFileViewerState("loading");
    try {
      const result = await api.file(guest.id, projectId, path);
      if (fileRequestSequence.current !== requestSequence) return;
      setFileView(result);
      setFileViewerState("ready");
    } catch (reason) {
      if (fileRequestSequence.current !== requestSequence) return;
      setFileViewerError(reason instanceof Error ? reason.message : "文件已删除");
      setFileViewerState("error");
    }
  }, [guest.id, projectId, selectPath, updateWorkspaceAutoFollow]);

  const refreshFiles = useCallback(async () => {
    try {
      const next = (await api.files(guest.id, projectId)).items;
      setFiles(next);
      return next;
    } catch {
      // A file event can race the physical write; the completion event retries.
      return null;
    }
  }, [guest.id, projectId]);

  const beginViewerTurn = useCallback((turnId: string) => {
    if (viewerTurn.current === turnId) return;
    viewerTurn.current = turnId;
    manualViewer.current = null;
    manualFileSelection.current = false;
    followingFilePath.current = null;
    updateWorkspaceAutoFollow(true);
  }, [updateWorkspaceAutoFollow]);

  const mergeTurn = useCallback((incoming: ConversationTurn) => {
    if (incoming.status === "running") beginViewerTurn(incoming.id);
    setTurns((current) => {
      const index = current.findIndex(({ id }) => id === incoming.id);
      if (index < 0) return [...current, incoming].sort((a, b) => a.sequence - b.sequence);
      const next = [...current];
      next[index] = mergeConversationTurn(next[index], incoming);
      return next;
    });
  }, [beginViewerTurn]);

  const mergeItem = useCallback((incoming: ConversationItem) => {
    setTurns((current) => current.map((turn) => {
      if (turn.id !== incoming.turnId) return turn;
      const index = turn.items.findIndex(({ id }) => id === incoming.id);
      const items = [...turn.items];
      if (index < 0) items.push(incoming);
      else items[index] = incoming;
      items.sort((left, right) => left.ordinal - right.ordinal);
      return promoteTurnForActivity({ ...turn, items });
    }));
    setWorkspaceActivity(true);
    if (incoming.type === "file_change") {
      latestWorkspaceActivity.current = "files";
      const isRelocation =
        (incoming.action === "rename" || incoming.action === "move") &&
        Boolean(incoming.previousPath);
      const selectedWasRelocated =
        isRelocation && selectedPathRef.current === incoming.previousPath;
      for (const [streamId, stream] of streamingFiles.current) {
        if (
          stream.path === incoming.path ||
          stream.path === incoming.previousPath
        ) {
          streamingFiles.current.delete(streamId);
        }
      }
      const shouldShowFiles =
        manualViewer.current === null || manualViewer.current === "files";
      const shouldOpen =
        shouldShowFiles &&
        !manualFileSelection.current &&
        workspaceAutoFollowRef.current;
      if (incoming.action === "delete") {
        setFiles((current) => removeFileTreePath(current, incoming.path));
      } else if (isRelocation && incoming.previousPath) {
        const previousPath = incoming.previousPath;
        setFiles((current) => {
          const previousChange = fileChangeAtPath(current, previousPath);
          return upsertFileTreePath(
            removeFileTreePath(current, previousPath),
            incoming.path,
            previousChange === "new" ? "new" : "updated"
          );
        });
        if (selectedWasRelocated) {
          selectPath(incoming.path);
          if (followingFilePath.current === incoming.previousPath) {
            followingFilePath.current = incoming.path;
          }
          setFileView((current) =>
            current
              ? {
                  ...current,
                  name: incoming.path.split("/").pop() ?? incoming.path,
                  path: incoming.path
                }
              : current
          );
        }
      } else {
        setFiles((current) =>
          upsertFileTreePath(
            current,
            incoming.path,
            incoming.action === "create" ? "new" : "updated"
          )
        );
      }
      const selectedWasDeleted =
        incoming.action === "delete" && selectedPathRef.current === incoming.path;
      if (shouldOpen || selectedWasDeleted) {
        setViewer("files");
        if (!selectedWasRelocated) selectPath(incoming.path);
        const snapshot = fileViewFromSnapshot(incoming);
        if (snapshot) {
          setFileView(snapshot);
          setFileViewerState("ready");
        } else if (incoming.action === "delete") {
          setFileView({
            kind: "binary",
            name: incoming.path.split("/").pop() ?? incoming.path,
            path: incoming.path,
            size: 0,
            mimeType: "",
            message: `文件已删除：${incoming.path}`
          });
          setFileViewerState("ready");
        } else {
          void openFile(incoming.path);
        }
      }
      if (incoming.status !== "in_progress") {
        void refreshFiles();
        if (
          incoming.status === "completed" &&
          incoming.action !== "delete" &&
          (shouldOpen || selectedPathRef.current === incoming.path)
        ) {
          void openFile(incoming.path);
        }
      }
    }
    if (manualViewer.current === null && incoming.type === "command_execution") {
      latestWorkspaceActivity.current = "terminal";
      if (workspaceAutoFollowRef.current) setViewer("terminal");
    }
  }, [openFile, refreshFiles, selectPath]);

  const createStreamingFile = useCallback((incoming: FileCreateEvent) => {
    streamingFiles.current.set(incoming.streamId, { path: incoming.path, content: "" });
    latestWorkspaceActivity.current = "files";
    setWorkspaceActivity(true);
    setFiles((current) =>
      upsertFileTreePath(
        current,
        incoming.path,
        incoming.action === "create" ? "new" : "updated"
      )
    );
    const shouldShowFiles =
      manualViewer.current === null || manualViewer.current === "files";
    if (!shouldShowFiles || !workspaceAutoFollowRef.current) return;
    followingFilePath.current = incoming.path;
    setViewer("files");
    selectPath(incoming.path);
    setFileView(fileViewFromContent(incoming.path, ""));
    setFileViewerState("ready");
  }, [selectPath]);

  const appendStreamingFile = useCallback((incoming: FileAppendEvent) => {
    const current = streamingFiles.current.get(incoming.streamId);
    if (!current || current.path !== incoming.path) return;
    const content = current.content.slice(0, incoming.offset) + incoming.delta;
    streamingFiles.current.set(incoming.streamId, { ...current, content });
    latestWorkspaceActivity.current = "files";
    setWorkspaceActivity(true);
    if (selectedPathRef.current === incoming.path) {
      setFileView(fileViewFromContent(incoming.path, content));
      setFileViewerState("ready");
    }
  }, []);

  useEffect(() => {
    if (
      viewer !== "files" ||
      fileView?.kind !== "text" ||
      followingFilePath.current !== fileView.path ||
      !workspaceAutoFollowRef.current
    ) {
      return;
    }
    requestAnimationFrame(() => {
      const element = fileContentRef.current;
      if (
        element &&
        followingFilePath.current === fileView.path &&
        workspaceAutoFollowRef.current
      ) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }, [workspaceAutoFollow, fileView, viewer]);

  const appendAssistantDelta = useCallback(
    (incoming: { turnId: string; itemId: string; delta: string }) => {
      setTurns((current) => current.map((turn) => {
        if (turn.id !== incoming.turnId) return turn;
        return promoteTurnForActivity({
          ...turn,
          items: turn.items.map((item) => {
            if (item.id !== incoming.itemId) return item;
            if (item.type === "assistant_message") {
              return { ...item, text: item.text + incoming.delta };
            }
            return item;
          })
        });
      }));
    },
    []
  );

  const replaceItemOutput = useCallback(
    (incoming: {
      turnId: string;
      itemId: string;
      output: string;
      outputTruncated?: boolean;
    }) => {
      setTurns((current) => current.map((turn) => {
        if (turn.id !== incoming.turnId) return turn;
        return promoteTurnForActivity({
          ...turn,
          items: turn.items.map((item) =>
            item.id === incoming.itemId &&
            (
              item.type === "command_execution" ||
              item.type === "file_change" ||
              item.type === "tool_call"
            )
              ? {
                  ...item,
                  output: incoming.output,
                  outputTruncated: Boolean(incoming.outputTruncated)
                }
              : item
          )
        });
      }));
      latestWorkspaceActivity.current = "terminal";
      setWorkspaceActivity(true);
    },
    []
  );

  const updateThinking = useCallback((incoming: ThinkingUpdate) => {
    setThinkingByMessage((current) => {
      const next = new Map(current);
      next.set(incoming.turnId, incoming.active);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.project(guest.id, projectId);
      setProject(response.project);
      setActiveWorkItem(response.activeWorkItem);
      setCurrentCodeVersion(response.currentCodeVersion ?? null);
      setWorkItemEvents(response.workItemEvents ?? []);
      setWorkItemModelLoaded("activeWorkItem" in response);
      setTurns(response.turns.items);
      setThinkingByMessage(new Map());
      setHasOlderMessages(response.turns.hasMore);
      setOlderMessagesCursor(response.turns.nextCursor);
      setOlderMessagesError("");
      if (response.project.previewUrl) {
        setPreviewHistory([response.project.previewUrl]);
        setPreviewIndex(0);
      }
      const runningItem = response.turns.items
        .flatMap(({ items }) => items)
        .reverse()
        .find((item) => item.status === "in_progress");
      const runningTurn = response.turns.items.find((turn) => turn.status === "running");
      if (runningTurn) beginViewerTurn(runningTurn.id);
      const initialViewer =
        viewerFromLocation() ??
          (response.activeWorkItem?.type === "structured_requirement"
            ? "versions"
            : runningItem?.type === "command_execution"
            ? "terminal"
            : runningItem?.type === "file_change"
              ? "files"
              : response.project.previewStatus === "ready"
                ? "app"
                : "files");
      setViewer(initialViewer);
      const refreshedFiles = await refreshFiles();
      if (runningItem?.type === "file_change") {
        const snapshot = fileViewFromSnapshot(runningItem);
        if (snapshot) {
          selectPath(runningItem.path);
          setFileView(snapshot);
          setFileViewerState("ready");
        } else if (runningItem.action !== "delete") {
          await openFile(runningItem.path);
        }
      } else if (initialViewer === "files" && !selectedPathRef.current && refreshedFiles) {
        const readme = rootReadmePath(refreshedFiles);
        if (readme) await openFile(readme);
      }
      requestAnimationFrame(() => {
        if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
        if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
      });
    } catch (reason) {
      if (reason && typeof reason === "object" && "status" in reason && reason.status === 404) {
        setUnavailable(true);
      } else {
        setError(reason instanceof Error ? reason.message : "项目加载失败");
      }
    } finally {
      setLoading(false);
    }
  }, [beginViewerTurn, guest.id, openFile, projectId, refreshFiles, selectPath]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!project) return;
    let disposed = false;
    let retry: number | undefined;
    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(
        `${scheme}://${location.host}/ws/projects/${project.id}?guestId=${encodeURIComponent(guest.id)}`
      );
      ws.current = socket;
      socket.onopen = () => {
        reconnectStarted.current = 0;
        setConnection("connected");
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data);
        if (event.kind === "sync") {
          const snapshot = event.data as ProjectSync;
          const runningTurn = snapshot.turns.find((turn) => turn.status === "running");
          if (runningTurn) beginViewerTurn(runningTurn.id);
          setProject(snapshot.project);
          if ("activeWorkItem" in snapshot) setActiveWorkItem(snapshot.activeWorkItem ?? null);
          if (snapshot.workItemEvents) setWorkItemEvents(snapshot.workItemEvents);
          setTurns((current) =>
            mergeById(current, snapshot.turns, (left, right) => left.sequence - right.sequence)
          );
          return;
        }
        if (
          event.kind === "turn_created" ||
          event.kind === "turn_started" ||
          event.kind === "turn_completed"
        ) mergeTurn(event.data);
        if (event.kind === "item_started" || event.kind === "item_completed") {
          mergeItem(event.data);
        }
        if (event.kind === "item_assistant_message_delta") {
          appendAssistantDelta(event.data);
        }
        if (event.kind === "item_command_output_snapshot") {
          replaceItemOutput(event.data);
        }
        if (event.kind === "file_create") createStreamingFile(event.data);
        if (event.kind === "file_append") appendStreamingFile(event.data);
        if (event.kind === "thinking") updateThinking(event.data);
        if (event.kind === "file_tree") void refreshFiles();
        if (event.kind === "preview") setProject(event.data);
        if (event.kind === "work_item_updated") {
          const item = event.data as WorkItem;
          setActiveWorkItem(item.archivedAt ? null : item);
        }
        if (event.kind === "version_published") {
          setCurrentCodeVersion(event.data as CodeVersion);
          setVersionRefresh((current) => current + 1);
          setActiveWorkItem(null);
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        if (!reconnectStarted.current) reconnectStarted.current = Date.now();
        setConnection(Date.now() - reconnectStarted.current > 60_000 ? "failed" : "reconnecting");
        retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      ws.current?.close();
    };
  }, [
    project?.id,
    guest.id,
    appendAssistantDelta,
    appendStreamingFile,
    beginViewerTurn,
    createStreamingFile,
    mergeItem,
    mergeTurn,
    refreshFiles,
    replaceItemOutput,
    updateThinking,
    reconnectNonce
  ]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.data?.source !== "atoms-preview"
      ) {
        return;
      }
      const path = String(event.data.path ?? "");
      try {
        const expected = new URL(project?.previewUrl ?? `/preview/${projectId}/`, location.href);
        const incoming = new URL(path, location.href);
        if (incoming.origin !== expected.origin) return;
      } catch {
        return;
      }
      setPreviewHistory((current) => {
        if (current[previewIndex] === path) return current;
        const next = [...current.slice(0, previewIndex + 1), path];
        setPreviewIndex(next.length - 1);
        return next;
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [previewIndex, project?.previewUrl, projectId]);

  const actionItems = useMemo(
    () =>
      turns
        .flatMap(({ items }) => items)
        .filter(
          (item): item is CommandExecutionItem | FileChangeItem =>
            item.type === "command_execution" || item.type === "file_change"
        ),
    [turns]
  );
  const conversationSignature = turns
    .map((turn) =>
      `${turn.id}:${turn.status}:${turn.items
        .map((item) =>
          item.type === "assistant_message"
            ? `${item.id}:${item.text.length}:${item.status}`
            : `${item.id}:${item.status}`
        )
        .join(",")}`
    )
    .join("|");
  useEffect(() => {
    const element = timelineRef.current;
    if (!element || loading) return;
    if (!conversationPaused.current) {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
        setNewConversationActivity(false);
      });
    } else {
      setNewConversationActivity(true);
    }
  }, [conversationSignature, loading]);

  const terminalSignature = actionItems
    .filter((item): item is CommandExecutionItem => item.type === "command_execution")
    .map(({ id, status, output }) => `${id}:${status}:${output.length}`)
    .join("|");
  useEffect(() => {
    const element = terminalRef.current;
    if (!element) return;
    if (workspaceAutoFollowRef.current) {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
        setNewTerminalOutput(false);
      });
    } else {
      setNewTerminalOutput(true);
    }
  }, [terminalSignature, workspaceAutoFollow]);

  useEffect(() => {
    if (!selectedPath || treeContains(files, selectedPath)) return;
    setFileView({
      kind: "binary",
      name: selectedPath.split("/").pop() ?? selectedPath,
      path: selectedPath,
      size: 0,
      mimeType: "",
      message: `文件已删除：${selectedPath}`
    });
    setFileViewerState("ready");
  }, [files, selectedPath]);

  const performWorkAction = async (
    action: string,
    source: "button" | "natural_language",
    targetState?: WorkflowState,
    confirmed = false,
    actionDetails?: { title?: string; summary?: string; reason?: string },
    actionContext?: { revision: number; idempotencyKey: string }
  ) => {
    if (!activeWorkItem) return;
    const revision = actionContext?.revision ?? activeWorkItem.revision;
    const idempotencyKey = actionContext?.idempotencyKey ?? crypto.randomUUID();
    setError("");
    setWorkflowError(null);
    try {
      const result = await api.workItemAction(
        guest.id,
        projectId,
        activeWorkItem.id,
        {
          action,
          targetState,
          source,
          confirmed,
          title: actionDetails?.title,
          summary: actionDetails?.summary,
          reason: actionDetails?.reason,
          revision,
          idempotencyKey
        }
      );
      if (result.confirmationRequired) {
        setPendingWorkAction({
          action,
          targetState,
          source,
          message: result.message ?? "确认执行这个阶段操作？",
          title: result.suggestedTitle,
          summary: result.suggestedSummary,
          reason: "",
          revision,
          idempotencyKey
        });
        return;
      }
      if (result.workItem) setActiveWorkItem(result.workItem.archivedAt ? null : result.workItem);
      if (result.turn) {
        beginViewerTurn(result.turn.id);
        mergeTurn(result.turn);
      }
      if (result.version) {
        setVersionRefresh((current) => current + 1);
        setViewer("versions");
      }
      try {
        setWorkItemEvents(
          (await api.workItemEvents(guest.id, projectId, activeWorkItem.id)).items
        );
      } catch {
        // Realtime sync will reconcile audit events if this read races the write.
      }
      setPendingWorkAction(null);
      setDraft("");
    } catch (reason) {
      if (confirmed) setPendingWorkAction(null);
      try {
        const latest = await api.project(guest.id, projectId);
        setProject(latest.project);
        setActiveWorkItem(latest.activeWorkItem ?? null);
        setWorkItemEvents(latest.workItemEvents ?? []);
        setTurns((current) =>
          mergeById(current, latest.turns.items, (left, right) => left.sequence - right.sequence)
        );
      } catch {
        // Keep the current snapshot when refresh also fails.
      }
      const details =
        reason &&
        typeof reason === "object" &&
        "details" in reason &&
        reason.details &&
        typeof reason.details === "object"
          ? reason.details as WorkflowErrorDetails
          : null;
      setWorkflowError(details?.kind === "workflow_transition" ? details : null);
      setError(reason instanceof Error ? reason.message : "阶段操作失败");
    }
  };

  const previousStage = (state: WorkflowState): WorkflowState | undefined => {
    const previous: Partial<Record<WorkflowState, WorkflowState>> = {
      technical_design: "requirements_discussion",
      technical_pending_confirmation: "requirements_discussion",
      development: "technical_design",
      testing_admission: "development",
      testing: "development",
      pending_release: "testing"
    };
    return previous[state];
  };

  const naturalLanguageAction = (text: string) => {
    const normalized = text.trim().replace(/[。！!]/g, "");
    if (!activeWorkItem) return null;
    if (/^(继续执行|继续|重试)$/.test(normalized)) return { action: "continue_execution" };
    if (/^(放弃需求|放弃当前需求|放弃工作)$/.test(normalized)) return { action: "abandon" };
    if (/^(发布版本|发布代码版本|上线)$/.test(normalized)) return { action: "publish" };
    if (/^(退回阶段|回退阶段)$/.test(normalized)) {
      return { action: "return_to_stage", targetState: previousStage(activeWorkItem.workflowState) };
    }
    if (
      ["development", "testing_admission", "testing", "pending_release"].includes(
        activeWorkItem.workflowState
      ) &&
      /^(修改|变更|调整|补充).*(需求|功能|流程|数据|权限|验收标准)/u.test(normalized)
    ) {
      return { action: "return_to_stage", targetState: "requirements_discussion" as const };
    }
    if (
      ["development", "testing_admission", "testing", "pending_release"].includes(
        activeWorkItem.workflowState
      ) &&
      /^(修改|变更|调整|补充).*(技术方案|兼容性|迁移方案|安全边界)/u.test(normalized)
    ) {
      return { action: "return_to_stage", targetState: "technical_design" as const };
    }
    if (/^(确认需求|进入技术设计阶段|开始技术设计)$/.test(normalized)) {
      if (
        activeWorkItem.workflowState === "requirements_pending_confirmation" &&
        ["stopped", "failed"].includes(activeWorkItem.executionState)
      ) {
        return { action: "continue_execution" };
      }
      return { action: "confirm_requirements" };
    }
    if (/^(确认技术方案|确认方案|开始开发)$/.test(normalized)) {
      return { action: "confirm_technical" };
    }
    if (/^开始测试$/.test(normalized)) return { action: "start_testing" };
    if (/^(测试完成|进入待上线)$/.test(normalized)) return { action: "ready_release" };
    return null;
  };

  const submit = async (images: File[], uploadIds: string[] = []) => {
    setError("");
    setWorkflowError(null);
    viewerTurn.current = null;
    manualViewer.current = null;
    manualFileSelection.current = false;
    try {
      if (
        images.length === 0 &&
        uploadIds.length === 0 &&
        /^(停止|停止任务|停止当前任务)[。！!]?$/u.test(draft.trim()) &&
        running
      ) {
        setStopError("");
        setConfirmStop({ turn: running, source: "natural_language" });
        return;
      }
      const intent =
        images.length === 0 && uploadIds.length === 0
          ? naturalLanguageAction(draft)
          : null;
      if (intent) {
        await performWorkAction(
          intent.action,
          "natural_language",
          intent.targetState
        );
        return;
      }
      if (!activeWorkItem && workItemModelLoaded) {
        const naturalRequirement = /^\s*新建需求\s*[:：]\s*(.+)$/su.exec(draft);
        const type = naturalRequirement ? "structured_requirement" : nextWorkType;
        const text = naturalRequirement?.[1]?.trim() ?? draft;
        if (type === "structured_requirement") {
          setPendingWorkCreation({
            text,
            images,
            uploadIds,
            source: naturalRequirement ? "natural_language" : "button"
          });
          throw new WorkCreationConfirmationRequired();
        }
        const created = await api.createWorkItem(
          guest.id,
          projectId,
          text,
          type,
          images,
          uploadIds
        );
        setActiveWorkItem(created.workItem);
        beginViewerTurn(created.turn.id);
        mergeTurn(created.turn);
        setDraft("");
        return;
      }
      const sent = await api.sendMessage(
        guest.id,
        projectId,
        draft,
        images,
        uploadIds
      );
      beginViewerTurn(sent.id);
      mergeTurn(sent);
      setDraft("");
    } catch (reason) {
      if (reason instanceof WorkCreationConfirmationRequired) return;
      setError(reason instanceof Error ? reason.message : "消息发送失败");
      throw reason;
    }
  };

  const loadOlder = async () => {
    const element = timelineRef.current;
    if (!olderMessagesCursor || !element || loadingOlder) return;
    setLoadingOlder(true);
    setOlderMessagesError("");
    const previousHeight = element.scrollHeight;
    try {
      const response = await api.olderMessages(guest.id, projectId, olderMessagesCursor);
      setTurns((current) => {
        const merged = new Map(current.map((turn) => [turn.id, turn]));
        for (const incoming of response.items) {
          const existing = merged.get(incoming.id);
          merged.set(
            incoming.id,
            existing ? mergeConversationTurn(existing, incoming) : incoming
          );
        }
        return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
      });
      setHasOlderMessages(response.hasMore);
      setOlderMessagesCursor(response.nextCursor);
      requestAnimationFrame(() => {
        element.scrollTop += element.scrollHeight - previousHeight;
      });
    } catch (reason) {
      setOlderMessagesError(reason instanceof Error ? reason.message : "更早内容加载失败");
    } finally {
      setLoadingOlder(false);
    }
  };

  if (loading) {
    return <Shell guest={guest} active="project" projectLocked onGuestChange={onGuestChange}><div className="center-state page">正在加载项目…</div></Shell>;
  }
  if (unavailable || !project) {
    return (
      <Shell guest={guest} active="project" projectLocked onGuestChange={onGuestChange}>
        <div className="unavailable-state">
          <h1>项目不可用</h1>
          <p>项目不存在、已损坏，或不属于当前游客。</p>
          <button className="button primary" onClick={() => navigate("/projects")}>返回我的项目</button>
        </div>
      </Shell>
    );
  }

  const queuedCount = turns.filter(({ status }) => status === "queued").length;
  const running = turns.find(({ status }) => status === "running");

  return (
    <Shell guest={guest} active="project" projectLocked onGuestChange={onGuestChange}>
      <div className="project-page">
        <header className="project-header">
          <button className="icon-button" onClick={() => navigate("/projects")} aria-label="返回我的项目">
            <ArrowLeft size={18} />
          </button>
          <div><h1>{project.name}</h1><span>{guest.name}</span></div>
          {connection !== "connected" && (
            <div className="connection-status">
              {connection === "reconnecting" ? "连接已断开，正在重连" : "连接失败"}
              {connection === "failed" && (
                <button
                  onClick={() => {
                    ws.current?.close();
                    setConnection("reconnecting");
                    setReconnectNonce((current) => current + 1);
                  }}
                >
                  重新连接
                </button>
              )}
            </div>
          )}
          <div className="mobile-surface-switch">
            <button className={mobileSurface === "conversation" ? "active" : ""} onClick={() => setMobileSurface("conversation")}>对话</button>
            <button
              className={mobileSurface === "workspace" ? "active" : ""}
              onClick={() => {
                setMobileSurface("workspace");
                setWorkspaceActivity(false);
              }}
            >
              工作区{workspaceActivity ? <i aria-label="有新活动" /> : null}
            </button>
          </div>
        </header>
        <div
          className={`project-body ${conversationCollapsed ? "conversation-collapsed" : ""}`}
          style={{ "--conversation-ratio": `${ratio}%` } as React.CSSProperties}
        >
          <section className={`conversation-pane ${mobileSurface !== "conversation" ? "mobile-hidden" : ""}`}>
            <button
              className="collapse-conversation"
              onClick={() => setConversationCollapsed(true)}
              title="收起对话"
              aria-label="收起对话"
            >
              <PanelLeftClose size={16} />
            </button>
            <div
              className="timeline"
              ref={timelineRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                conversationPaused.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight > 80;
                if (!conversationPaused.current) setNewConversationActivity(false);
              }}
            >
              {olderMessagesError && (
                <div className="history-load-error" role="alert">
                  <span>{olderMessagesError}</span>
                  <button className="text-button" onClick={() => void loadOlder()}>
                    重试加载
                  </button>
                </div>
              )}
              {hasOlderMessages && !olderMessagesError && (
                <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {loadingOlder ? "正在加载…" : "加载更早内容"}
                </button>
              )}
              {buildConversationTimeline(turns, workItemEvents).map((entry) => {
                if (entry.kind === "workflow_event") {
                  return <WorkflowEventCard event={entry.event} key={entry.event.id} />;
                }
                const turn = entry.turn;
                const userMessage = turn.items.find((item) => item.type === "user_message");
                const agentItems = turn.items.filter(
                  (item) => item.type !== "user_message" && item.type !== "todo_list"
                );
                const isThinking =
                  turn.status === "running" &&
                  (thinkingByMessage.get(turn.id) === true ||
                    (thinkingByMessage.get(turn.id) === undefined && !agentItems.length));
                const hasAgentActivity = agentItems.length > 0 || isThinking;

                return (
                <article className="message-round" key={turn.id}>
                  {userMessage?.type === "user_message" && <div className="user-message-row">
                    <span className="avatar user-message-avatar" role="img" aria-label="我的头像">
                      {avatarText(guest.name)}
                    </span>
                    <div className="user-message">
                      <div className="message-meta user-message-meta">
                        <LocalTime value={userMessage.createdAt} />
                      </div>
                      <p>{userMessage.text}</p>
                      {userMessage.attachments.length > 0 && (
                        <div className="sent-images">
                          {userMessage.attachments.map((attachment) => {
                            const url = api.attachmentUrl(
                              guest.id,
                              projectId,
                              turn.id,
                              userMessage.id,
                              attachment.id
                            );
                            return (
                              <button key={attachment.id} onClick={() => setPreviewImage(url)}>
                                <img src={url} alt={attachment.originalName} />
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <span className={`message-status ${turn.status}`}>{statusText[turn.status]}</span>
                      {turn.status === "queued" && (
                        <button className="text-button" onClick={() => void api.cancelTurn(guest.id, projectId, turn.id)}>取消</button>
                      )}
                      {turn.error && <p className="message-error">{turn.error}</p>}
                    </div>
                  </div>}
                  {hasAgentActivity && (
                    <div className="assistant-message">
                      <div className="agent-avatar">L</div>
                      <div className="assistant-content">
                        <div className="message-meta"><strong>luffi · 工程师</strong></div>
                        {agentItems.map((item) => {
                          if (item.type === "assistant_message") {
                            return <Markdown key={item.id} content={item.text} />;
                          }
                          if (item.type === "reasoning_summary") {
                            return (
                              <div className="reasoning-summary" key={item.id}>
                                {item.summary.map((part, index) => (
                                  <Markdown key={index} content={part} />
                                ))}
                              </div>
                            );
                          }
                          const isCommand = item.type === "command_execution";
                          const isFile = item.type === "file_change";
                          const action = isCommand
                            ? "执行命令"
                            : isFile
                              ? item.action === "create"
                                ? "新建文件"
                                : item.action === "delete"
                                  ? "删除文件"
                                  : item.action === "rename"
                                    ? "重命名文件"
                                    : item.action === "move"
                                      ? "移动文件"
                                  : "更新文件"
                              : item.toolName;
                          const target = isCommand
                            ? item.command
                            : isFile
                              ? item.previousPath
                                ? `${item.previousPath} → ${item.path}`
                                : item.path
                              : item.target;
                          const description =
                            item.description ||
                            (isCommand
                              ? "执行项目命令"
                              : isFile
                                ? `${action}并更新项目内容`
                                : `调用 ${action}`);
                          return (
                            <button
                              className={`event-card ${isCommand ? "terminal" : isFile ? "file" : "tool"} ${selectedEventId === item.id ? "selected" : ""}`}
                              key={item.id}
                              aria-pressed={selectedEventId === item.id}
                              onClick={() => {
                                setSelectedEventId(item.id);
                                if (isFile) {
                                  setViewer("files");
                                  manualViewer.current = "files";
                                  manualFileSelection.current = true;
                                  void openFile(item.path, true);
                                } else if (isCommand) {
                                  setViewer("terminal");
                                  manualViewer.current = "terminal";
                                  requestAnimationFrame(() =>
                                    document
                                      .getElementById(`terminal-${item.id}`)
                                      ?.scrollIntoView({ block: "center" })
                                  );
                                }
                              }}
                            >
                              {isCommand ? <TerminalSquare size={15} /> : <FileCode2 size={15} />}
                              <span>
                                <strong>{action}</strong>
                                <small className="event-description">{description}</small>
                                {target && <em title={target}>{target}</em>}
                                {isCommand && item.outputTruncated && (
                                  <small className="event-truncated">输出已截断</small>
                                )}
                                {isFile && item.status === "failed" && item.output && (
                                  <small className="event-error">{item.output}</small>
                                )}
                              </span>
                              <span className="event-meta">
                                <em>
                                  {item.status === "in_progress"
                                    ? "进行中"
                                    : item.status === "completed"
                                      ? "成功"
                                      : item.status === "cancelled"
                                        ? "已取消"
                                        : "失败"}
                                </em>
                                <LocalTime value={item.createdAt} />
                              </span>
                            </button>
                          );
                        })}
                        {isThinking && (
                          <span className="thinking-copy" role="status" aria-live="polite">
                            正在思考中...
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </article>
                );
              })}
            </div>
            {newConversationActivity && (
              <button
                className="new-activity conversation"
                onClick={() => {
                  const element = timelineRef.current;
                  if (element) element.scrollTop = element.scrollHeight;
                  conversationPaused.current = false;
                  setNewConversationActivity(false);
                }}
              >
                有新活动
              </button>
            )}
            <div className="project-composer">
              <TodoProgress progress={todoProgress} />
              <WorkflowBar
                item={activeWorkItem}
                disabledReason={
                  running || activeWorkItem?.executionState === "running"
                    ? "当前任务正在执行，完成后即可流转；如需中断，请先停止当前任务。"
                    : queuedCount > 0
                      ? `还有 ${queuedCount} 条消息排队，处理或取消后即可流转。`
                      : null
                }
                nextType={nextWorkType}
                onAction={(action, targetState) =>
                  void performWorkAction(action, "button", targetState)
                }
                onCreate={(type) => {
                  setNextWorkType(type);
                  rememberWorkMode(type);
                }}
                onRename={async (title) => {
                  if (!activeWorkItem) return;
                  const updated = await api.updateWorkItemTitle(
                    guest.id,
                    projectId,
                    activeWorkItem.id,
                    title,
                    activeWorkItem.revision
                  );
                  setActiveWorkItem(updated);
                }}
              />
              <Composer
                key={composerReset}
                value={draft}
                onChange={setDraft}
                onSubmit={submit}
                onUpload={(file, onProgress) =>
                  api.uploadImage(guest.id, file, onProgress)
                }
                onRemoveUpload={(uploadId) => api.deleteUpload(guest.id, uploadId)}
                running={Boolean(running)}
                onStop={() => {
                  if (running) {
                    setStopError("");
                    setConfirmStop({ turn: running, source: "button" });
                  }
                }}
                queueFull={queuedCount >= 10}
                busy={connection !== "connected"}
                placeholder="描述要继续修改的内容"
              />
              {error && workflowError ? (
                <div
                  className="workflow-transition-error"
                  role="alert"
                  aria-live="assertive"
                >
                  <Info size={15} aria-hidden="true" />
                  <span>
                    <strong>
                      {workflowError.actionLabel
                        ? `暂时无法${workflowError.actionLabel}`
                        : "暂时无法流转"}
                    </strong>
                    <span>{error}</span>
                    {workflowError.guidance && <small>{workflowError.guidance}</small>}
                  </span>
                </div>
              ) : error ? (
                <p className="error-text" role="alert" aria-live="assertive">{error}</p>
              ) : null}
            </div>
          </section>
          {!conversationCollapsed && (
            <div
              className="workspace-resizer"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const startX = event.clientX;
                const start = ratio;
                let latest = ratio;
                const container = event.currentTarget.parentElement!.clientWidth;
                const move = (moveEvent: PointerEvent) => {
                  const next = clampConversationRatio(
                    start + ((moveEvent.clientX - startX) / container) * 100,
                    container
                  );
                  latest = next;
                  setRatio(next);
                };
                const up = () => {
                  localStorage.setItem("atoms.workspaceRatio", String(latest));
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            />
          )}
          <section className={`workspace-pane ${mobileSurface !== "workspace" ? "mobile-hidden" : ""}`}>
            {conversationCollapsed && (
              <button className="restore-conversation" onClick={() => setConversationCollapsed(false)}>
                <PanelLeftOpen size={16} /> 展开对话
              </button>
            )}
            <div className="viewer-tabs">
              <div className="viewer-tab-list">
                {project.previewCapable && (
                  <button className={viewer === "app" ? "active" : ""} onClick={() => { setViewer("app"); writeViewerLocation("app"); manualViewer.current = "app"; }}>
                    <AppWindow size={16} /> 应用
                  </button>
                )}
                <button className={viewer === "files" ? "active" : ""} onClick={() => { setViewer("files"); writeViewerLocation("files"); manualViewer.current = "files"; }}>
                  <FileCode2 size={16} /> 文件
                </button>
                <button className={viewer === "terminal" ? "active" : ""} onClick={() => { setViewer("terminal"); writeViewerLocation("terminal"); manualViewer.current = "terminal"; }}>
                  <TerminalSquare size={16} /> 终端
                </button>
                <button className={viewer === "versions" ? "active" : ""} onClick={() => { setViewer("versions"); writeViewerLocation("versions"); manualViewer.current = "versions"; }}>
                  <GitBranch size={16} /> 版本
                  {activeWorkItem?.type === "direct_coding" && (
                    <i className="unpublished-badge" aria-label="有未发布改动" />
                  )}
                </button>
              </div>
              <button
                className={`workspace-follow-toggle ${workspaceAutoFollow ? "active" : ""}`}
                type="button"
                role="switch"
                aria-checked={workspaceAutoFollow}
                onClick={() => {
                  const enabled = !workspaceAutoFollowRef.current;
                  updateWorkspaceAutoFollow(enabled);
                  if (!enabled) return;
                  manualViewer.current = null;
                  manualFileSelection.current = false;
                  if (latestWorkspaceActivity.current === "terminal") {
                    setViewer("terminal");
                    requestAnimationFrame(() => {
                      const element = terminalRef.current;
                      if (element) element.scrollTop = element.scrollHeight;
                      setNewTerminalOutput(false);
                    });
                    return;
                  }
                  const latest = [...streamingFiles.current.values()].at(-1);
                  if (!latest) {
                    if (viewer === "files") {
                      requestAnimationFrame(() => {
                        const element = fileContentRef.current;
                        if (element) element.scrollTop = element.scrollHeight;
                      });
                    }
                    return;
                  }
                  followingFilePath.current = latest.path;
                  setViewer("files");
                  selectPath(latest.path);
                  setFileView(fileViewFromContent(latest.path, latest.content));
                  setFileViewerState("ready");
                }}
              >
                <span aria-hidden="true" />
                自动跟随
              </button>
            </div>
            {viewer === "app" ? (
              <div className="app-viewer">
                <div className="preview-toolbar">
                  <button
                    aria-label="后退"
                    disabled={previewIndex <= 0}
                    onClick={() => setPreviewIndex((current) => Math.max(0, current - 1))}
                  ><ChevronLeft size={16} /></button>
                  <button
                    aria-label="前进"
                    disabled={previewIndex < 0 || previewIndex >= previewHistory.length - 1}
                    onClick={() =>
                      setPreviewIndex((current) => Math.min(previewHistory.length - 1, current + 1))
                    }
                  ><ChevronRight size={16} /></button>
                  <button aria-label="刷新" onClick={() => setPreviewKey((current) => current + 1)}>
                    <RefreshCw size={15} />
                  </button>
                  {(() => {
                    if (activeWorkItem?.type === "direct_coding") {
                      return <strong className="preview-context">开发预览 · 未发布</strong>;
                    }
                    if (activeWorkItem?.requirementSequence) {
                      const sequence = `R${String(activeWorkItem.requirementSequence).padStart(3, "0")}`;
                      if (activeWorkItem.workflowState === "pending_release") {
                        return <strong className="preview-context">待上线预览 · {sequence}</strong>;
                      }
                      if (["development", "testing_admission", "testing"].includes(activeWorkItem.workflowState)) {
                        return <strong className="preview-context">开发预览 · {sequence}</strong>;
                      }
                    }
                    return currentCodeVersion
                      ? <strong className="preview-context">正式版本 · V{currentCodeVersion.sequence}</strong>
                      : null;
                  })()}
                  <span>
                    {(() => {
                      const current = previewHistory[previewIndex] ?? project.previewUrl ?? "/";
                      try {
                        const parsed = new URL(current, location.href);
                        return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
                      } catch {
                        return current.replace(`/preview/${project.id}`, "") || "/";
                      }
                    })()}
                  </span>
                  <button
                    aria-label="在新标签页打开"
                    onClick={() =>
                      window.open(
                        previewHistory[previewIndex] ?? project.previewUrl ?? "",
                        "_blank",
                        "noopener,noreferrer"
                      )
                    }
                  ><ExternalLink size={15} /></button>
                </div>
                {project.previewStatus === "ready" && project.previewUrl ? (
                  <iframe
                    key={`${previewKey}:${previewIndex}`}
                    ref={iframeRef}
                    sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
                    src={previewHistory[previewIndex] ?? project.previewUrl}
                    title={`${project.name} 预览`}
                  />
                ) : (
                  <div className="viewer-empty" role="status" aria-live="polite">
                    {project.previewStatus === "starting" && (
                      <RefreshCw className="preview-loading-icon" size={20} aria-hidden="true" />
                    )}
                    <h2>
                      {project.previewStatus === "failed"
                        ? "预览启动失败"
                        : project.previewStatus === "starting"
                          ? "正在启动预览"
                          : "预览尚未可用"}
                    </h2>
                    {project.previewError && (
                      <p className="preview-error-detail">{project.previewError}</p>
                    )}
                    <p>你仍可在文件和终端中查看生成结果。</p>
                    {project.previewCapable && (
                      <button
                        className="button secondary"
                        disabled={previewRetrying || project.previewStatus === "starting"}
                        onClick={async () => {
                          setPreviewRetrying(true);
                          try {
                            const updated = await api.retryPreview(guest.id, projectId);
                            setProject(updated);
                            if (updated.previewUrl) {
                              setPreviewHistory([updated.previewUrl]);
                              setPreviewIndex(0);
                            }
                          } finally {
                            setPreviewRetrying(false);
                          }
                        }}
                      >
                        {previewRetrying || project.previewStatus === "starting"
                          ? "正在重试…"
                          : "重试预览"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : viewer === "files" ? (
              <div className="files-viewer">
                <aside>
                  <div className="viewer-title">项目文件</div>
                  <FileTree
                    items={files}
                    selected={selectedPath}
                    onSelect={(path) => {
                      manualViewer.current = "files";
                      manualFileSelection.current = true;
                      void openFile(path, true);
                    }}
                  />
                </aside>
                <div className="file-pane">
                  <FileViewer
                    contentRef={fileContentRef}
                    error={fileViewerError}
                    file={fileView}
                    path={selectedPath}
                    state={fileViewerState}
                    streaming={Boolean(
                      fileView?.kind === "text" &&
                      streamingFiles.current.has(fileView.path)
                    )}
                    onScroll={(event) => {
                      if (
                        !workspaceAutoFollowRef.current ||
                        followingFilePath.current !== selectedPathRef.current
                      ) {
                        return;
                      }
                      const element = event.currentTarget;
                      if (
                        element.scrollHeight -
                          element.scrollTop -
                          element.clientHeight >
                        80
                      ) {
                        updateWorkspaceAutoFollow(false);
                      }
                    }}
                  />
                </div>
              </div>
            ) : viewer === "terminal" ? (
              <div className="terminal-viewer">
                <div className="terminal-title">终端</div>
                <div
                  className="terminal-output"
                  ref={terminalRef}
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    if (
                      workspaceAutoFollowRef.current &&
                      element.scrollHeight - element.scrollTop - element.clientHeight > 80
                    ) {
                      updateWorkspaceAutoFollow(false);
                    }
                    if (
                      element.scrollHeight - element.scrollTop - element.clientHeight <= 80
                    ) {
                      setNewTerminalOutput(false);
                    }
                  }}
                >
                  {actionItems.filter((item): item is CommandExecutionItem => item.type === "command_execution").map((item) => (
                    <div id={`terminal-${item.id}`} key={item.id}>
                      <div className="terminal-command">$ {item.command}</div>
                      <pre>{item.output}</pre>
                      {item.outputTruncated && (
                        <div className="terminal-truncated" role="status">
                          输出已截断（仅展示前 5 MB）
                        </div>
                      )}
                      {item.status !== "in_progress" && <div className={`terminal-result ${item.status}`}>[{item.status === "completed" ? "成功" : item.status === "cancelled" ? "已取消" : "失败"}{item.exitCode !== null ? ` · ${item.exitCode}` : ""}]</div>}
                    </div>
                  ))}
                  {!actionItems.some(({ type }) => type === "command_execution") && <div className="terminal-empty">终端输出会在智能体执行命令后显示。</div>}
                </div>
                {newTerminalOutput && (
                  <button
                    className="new-activity viewer"
                    onClick={() => {
                      const element = terminalRef.current;
                      if (element) element.scrollTop = element.scrollHeight;
                      setNewTerminalOutput(false);
                    }}
                  >
                    有新输出
                  </button>
                )}
              </div>
            ) : (
              <VersionViewer
                activeWorkItem={activeWorkItem}
                currentVersionId={currentCodeVersion?.id ?? null}
                guest={guest}
                onSelectNewWorkMode={(type) => {
                  setNextWorkType(type);
                  rememberWorkMode(type);
                }}
                projectId={projectId}
                refreshToken={versionRefresh}
              />
            )}
          </section>
        </div>
      </div>
      {confirmStop && (
        <div className="modal-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="stop-title">
            <button className="dialog-close" disabled={stopSubmitting} onClick={() => setConfirmStop(null)} aria-label="关闭"><X size={17} /></button>
            <h2 id="stop-title">停止当前任务？</h2>
            <p>已经产生的文件变化不会回滚；后续排队消息会暂停，直到你明确继续执行。</p>
            {stopError && <p className="dialog-error" role="alert" aria-live="assertive">{stopError}</p>}
            <div>
              <button className="button secondary" disabled={stopSubmitting} onClick={() => setConfirmStop(null)}>继续执行</button>
              <button
                className="button destructive"
                disabled={stopSubmitting}
                onClick={async () => {
                  setStopSubmitting(true);
                  setStopError("");
                  try {
                    const stopped = await api.stopTurn(
                      guest.id,
                      projectId,
                      confirmStop.turn.id,
                      {
                        confirmed: true,
                        revision: activeWorkItem!.revision,
                        idempotencyKey: crypto.randomUUID(),
                        source: confirmStop.source
                      }
                    );
                    mergeTurn(stopped);
                    setConfirmStop(null);
                  } catch (reason) {
                    setStopError(reason instanceof Error ? reason.message : "停止失败，请重试");
                  } finally {
                    setStopSubmitting(false);
                  }
                }}
              >
                {stopSubmitting ? "正在停止…" : "确认停止"}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingWorkCreation && (
        <div className="modal-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-work-title">
            <button className="dialog-close" onClick={() => setPendingWorkCreation(null)} aria-label="关闭"><X size={17} /></button>
            <h2 id="new-work-title">创建结构化需求？</h2>
            <p>确认后将分配新的 R 编号，并创建独立工作分支、对话与 session。</p>
            <div className="creation-summary">{pendingWorkCreation.text}</div>
            <div>
              <button className="button secondary" onClick={() => setPendingWorkCreation(null)}>取消</button>
              <button
                className="button primary"
                onClick={async () => {
                  try {
                    const created = await api.createWorkItem(
                      guest.id,
                      projectId,
                      pendingWorkCreation.text,
                      "structured_requirement",
                      pendingWorkCreation.images,
                      pendingWorkCreation.uploadIds,
                      pendingWorkCreation.source,
                      true
                    );
                    setActiveWorkItem(created.workItem);
                    setWorkItemModelLoaded(true);
                    beginViewerTurn(created.turn.id);
                    mergeTurn(created.turn);
                    setDraft("");
                    setPendingWorkCreation(null);
                    setComposerReset((current) => current + 1);
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : "需求创建失败");
                  }
                }}
              >
                确认创建
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingWorkAction && (
        <div className="modal-backdrop" role="presentation">
          <div
            className={`dialog${pendingWorkAction.action === "publish" ? " publish-dialog" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="work-action-title"
          >
            <button className="dialog-close" onClick={() => setPendingWorkAction(null)} aria-label="关闭"><X size={17} /></button>
            <h2 id="work-action-title">
              {pendingWorkAction.action === "return_to_stage" && pendingWorkAction.targetState
                ? `退回到「${workflowLabel[pendingWorkAction.targetState]}」阶段？`
                : "确认阶段操作？"}
            </h2>
            <p>{pendingWorkAction.message}</p>
            {pendingWorkAction.action === "publish" && (
              <div className="publish-fields">
                <label>
                  <span>版本标题</span>
                  <input
                    value={pendingWorkAction.title ?? ""}
                    onChange={(event) =>
                      setPendingWorkAction((current) =>
                        current ? { ...current, title: event.target.value } : current
                      )
                    }
                    maxLength={100}
                    autoFocus
                  />
                </label>
                <label>
                  <span>版本摘要</span>
                  <textarea
                    value={pendingWorkAction.summary ?? ""}
                    onChange={(event) =>
                      setPendingWorkAction((current) =>
                        current ? { ...current, summary: event.target.value } : current
                      )
                    }
                    maxLength={1_000}
                    rows={4}
                  />
                </label>
                <small>确认后将重新执行质量、敏感内容和预览门禁。</small>
              </div>
            )}
            {pendingWorkAction.action === "return_to_stage" &&
              pendingWorkAction.targetState &&
              activeWorkItem && (
                <div className="stage-transition" role="group" aria-label="阶段变更">
                  <span>
                    <small>当前阶段</small>
                    <strong>{workflowLabel[activeWorkItem.workflowState]}</strong>
                  </span>
                  <i aria-hidden="true">→</i>
                  <span>
                    <small>目标阶段</small>
                    <strong>{workflowLabel[pendingWorkAction.targetState]}</strong>
                  </span>
                </div>
              )}
            {(
              pendingWorkAction.action === "return_to_stage" ||
              pendingWorkAction.action === "abandon" ||
              pendingWorkAction.action === "discard"
            ) && (
              <label className="work-action-reason">
                <span>操作原因</span>
                <textarea
                  value={pendingWorkAction.reason ?? ""}
                  onChange={(event) =>
                    setPendingWorkAction((current) =>
                      current ? { ...current, reason: event.target.value } : current
                    )
                  }
                  maxLength={500}
                  rows={3}
                  placeholder="说明为什么需要执行此操作"
                />
              </label>
            )}
            <div>
              <button className="button secondary" onClick={() => setPendingWorkAction(null)}>取消</button>
              <button
                className={pendingWorkAction.action === "abandon" || pendingWorkAction.action === "discard" ? "button destructive" : "button primary"}
                onClick={() => void performWorkAction(
                  pendingWorkAction.action,
                  pendingWorkAction.source,
                  pendingWorkAction.targetState,
                  true,
                  pendingWorkAction.action === "publish"
                    ? {
                        title: pendingWorkAction.title,
                        summary: pendingWorkAction.summary
                      }
                    : {
                        reason: pendingWorkAction.reason
                      },
                  {
                    revision: pendingWorkAction.revision,
                    idempotencyKey: pendingWorkAction.idempotencyKey
                  }
                )}
                disabled={
                  pendingWorkAction.action === "publish" &&
                  !pendingWorkAction.title?.trim()
                  || (
                    (
                      pendingWorkAction.action === "return_to_stage" ||
                      pendingWorkAction.action === "abandon" ||
                      pendingWorkAction.action === "discard"
                    ) &&
                    !pendingWorkAction.reason?.trim()
                  )
                }
              >
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}
      {previewImage && (
        <div className="image-modal" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreviewImage(null)}>
          <button aria-label="关闭图片预览" onClick={() => setPreviewImage(null)}><X size={18} /></button>
          <img src={previewImage} alt="已发送图片预览" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </Shell>
  );
}
