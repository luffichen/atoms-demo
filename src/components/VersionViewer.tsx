import {
  Archive,
  ChevronRight,
  Code2,
  GitCommitHorizontal,
  History,
  ListTree,
  MessageSquare,
  TerminalSquare
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  CodeVersion,
  CodeVersionDetails,
  ConversationItem,
  ConversationTurn,
  FileTreeNode,
  FileView,
  Guest,
  WorkItem,
  WorkItemEvent
} from "../types";
import { FileTree } from "./FileTree";
import { FileViewer, type FileViewerState } from "./FileViewer";
import { Markdown } from "./Markdown";
import { LocalTime } from "./Time";

type Section = "current" | "versions" | "work";
type DetailMode = "code" | "conversation" | "terminal";
type CurrentTab = "overview" | "requirements" | "technical" | "changes" | "testing" | "release";
const CURRENT_TABS: CurrentTab[] = [
  "overview",
  "requirements",
  "technical",
  "changes",
  "testing",
  "release"
];

function flattenFiles(items: FileTreeNode[]): FileTreeNode[] {
  return items.flatMap((item) =>
    item.type === "directory" ? flattenFiles(item.children ?? []) : [item]
  );
}

function readSelection(defaultToCurrent = false): {
  section: Section;
  versionId: string | null;
  workItemId: string | null;
  detail: DetailMode | null;
  path: string | null;
  currentTab: CurrentTab;
} {
  const query = new URLSearchParams(location.search);
  const detail = query.get("detail");
  const requestedCurrentTab = query.get("tab") as CurrentTab | null;
  return {
    section:
      query.get("section") === "work"
        ? "work"
        : query.get("section") === "current" || (defaultToCurrent && !query.has("section"))
          ? "current"
          : "versions",
    versionId: query.get("version"),
    workItemId: query.get("workItem"),
    detail:
      detail === "conversation" || detail === "terminal" || detail === "code"
        ? detail
        : null,
    path: query.get("path"),
    currentTab:
      requestedCurrentTab && CURRENT_TABS.includes(requestedCurrentTab)
        ? requestedCurrentTab
        : "overview"
  };
}

function writeSelection(input: {
  section: Section;
  versionId?: string | null;
  workItemId?: string | null;
  detail: DetailMode;
  path?: string | null;
  currentTab?: CurrentTab;
}) {
  const url = new URL(location.href);
  url.searchParams.set("viewer", "versions");
  url.searchParams.set("section", input.section);
  url.searchParams.set("detail", input.detail);
  if (input.versionId) url.searchParams.set("version", input.versionId);
  else url.searchParams.delete("version");
  if (input.workItemId) url.searchParams.set("workItem", input.workItemId);
  else url.searchParams.delete("workItem");
  if (input.path) url.searchParams.set("path", input.path);
  else url.searchParams.delete("path");
  if (input.section === "current" && input.currentTab) {
    url.searchParams.set("tab", input.currentTab);
  } else {
    url.searchParams.delete("tab");
  }
  history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function workItemLabel(item: WorkItem): string {
  return `${item.requirementSequence ? `需求 ${item.requirementSequence}` : "直接编码"} · ${item.title}`;
}

function workflowStatus(item: WorkItem): string {
  if (item.workflowState === "published") return "已发布";
  if (item.workflowState === "abandoned") return "已放弃";
  return "进行中";
}

function HistoricalItem({ item }: { item: ConversationItem }) {
  if (item.type === "assistant_message") return <Markdown content={item.text} />;
  if (item.type === "reasoning_summary") {
    return (
      <details className="history-event">
        <summary>思考摘要</summary>
        <ul>{item.summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
      </details>
    );
  }
  if (item.type === "todo_list") {
    return (
      <div className="history-event">
        <strong>任务进度</strong>
        <ul>{item.todos.map((todo, index) => <li key={index}>{todo.content} · {todo.status}</li>)}</ul>
      </div>
    );
  }
  if (item.type === "command_execution") {
    return <div className="history-event"><strong>执行命令</strong><code>{item.command}</code></div>;
  }
  if (item.type === "file_change") {
    return <div className="history-event"><strong>文件{item.action === "create" ? "新建" : item.action === "delete" ? "删除" : "更新"}</strong><code>{item.path}</code></div>;
  }
  if (item.type === "tool_call") {
    return <div className="history-event"><strong>{item.description || item.toolName}</strong><span>{item.target}</span></div>;
  }
  return null;
}

function HistoricalConversation({
  guest,
  projectId,
  turns
}: {
  guest: Guest;
  projectId: string;
  turns: ConversationTurn[];
}) {
  return (
    <div className="historical-conversation">
      {turns.map((turn) => {
        const userMessage = turn.items.find((item) => item.type === "user_message");
        if (!userMessage || userMessage.type !== "user_message") return null;
        const replies = turn.items.filter((item) => item.type !== "user_message");
        return (
          <article className="historical-turn" key={turn.id}>
            <div className="historical-user-message">
              <header><strong>你</strong><LocalTime value={userMessage.createdAt} /></header>
              <p>{userMessage.text}</p>
              {userMessage.attachments.length > 0 && (
                <div className="historical-attachments">
                  {userMessage.attachments.map((attachment) => (
                    <a
                      href={api.attachmentUrl(
                        guest.id,
                        projectId,
                        turn.id,
                        userMessage.id,
                        attachment.id
                      )}
                      key={attachment.id}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {attachment.originalName}
                    </a>
                  ))}
                </div>
              )}
            </div>
            {replies.length > 0 && (
              <div className="historical-assistant-message">
                <header><strong>luffi · 工程师</strong></header>
                {replies.map((item) => <HistoricalItem item={item} key={item.id} />)}
              </div>
            )}
          </article>
        );
      })}
      {!turns.length && <div className="history-empty">该工作项没有对话记录。</div>}
    </div>
  );
}

function HistoricalTerminal({ turns }: { turns: ConversationTurn[] }) {
  const commands = turns
    .flatMap(({ items }) => items)
    .filter((item) => item.type === "command_execution");
  return (
    <div className="historical-terminal">
      {commands.map((item) => (
        <div key={item.id}>
          <div className="terminal-command">$ {item.command}</div>
          <pre>{item.output}</pre>
          <div className={`terminal-result ${item.status}`}>
            [{item.status === "completed" ? "成功" : item.status === "cancelled" ? "已取消" : item.status === "in_progress" ? "执行中" : "失败"}
            {item.exitCode !== null ? ` · ${item.exitCode}` : ""}]
          </div>
        </div>
      ))}
      {!commands.length && <div className="history-empty dark">该工作项没有终端记录。</div>}
    </div>
  );
}

function AuditTimeline({ events }: { events: WorkItemEvent[] }) {
  const labels: Record<string, string> = {
    created: "工作项创建",
    title_updated: "标题更新",
    transition: "阶段流转",
    confirmed_action: "二次确认",
    checkpoint: "内部检查点",
    stopped: "停止",
    retried: "重试",
    failed: "执行失败",
    publish_attempt: "发布尝试",
    publish_failed: "发布失败",
    published: "发布成功",
    abandoned: "放弃"
  };
  if (!events.length) return null;
  return (
    <ol className="audit-timeline" aria-label="工作审计时间线">
      {events.slice(-12).map((event) => (
        <li key={event.id}>
          <span>{labels[event.kind] ?? event.kind}</span>
          {event.fromState !== event.toState && event.toState ? (
            <small>{event.fromState ? `${event.fromState} → ` : ""}{event.toState}</small>
          ) : null}
          <LocalTime value={event.createdAt} />
        </li>
      ))}
    </ol>
  );
}

export function VersionViewer({
  guest,
  projectId,
  activeWorkItem = null,
  currentVersionId = null,
  onSelectNewWorkMode,
  refreshToken = 0
}: {
  guest: Guest;
  projectId: string;
  activeWorkItem?: WorkItem | null;
  currentVersionId?: string | null;
  onSelectNewWorkMode?: (type: WorkItem["type"]) => void;
  refreshToken?: number;
}) {
  const initialSelection = useRef(
    readSelection(activeWorkItem?.type === "structured_requirement")
  );
  const [versions, setVersions] = useState<CodeVersion[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [hasMoreVersions, setHasMoreVersions] = useState(false);
  const [hasMoreWorkItems, setHasMoreWorkItems] = useState(false);
  const [loadingMoreList, setLoadingMoreList] = useState(false);
  const [selected, setSelected] = useState<CodeVersion | null>(null);
  const [versionDetails, setVersionDetails] = useState<CodeVersionDetails | null>(null);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(
    initialSelection.current.workItemId
  );
  const [record, setRecord] = useState<{
    workItem: WorkItem;
    events: WorkItemEvent[];
    turns: ConversationTurn[];
    hasMore: boolean;
  } | null>(null);
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [file, setFile] = useState<FileView | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialSelection.current.path
  );
  const [fileState, setFileState] = useState<FileViewerState>("idle");
  const [fileError, setFileError] = useState("");
  const [diff, setDiff] = useState("");
  const [section, setSection] = useState<Section>(initialSelection.current.section);
  const [detail, setDetail] = useState<DetailMode>(
    initialSelection.current.detail ??
      (initialSelection.current.section === "work" ? "conversation" : "code")
  );
  const [currentTab, setCurrentTab] = useState<CurrentTab>(
    initialSelection.current.currentTab
  );
  const [currentDocuments, setCurrentDocuments] = useState<FileTreeNode[]>([]);
  const [loadingCurrentDocument, setLoadingCurrentDocument] = useState(false);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const fileRequestSequence = useRef(0);
  const recordRequestSequence = useRef(0);

  useEffect(() => {
    const restoreSelection = () => {
      const restored = readSelection(activeWorkItem?.type === "structured_requirement");
      setSection(restored.section);
      setDetail(restored.detail ?? (restored.section === "work" ? "conversation" : "code"));
      setSelectedWorkItemId(restored.workItemId);
      setCurrentTab(restored.currentTab);
      setSelectedPath(restored.path);
      if (restored.versionId) {
        const restoredVersion = versions.find(({ id }) => id === restored.versionId);
        if (restoredVersion) setSelected(restoredVersion);
      }
    };
    window.addEventListener("popstate", restoreSelection);
    return () => window.removeEventListener("popstate", restoreSelection);
  }, [activeWorkItem?.type, versions]);

  useEffect(() => {
    let disposed = false;
    Promise.all([
      api.versions(guest.id, projectId),
      api.workItems(guest.id, projectId)
    ]).then(async ([versionResult, workResult]) => {
      if (disposed) return;
      setVersions(versionResult.items);
      setWorkItems(workResult.items);
      setHasMoreVersions(versionResult.hasMore);
      setHasMoreWorkItems(workResult.hasMore);
      setSelected((current) => {
        if (current && versionResult.items.some(({ id }) => id === current.id)) return current;
        const requestedId = initialSelection.current.versionId;
        return versionResult.items.find(({ id }) => id === requestedId)
          ?? versionResult.items[0]
          ?? null;
      });
      const requestedVersionId = initialSelection.current.versionId;
      if (
        requestedVersionId &&
        !versionResult.items.some(({ id }) => id === requestedVersionId)
      ) {
        try {
          const result = await api.version(guest.id, projectId, requestedVersionId);
          if (!disposed) {
            setVersions((current) =>
              current.some(({ id }) => id === result.version.id)
                ? current
                : [result.version, ...current]
            );
            setSelected(result.version);
          }
        } catch (reason) {
          if (!disposed) {
            setError(reason instanceof Error ? reason.message : "指定的版本不存在");
          }
        }
      }
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "版本记录加载失败");
    });
    return () => {
      disposed = true;
    };
  }, [guest.id, projectId, refreshToken]);

  useEffect(() => {
    fileRequestSequence.current += 1;
    setFile(null);
    setSelectedPath(null);
    setFileState("idle");
    setFileError("");
    setDiff("");
    setVersionDetails(null);
    if (!selected) {
      setFiles([]);
      return;
    }
    const requestedPath = new URLSearchParams(location.search).get("path");
    void Promise.all([
      api.versionFiles(guest.id, projectId, selected.id),
      api.versionDiff(guest.id, projectId, selected.id),
      api.version(guest.id, projectId, selected.id)
    ]).then(([tree, result, details]) => {
      setFiles(tree.items);
      setDiff(result.diff);
      setVersionDetails(details);
      if (requestedPath) {
        setSelectedPath(requestedPath);
        setFileState("loading");
        void Promise.all([
          api.versionFile(guest.id, projectId, selected.id, requestedPath),
          api.versionDiff(guest.id, projectId, selected.id, requestedPath)
        ]).then(([restoredFile, restoredDiff]) => {
          setFile(restoredFile);
          setDiff(restoredDiff.diff);
          setFileState("ready");
        }).catch((reason) => {
          setFileError(reason instanceof Error ? reason.message : "历史文件不可用");
          setFileState("error");
        });
      }
    }).catch((reason) =>
      setError(reason instanceof Error ? reason.message : "版本内容加载失败")
    );
  }, [guest.id, projectId, selected]);

  const recordWorkItemId =
    section === "versions"
      ? selected?.workItemId ?? null
      : section === "work"
        ? selectedWorkItemId
        : null;

  useEffect(() => {
    recordRequestSequence.current += 1;
    const requestSequence = recordRequestSequence.current;
    setRecord(null);
    if (!recordWorkItemId) return;
    setLoadingRecord(true);
    setError("");
    void api.workItem(guest.id, projectId, recordWorkItemId)
      .then((result) => {
        if (recordRequestSequence.current !== requestSequence) return;
        setRecord({
          workItem: result.workItem,
          events: result.events ?? [],
          turns: result.turns.items,
          hasMore: result.turns.hasMore
        });
      })
      .catch((reason) => {
        if (recordRequestSequence.current === requestSequence) {
          setError(reason instanceof Error ? reason.message : "历史工作记录加载失败");
        }
      })
      .finally(() => {
        if (recordRequestSequence.current === requestSequence) setLoadingRecord(false);
      });
  }, [detail, guest.id, projectId, recordWorkItemId]);

  const openFile = async (path: string) => {
    if (
      (section === "versions" && !selected) ||
      (section === "work" && !selectedWorkItemId)
    ) return;
    const requestSequence = fileRequestSequence.current + 1;
    fileRequestSequence.current = requestSequence;
    setError("");
    setFile(null);
    setSelectedPath(path);
    setFileState("loading");
    setFileError("");
    try {
      const [nextFile, nextDiff] = await Promise.all([
        section === "work" && selectedWorkItemId
          ? api.workItemSnapshotFile(guest.id, projectId, selectedWorkItemId, path)
          : api.versionFile(guest.id, projectId, selected!.id, path),
        section === "work" && selectedWorkItemId
          ? api.workItemSnapshotDiff(guest.id, projectId, selectedWorkItemId)
          : api.versionDiff(guest.id, projectId, selected!.id, path)
      ]);
      if (fileRequestSequence.current !== requestSequence) return;
      setFile(nextFile);
      setDiff(nextDiff.diff);
      setFileState("ready");
      writeSelection({
        section,
        versionId: section === "versions" ? selected!.id : null,
        workItemId: section === "work" ? selectedWorkItemId : null,
        detail: "code",
        path
      });
    } catch (reason) {
      if (fileRequestSequence.current !== requestSequence) return;
      setFileError(reason instanceof Error ? reason.message : "文件加载失败");
      setFileState("error");
    }
  };

  const chooseVersion = (version: CodeVersion, nextDetail: DetailMode = "code") => {
    setSection("versions");
    setSelected(version);
    setDetail(nextDetail);
    writeSelection({ section: "versions", versionId: version.id, detail: nextDetail });
  };

  const chooseWorkItem = (workItem: WorkItem) => {
    setSection("work");
    setSelectedWorkItemId(workItem.id);
    setDetail("conversation");
    writeSelection({
      section: "work",
      workItemId: workItem.id,
      detail: "conversation"
    });
  };

  const chooseDetail = (nextDetail: DetailMode) => {
    setDetail(nextDetail);
    writeSelection({
      section,
      versionId: section === "versions" ? selected?.id : null,
      workItemId: section === "work" ? selectedWorkItemId : null,
      detail: nextDetail
    });
  };

  const selectedWorkItem = useMemo(
    () => workItems.find(({ id }) => id === selectedWorkItemId) ?? record?.workItem ?? null,
    [record?.workItem, selectedWorkItemId, workItems]
  );

  useEffect(() => {
    if (
      section !== "work" ||
      detail !== "code" ||
      !selectedWorkItem ||
      selectedWorkItem.type !== "structured_requirement"
    ) return;
    setFile(null);
    setSelectedPath(null);
    setFileState("idle");
    setError("");
    void Promise.all([
      api.workItemSnapshotFiles(guest.id, projectId, selectedWorkItem.id),
      api.workItemSnapshotDiff(guest.id, projectId, selectedWorkItem.id)
    ]).then(([tree, result]) => {
      setFiles(tree.items);
      setDiff(result.diff);
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "工作快照加载失败");
    });
  }, [detail, guest.id, projectId, section, selectedWorkItem]);

  const loadOlder = async () => {
    if (!record?.turns.length || !record.hasMore || loadingOlder) return;
    setLoadingOlder(true);
    setError("");
    try {
      const result = await api.workItem(
        guest.id,
        projectId,
        record.workItem.id,
        record.turns[0].sequence
      );
      setRecord((current) => current ? {
        ...current,
        turns: [...result.turns.items, ...current.turns],
        hasMore: result.turns.hasMore
      } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更早的历史记录加载失败");
    } finally {
      setLoadingOlder(false);
    }
  };

  const loadMoreVersions = async () => {
    if (!hasMoreVersions || loadingMoreList) return;
    setLoadingMoreList(true);
    try {
      const result = await api.versions(guest.id, projectId, versions.length);
      setVersions((current) => [
        ...current,
        ...result.items.filter((item) => !current.some(({ id }) => id === item.id))
      ]);
      setHasMoreVersions(result.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更多版本加载失败");
    } finally {
      setLoadingMoreList(false);
    }
  };

  const loadMoreWorkItems = async () => {
    if (!hasMoreWorkItems || loadingMoreList) return;
    setLoadingMoreList(true);
    try {
      const result = await api.workItems(guest.id, projectId, workItems.length);
      setWorkItems((current) => [
        ...current,
        ...result.items.filter((item) => !current.some(({ id }) => id === item.id))
      ]);
      setHasMoreWorkItems(result.hasMore);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更多工作记录加载失败");
    } finally {
      setLoadingMoreList(false);
    }
  };

  const publishedVersion = selectedWorkItem?.publishedVersionId
    ? versions.find(({ id }) => id === selectedWorkItem.publishedVersionId)
    : null;
  const abandonmentEvent = record?.events
    .slice()
    .reverse()
    .find(({ kind }) => kind === "abandoned");
  const stageOrder: WorkItem["workflowState"][] = [
    "requirements_discussion",
    "requirements_pending_confirmation",
    "technical_design",
    "technical_pending_confirmation",
    "development",
    "testing_admission",
    "testing",
    "pending_release",
    "published"
  ];
  const currentStageIndex = activeWorkItem
    ? stageOrder.indexOf(activeWorkItem.workflowState)
    : -1;
  const currentTabUnlocked =
    currentTab === "overview" ||
    (currentTab === "requirements" && activeWorkItem?.type === "structured_requirement") ||
    (currentTab === "technical" && currentStageIndex >= 2) ||
    (currentTab === "changes" && (activeWorkItem?.type === "direct_coding" || currentStageIndex >= 4)) ||
    (currentTab === "testing" && currentStageIndex >= 5) ||
    (currentTab === "release" && currentStageIndex >= 7);

  useEffect(() => {
    if (
      section !== "current" ||
      currentTab !== "changes" ||
      !activeWorkItem
    ) return;
    void api.workItemSnapshotDiff(guest.id, projectId, activeWorkItem.id)
      .then((result) => setDiff(result.diff))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "当前工作差异加载失败")
      );
  }, [activeWorkItem, currentTab, guest.id, projectId, section]);

  useEffect(() => {
    const isDocumentTab =
      currentTab === "requirements" ||
      currentTab === "technical" ||
      currentTab === "testing" ||
      currentTab === "release";
    if (
      section !== "current" ||
      !isDocumentTab ||
      !currentTabUnlocked ||
      !activeWorkItem ||
      activeWorkItem.type !== "structured_requirement"
    ) {
      setCurrentDocuments([]);
      return;
    }
    let disposed = false;
    setLoadingCurrentDocument(true);
    setError("");
    void api.workItemSnapshotFiles(guest.id, projectId, activeWorkItem.id)
      .then(({ items }) => {
        if (disposed) return;
        const allFiles = flattenFiles(items);
        const matching = allFiles.filter(({ path }) => {
          if (currentTab === "requirements") return path.startsWith("docs/requirements/");
          if (currentTab === "technical") {
            return path.startsWith("docs/technical/") || path === "docs/technical-decisions.md";
          }
          if (currentTab === "testing") return path.startsWith("docs/test-reports/");
          return path.startsWith("docs/releases/");
        });
        setCurrentDocuments(matching);
        const requestedPath = selectedPath && matching.some(({ path }) => path === selectedPath)
          ? selectedPath
          : matching[0]?.path;
        if (!requestedPath) return;
        setSelectedPath(requestedPath);
        setFileState("loading");
        return api.workItemSnapshotFile(
          guest.id,
          projectId,
          activeWorkItem.id,
          requestedPath
        ).then((result) => {
          if (disposed) return;
          setFile(result);
          setFileState("ready");
        });
      })
      .catch((reason) => {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : "当前工作文档加载失败");
        setFileState("error");
      })
      .finally(() => {
        if (!disposed) setLoadingCurrentDocument(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    activeWorkItem,
    currentTab,
    currentTabUnlocked,
    guest.id,
    projectId,
    section
  ]);

  const openCurrentDocument = async (path: string) => {
    if (!activeWorkItem || activeWorkItem.type !== "structured_requirement") return;
    setSelectedPath(path);
    setFileState("loading");
    writeSelection({
      section: "current",
      workItemId: activeWorkItem.id,
      detail: "code",
      path,
      currentTab
    });
    try {
      setFile(await api.workItemSnapshotFile(guest.id, projectId, activeWorkItem.id, path));
      setFileState("ready");
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : "当前工作文档不可用");
      setFileState("error");
    }
  };

  const returnToCurrentCode = () => {
    const url = new URL(location.href);
    url.searchParams.set("viewer", "files");
    for (const key of ["section", "version", "workItem", "detail", "path"]) {
      url.searchParams.delete(key);
    }
    history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="version-viewer">
      <aside className="version-sidebar">
        <div className="version-section-switch">
          <button
            className={section === "current" ? "active" : ""}
            onClick={() => {
              setSection("current");
              setCurrentTab("overview");
              writeSelection({ section: "current", workItemId: activeWorkItem?.id, detail: "code" });
            }}
          >
            <GitCommitHorizontal size={15} /> 当前工作
          </button>
          <button
            className={section === "versions" ? "active" : ""}
            onClick={() => {
              setSection("versions");
              setDetail("code");
              writeSelection({ section: "versions", versionId: selected?.id, detail: "code" });
            }}
          >
            <History size={15} /> 正式版本
          </button>
          <button
            className={section === "work" ? "active" : ""}
            onClick={() => {
              setSection("work");
              const item = selectedWorkItem ?? workItems[0] ?? null;
              setSelectedWorkItemId(item?.id ?? null);
              setDetail("conversation");
              writeSelection({ section: "work", workItemId: item?.id, detail: "conversation" });
            }}
          >
            <ListTree size={15} /> 工作记录
          </button>
        </div>
        {section === "current" ? (
          <div className="current-work-summary">
            {activeWorkItem ? (
              <>
                <strong>{workItemLabel(activeWorkItem)}</strong>
                <small>{workflowStatus(activeWorkItem)} · {activeWorkItem.workflowState}</small>
              </>
            ) : (
              <p className="version-empty">当前没有活动工作</p>
            )}
          </div>
        ) : section === "versions" ? (
          <div className="version-list">
            {versions.map((version) => (
              <button
                key={version.id}
                className={selected?.id === version.id ? "active" : ""}
                onClick={() => chooseVersion(version)}
              >
                <GitCommitHorizontal size={16} />
                <span>
                  <strong>V{version.sequence} · {version.title}</strong>
                  <small>
                    {version.sourceType === "structured_requirement"
                      ? `结构化需求 · R${String(version.requirementSequence).padStart(3, "0")}`
                      : "直接编码"}
                    {version.id === currentVersionId ? " · 当前正式版本" : ""}
                  </small>
                  <small><LocalTime value={version.publishedAt} /></small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
            {hasMoreVersions && (
              <button className="version-load-more" disabled={loadingMoreList} onClick={() => void loadMoreVersions()}>
                {loadingMoreList ? "正在加载…" : "加载更多版本"}
              </button>
            )}
            {!versions.length && <p className="version-empty">尚未发布正式版本</p>}
          </div>
        ) : (
          <div className="work-record-list">
            {workItems.map((item) => (
              <button
                key={item.id}
                className={selectedWorkItemId === item.id ? "active" : ""}
                onClick={() => chooseWorkItem(item)}
              >
                <Archive size={15} />
                <span>
                  <strong>{workItemLabel(item)}</strong>
                  <small>{workflowStatus(item)} · <LocalTime value={item.updatedAt} /></small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
            {hasMoreWorkItems && (
              <button className="version-load-more" disabled={loadingMoreList} onClick={() => void loadMoreWorkItems()}>
                {loadingMoreList ? "正在加载…" : "加载更多记录"}
              </button>
            )}
            {!workItems.length && <p className="version-empty">尚无工作记录</p>}
          </div>
        )}
      </aside>
      <div className="version-content">
        {section === "current" && activeWorkItem ? (
          <>
            <header>
              <div>
                <h2>{workItemLabel(activeWorkItem)}</h2>
                <p>{workflowStatus(activeWorkItem)} · {activeWorkItem.executionState}</p>
              </div>
              <span className="readonly-badge">当前工作</span>
            </header>
            <div className="current-work-tabs" role="tablist" aria-label="当前工作详情">
              {([
                ["overview", "概览"],
                ["requirements", "需求"],
                ["technical", "技术方案"],
                ["changes", "变更"],
                ["testing", "测试"],
                ["release", "发布"]
              ] as Array<[CurrentTab, string]>).map(([tab, label]) => (
                <button
                  key={tab}
                  className={currentTab === tab ? "active" : ""}
                  onClick={() => {
                    setCurrentTab(tab);
                    setSelectedPath(null);
                    writeSelection({
                      section: "current",
                      workItemId: activeWorkItem.id,
                      detail: "code",
                      currentTab: tab
                    });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="current-work-content">
              {!currentTabUnlocked ? (
                <div className="viewer-empty compact">
                  <h3>该阶段尚未解锁</h3>
                  <p>完成前置阶段后，这里的文档与证据会自动开放。</p>
                </div>
              ) : currentTab === "overview" ? (
                <dl className="version-metadata">
                  <div><dt>类型</dt><dd>{activeWorkItem.type === "structured_requirement" ? "结构化需求" : "直接编码"}</dd></div>
                  <div><dt>阶段</dt><dd>{activeWorkItem.workflowState}</dd></div>
                  <div><dt>执行状态</dt><dd>{activeWorkItem.executionState}</dd></div>
                  <div><dt>基线</dt><dd><code>{activeWorkItem.baseCommit.slice(0, 10)}</code></dd></div>
                  <div><dt>创建时间</dt><dd><LocalTime value={activeWorkItem.createdAt} /></dd></div>
                </dl>
              ) : currentTab === "changes" ? (
                <pre className="version-diff">{diff || "当前尚无受跟踪变更"}</pre>
              ) : (
                <div className="current-document-view">
                  <h3>{({
                    requirements: "需求文档",
                    technical: "技术方案",
                    testing: "测试证据",
                    release: "发布记录"
                  } as Partial<Record<CurrentTab, string>>)[currentTab]}</h3>
                  {loadingCurrentDocument ? (
                    <p role="status">正在加载文档…</p>
                  ) : currentDocuments.length ? (
                    <div className="current-document-layout">
                      <nav aria-label="当前工作文档">
                        {currentDocuments.map(({ path }) => (
                          <button
                            className={selectedPath === path ? "active" : ""}
                            key={path}
                            onClick={() => void openCurrentDocument(path)}
                          >
                            {path}
                          </button>
                        ))}
                      </nav>
                      <FileViewer
                        error={fileError}
                        file={file}
                        path={selectedPath}
                        state={fileState}
                      />
                    </div>
                  ) : (
                    <p>该阶段尚未生成版本化文档。</p>
                  )}
                </div>
              )}
            </div>
          </>
        ) : section === "versions" && selected ? (
          <>
            <header>
              <div>
                <h2>V{selected.sequence} · {selected.title}</h2>
                <p>{selected.summary || "未填写版本说明"}</p>
              </div>
              <div className="version-header-actions">
                {selected.id === currentVersionId && <span className="current-version-badge">当前正式版本</span>}
                <code>{selected.commitSha.slice(0, 10)}</code>
              </div>
            </header>
            {versionDetails && (
              <div className="version-overview">
                <dl className="version-metadata">
                  <div><dt>来源</dt><dd>{selected.sourceType === "structured_requirement" ? "结构化需求" : "直接编码"}</dd></div>
                  <div><dt>需求</dt><dd>{selected.requirementSequence ? `R${String(selected.requirementSequence).padStart(3, "0")}` : "不适用"}</dd></div>
                  <div><dt>状态</dt><dd>已发布</dd></div>
                  <div><dt>上线时间</dt><dd><LocalTime value={selected.publishedAt} /></dd></div>
                  <div><dt>发起游客</dt><dd>{versionDetails.initiatedGuest?.name ?? "未知"}</dd></div>
                  <div><dt>确认游客</dt><dd>{versionDetails.confirmedGuest?.name ?? "未知"}</dd></div>
                  <div><dt>Git tag</dt><dd><code>{selected.tagRef.replace("refs/tags/", "")}</code></dd></div>
                  <div><dt>基线版本</dt><dd>{versionDetails.baseVersion ? `V${versionDetails.baseVersion.sequence}` : "初始化基线"}</dd></div>
                  <div>
                    <dt>文件变化</dt>
                    <dd>
                      +{versionDetails.fileStats.added} · ~{versionDetails.fileStats.modified} ·
                      -{versionDetails.fileStats.deleted} · ↪{versionDetails.fileStats.renamed}
                    </dd>
                  </div>
                </dl>
                <div className="version-documents">
                  <strong>交付文档</strong>
                  {Object.values(versionDetails.documents).flat().length ? (
                    <ul>
                      {Object.values(versionDetails.documents).flat().map((path) => (
                        <li key={path}><code>{path}</code></li>
                      ))}
                    </ul>
                  ) : (
                    <p>
                      {selected.sourceType === "direct_coding"
                        ? "直接编码版本不要求需求文档、技术方案或测试报告。"
                        : "该版本未包含结构化交付文档。"}
                    </p>
                  )}
                </div>
                <div className="version-documents">
                  <strong>变更文件</strong>
                  {versionDetails.changes.length ? (
                    <ul>
                      {versionDetails.changes.map((change) => (
                        <li key={`${change.status}:${change.path}`}>
                          <span aria-label={`状态 ${change.status}`}>{change.status}</span>{" "}
                          <button
                            className="inline-path-button"
                            onClick={() => {
                              setDetail("code");
                              void openFile(change.path);
                            }}
                          >
                            <code>{change.path}</code>
                          </button>
                          {change.previousPath ? <small>（原路径 {change.previousPath}）</small> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>该版本与基线之间没有文件变化。</p>
                  )}
                </div>
              </div>
            )}
            <div className="history-detail-tabs" role="tablist" aria-label="版本详情">
              <button className={detail === "code" ? "active" : ""} onClick={() => chooseDetail("code")}><Code2 size={15} /> 版本内容</button>
              <button className={detail === "conversation" ? "active" : ""} onClick={() => chooseDetail("conversation")}><MessageSquare size={15} /> 工作对话</button>
              <button className={detail === "terminal" ? "active" : ""} onClick={() => chooseDetail("terminal")}><TerminalSquare size={15} /> 终端</button>
            </div>
            {detail === "code" ? (
              <>
                <div className="snapshot-banner" role="status">
                  <span>正在查看 V{selected.sequence} 的只读代码快照</span>
                  <button className="button secondary compact" onClick={returnToCurrentCode}>
                    返回当前代码
                  </button>
                </div>
                <div className="version-code-layout">
                <aside>
                  <div className="viewer-title">版本文件</div>
                  <FileTree items={files} selected={selectedPath} onSelect={(path) => void openFile(path)} />
                </aside>
                <div className="version-inspection">
                  <section>
                    {selectedPath ? (
                      <FileViewer
                        error={fileError}
                        file={file}
                        path={selectedPath}
                        state={fileState}
                      />
                    ) : (
                      <>
                        <h3>版本变更</h3>
                        <pre className="version-diff">{diff || "该版本没有文本差异"}</pre>
                      </>
                    )}
                  </section>
                  {selectedPath && fileState === "ready" && (
                    <section>
                      <h3>相对上一版本的差异</h3>
                      <pre className="version-diff">{diff || "无文本差异"}</pre>
                    </section>
                  )}
                </div>
                </div>
              </>
            ) : (
              <div className="history-record-content">
                {record?.hasMore && (
                  <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
                    {loadingOlder ? "正在加载…" : "加载更早记录"}
                  </button>
                )}
                {loadingRecord
                  ? <div className="center-state"><span className="spinner dark" /> 正在加载工作记录…</div>
                  : detail === "conversation"
                    ? <HistoricalConversation guest={guest} projectId={projectId} turns={record?.turns ?? []} />
                    : <HistoricalTerminal turns={record?.turns ?? []} />}
              </div>
            )}
          </>
        ) : section === "work" && selectedWorkItem ? (
          <>
            <header>
              <div>
                <h2>{workItemLabel(selectedWorkItem)}</h2>
                <p>
                  {workflowStatus(selectedWorkItem)} · 归档工作记录只读 · 创建于{" "}
                  <LocalTime value={selectedWorkItem.createdAt} />
                  {selectedWorkItem.archivedAt && <> · 结束于 <LocalTime value={selectedWorkItem.archivedAt} /></>}
                </p>
              </div>
              <div className="version-header-actions">
                {publishedVersion && (
                  <button className="button secondary compact" onClick={() => chooseVersion(publishedVersion)}>
                    查看 V{publishedVersion.sequence}
                  </button>
                )}
                <button className="button secondary compact" onClick={returnToCurrentCode}>
                  {activeWorkItem ? "返回当前工作" : "开始新工作"}
                </button>
              </div>
            </header>
            {selectedWorkItem.workflowState === "abandoned" && (
              <div className="abandonment-summary">
                <strong>已放弃</strong>
                <span>
                  原因：
                  {typeof abandonmentEvent?.details.reason === "string"
                    ? abandonmentEvent.details.reason
                    : "未记录"}
                </span>
                {selectedWorkItem.archivedAt && <LocalTime value={selectedWorkItem.archivedAt} />}
              </div>
            )}
            <AuditTimeline events={record?.events ?? []} />
            <div className="history-detail-tabs" role="tablist" aria-label="工作记录详情">
              <button className={detail === "conversation" ? "active" : ""} onClick={() => chooseDetail("conversation")}><MessageSquare size={15} /> 对话</button>
              <button className={detail === "terminal" ? "active" : ""} onClick={() => chooseDetail("terminal")}><TerminalSquare size={15} /> 终端</button>
              {selectedWorkItem.type === "structured_requirement" &&
                selectedWorkItem.workflowState === "abandoned" && (
                  <button className={detail === "code" ? "active" : ""} onClick={() => chooseDetail("code")}>
                    <Code2 size={15} /> 放弃快照
                  </button>
                )}
            </div>
            {detail === "code" ? (
              <div className="version-code-layout abandoned-snapshot">
                <aside>
                  <div className="viewer-title">最后快照文件</div>
                  <FileTree items={files} selected={selectedPath} onSelect={(path) => void openFile(path)} />
                </aside>
                <div className="version-inspection">
                  <section>
                    {selectedPath ? (
                      <FileViewer error={fileError} file={file} path={selectedPath} state={fileState} />
                    ) : (
                      <>
                        <h3>相对基线 Diff</h3>
                        <pre className="version-diff">{diff || "快照与基线无差异"}</pre>
                      </>
                    )}
                  </section>
                </div>
              </div>
            ) : <div className="history-record-content">
              {record?.hasMore && (
                <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {loadingOlder ? "正在加载…" : "加载更早记录"}
                </button>
              )}
              {loadingRecord
                ? <div className="center-state"><span className="spinner dark" /> 正在加载工作记录…</div>
                : detail === "terminal"
                  ? <HistoricalTerminal turns={record?.turns ?? []} />
                  : <HistoricalConversation guest={guest} projectId={projectId} turns={record?.turns ?? []} />}
            </div>}
          </>
        ) : (
          <div className="viewer-empty">
            <h2>
              {section === "current"
                ? "开始新的工作"
                : section === "versions"
                  ? "尚未发布代码版本"
                  : "尚无工作记录"}
            </h2>
            <p>
              {section === "current"
                ? "选择模式后，在输入框中描述本次工作的目标。"
                : section === "versions"
                  ? "完成当前工作后，可在输入框上方发布 V1。"
                  : "开始工作后，对话和终端记录会保留在这里。"}
            </p>
            {section === "current" && (
              <div className="empty-work-actions">
                <button className="button secondary" onClick={() => onSelectNewWorkMode?.("direct_coding")}>
                  直接编码
                </button>
                <button className="button primary" onClick={() => onSelectNewWorkMode?.("structured_requirement")}>
                  按需求研发
                </button>
              </div>
            )}
          </div>
        )}
        {error && <p className="error-text version-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
