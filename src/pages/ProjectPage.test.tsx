import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantMessageItem,
  CommandExecutionItem,
  ConversationTurn,
  FileChangeItem,
  Guest,
  Project,
  TodoListItem,
  ToolCallItem,
  UserMessageItem,
  WorkItem
} from "../types";

const apiMock = vi.hoisted(() => ({
  project: vi.fn(),
  files: vi.fn(),
  file: vi.fn(),
  olderMessages: vi.fn(),
  createWorkItem: vi.fn(),
  updateWorkItemTitle: vi.fn(),
  sendMessage: vi.fn(),
  cancelTurn: vi.fn(),
  stopTurn: vi.fn(),
  retryPreview: vi.fn(),
  workItemAction: vi.fn(),
  attachmentUrl: vi.fn(),
  versions: vi.fn(),
  version: vi.fn(),
  workItems: vi.fn(),
  versionFiles: vi.fn(),
  versionDiff: vi.fn(),
  versionFile: vi.fn(),
  workItem: vi.fn(),
  workItemSnapshotFiles: vi.fn(),
  workItemSnapshotFile: vi.fn(),
  workItemSnapshotDiff: vi.fn()
}));

vi.mock("../api", () => ({ api: apiMock }));

import { ProjectPage } from "./ProjectPage";

async function findCodeLine(text: string): Promise<HTMLElement> {
  let match: HTMLElement | undefined;
  await waitFor(() => {
    match = [...document.querySelectorAll<HTMLElement>(".code-line code")].find(
      (element) => element.textContent === text
    );
    expect(match).toBeDefined();
  });
  return match!;
}

function hasCodeLine(text: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(".code-line code")].some(
    (element) => element.textContent === text
  );
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  private messageHandler: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  get onmessage() {
    return this.messageHandler;
  }

  set onmessage(handler: ((event: { data: string }) => void) | null) {
    this.messageHandler = handler;
    if (handler) FakeWebSocket.instances = [this];
  }

  send() {}
  close() {
    this.onclose?.();
  }
  receive(envelope: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(envelope) });
    });
  }
}

const guest: Guest = { id: "guest-1", name: "default", createdAt: "2026-01-01T00:00:00Z" };
const project: Project = {
  id: "project-1",
  guestId: guest.id,
  name: "验收项目",
  previewCapable: true,
  previewStatus: "ready",
  previewUrl: "about:blank",
  previewError: null,
  thumbnailUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z"
};
const userItem: UserMessageItem = {
  id: "item-user",
  projectId: project.id,
  turnId: "turn-1",
  ordinal: 1,
  type: "user_message",
  status: "completed",
  text: "创建网页",
  attachments: [],
  createdAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:00Z"
};
const assistantItem: AssistantMessageItem = {
  id: "item-assistant",
  projectId: project.id,
  turnId: "turn-1",
  ordinal: 2,
  type: "assistant_message",
  phase: "final_answer",
  status: "completed",
  text: "已完成 **网页**。",
  createdAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:01Z"
};
const fileItem: FileChangeItem = {
  id: "item-file",
  projectId: project.id,
  turnId: "turn-1",
  ordinal: 3,
  type: "file_change",
  action: "create",
  path: "index.html",
  description: "创建网站首页",
  contentSnapshot: "<main />",
  output: "",
  status: "completed",
  createdAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:01Z"
};
const commandItem: CommandExecutionItem = {
  id: "item-command",
  projectId: project.id,
  turnId: "turn-1",
  ordinal: 3,
  type: "command_execution",
  command: "printf first; printf second",
  description: "验证命令输出",
  output: "",
  exitCode: null,
  status: "in_progress",
  createdAt: "2026-01-01T00:00:00Z",
  completedAt: null
};
const toolItem: ToolCallItem = {
  id: "item-tool",
  projectId: project.id,
  turnId: "turn-1",
  ordinal: 3,
  type: "tool_call",
  toolName: "inspect_project",
  target: "",
  description: "检查项目结构和关键配置",
  output: "",
  status: "completed",
  createdAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:01Z"
};
const todoItem: TodoListItem = {
  id: "item-todo",
  projectId: project.id,
  turnId: "turn-1",
  ordinal: 2,
  type: "todo_list",
  status: "completed",
  todos: [
    { content: "分析需求", status: "completed" },
    { content: "实现功能", status: "in_progress" },
    { content: "运行测试", status: "pending" }
  ],
  createdAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:01Z"
};
const turn: ConversationTurn = {
  id: "turn-1",
  projectId: project.id,
  sequence: 1,
  status: "completed",
  error: null,
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:01Z",
  items: [userItem, assistantItem, fileItem]
};

function projectResponse(items: ConversationTurn[] = [turn]) {
  return {
    project,
    turns: { items, hasMore: false, nextCursor: null }
  };
}

describe("ProjectPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    FakeWebSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket
    });
    apiMock.files.mockResolvedValue({
      items: [{ name: "index.html", path: "index.html", type: "file", change: "new" }]
    });
    apiMock.file.mockResolvedValue({
      kind: "text",
      name: "index.html",
      path: "index.html",
      size: 10,
      content: "<main />",
      language: "html"
    });
    apiMock.versions.mockResolvedValue({ items: [], hasMore: false });
    apiMock.workItems.mockResolvedValue({ items: [], hasMore: false });
  });

  it("活动工作可以修改标题并使用当前修订号提交", async () => {
    const activeWorkItem: WorkItem = {
      id: "work-title",
      projectId: project.id,
      type: "direct_coding",
      requirementSequence: null,
      title: "旧标题",
      workflowState: "direct_coding",
      executionState: "idle",
      baseCommit: "base",
      branchRef: "refs/heads/work/title",
      revision: 4,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
      publishedVersionId: null
    };
    apiMock.project.mockResolvedValue({ ...projectResponse(), activeWorkItem });
    apiMock.updateWorkItemTitle.mockResolvedValue({
      ...activeWorkItem,
      title: "新标题",
      revision: 5
    });
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "修改工作标题" }));
    const editor = screen.getByRole("dialog", { name: "修改工作标题" });
    fireEvent.change(within(editor).getByRole("textbox"), {
      target: { value: "新标题" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(apiMock.updateWorkItemTitle).toHaveBeenCalledWith(
        guest.id,
        project.id,
        activeWorkItem.id,
        "新标题",
        4
      )
    );
    expect(await screen.findByText(/新标题/)).toBeInTheDocument();
  });

  it("无活动工作时自然语言新建需求必须二次确认且不提前创建", async () => {
    apiMock.project.mockResolvedValue({ ...projectResponse([]), activeWorkItem: null });
    const createdWorkItem = {
      id: "work-new",
      projectId: project.id,
      type: "structured_requirement",
      requirementSequence: 2,
      title: "移动端适配",
      workflowState: "requirements_discussion",
      executionState: "idle",
      baseCommit: "base",
      branchRef: "refs/heads/work/new",
      revision: 1,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    apiMock.createWorkItem.mockResolvedValue({
      workItem: createdWorkItem,
      turn: { ...turn, id: "turn-new", workItemId: createdWorkItem.id }
    });
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    fireEvent.change(await screen.findByPlaceholderText("描述要继续修改的内容"), {
      target: { value: "新建需求：移动端适配" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("dialog", { name: "创建结构化需求？" })).toBeInTheDocument();
    expect(apiMock.createWorkItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    await waitFor(() =>
      expect(apiMock.createWorkItem).toHaveBeenCalledWith(
        guest.id,
        project.id,
        "移动端适配",
        "structured_requirement",
        [],
        [],
        "natural_language",
        true
      )
    );
  });

  it("预览失败时展示具体原因，启动中状态使用动态反馈", async () => {
    apiMock.project.mockResolvedValue({
      ...projectResponse(),
      project: {
        ...project,
        previewStatus: "failed",
        previewUrl: null,
        previewError: "依赖安装失败\n缺少 next-intl"
      }
    });
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(screen.getByRole("heading", { name: "预览启动失败" })).toBeInTheDocument();
    expect(screen.getByText(/依赖安装失败/)).toHaveClass("preview-error-detail");

    FakeWebSocket.instances[0].receive({
      kind: "preview",
      data: {
        ...project,
        previewStatus: "starting",
        previewUrl: null,
        previewError: null
      }
    });
    expect(await screen.findByRole("heading", { name: "正在启动预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在重试…" })).toBeDisabled();
  });

  it("直接进入文件模式时自动打开项目根目录 README", async () => {
    apiMock.project.mockResolvedValue({
      ...projectResponse(),
      project: { ...project, previewStatus: "idle", previewUrl: null }
    });
    apiMock.files.mockResolvedValue({
      items: [
        { name: "src", path: "src", type: "directory", children: [] },
        { name: "README.md", path: "README.md", type: "file" }
      ]
    });
    apiMock.file.mockResolvedValue({
      kind: "text",
      name: "README.md",
      path: "README.md",
      size: 8,
      content: "# 项目",
      language: "markdown"
    });

    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await waitFor(() => {
      expect(apiMock.file).toHaveBeenCalledWith(guest.id, project.id, "README.md");
    });
    expect(screen.getByRole("region", { name: "文件内容：README.md" })).toBeInTheDocument();
  });

  it("手动重新连接不刷新页面并保留当前草稿", async () => {
    apiMock.project.mockResolvedValue(projectResponse());
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    const input = await screen.findByPlaceholderText("描述要继续修改的内容");
    fireEvent.change(input, { target: { value: "不要丢失的草稿" } });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const initialSocket = FakeWebSocket.instances[0];
    initialSocket.onclose?.();
    now.mockReturnValue(60_002);
    initialSocket.onclose?.();

    fireEvent.click(await screen.findByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(FakeWebSocket.instances[0]).not.toBe(initialSocket));
    expect(screen.getByDisplayValue("不要丢失的草稿")).toBeInTheDocument();
    now.mockRestore();
  });

  it("在工作流栏明确显示测试准入且不提前提供测试完成动作", async () => {
    const activeWorkItem = {
      id: "work-1",
      projectId: project.id,
      type: "structured_requirement",
      requirementSequence: 8,
      title: "测试准入",
      workflowState: "testing_admission",
      executionState: "running",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-1",
      revision: 1,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    apiMock.project.mockResolvedValue({
      ...projectResponse([{ ...turn, status: "running", completedAt: null }]),
      activeWorkItem
    });

    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );

    expect(
      await screen.findByText("R008 · 测试准入 · 执行中 · 测试准入")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "测试完成" })).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "更多工作操作" });
    expect(more).toBeDisabled();
    expect(more).toHaveAttribute("aria-describedby", "workflow-disabled-reason");
    expect(screen.getByRole("status")).toHaveTextContent(
      "当前任务正在执行，完成后即可流转；如需中断，请先停止当前任务。"
    );
  });

  it("自然语言动作严格按短语映射并展示结构化流转建议", async () => {
    const activeWorkItem = {
      id: "work-strict-intent",
      projectId: project.id,
      type: "structured_requirement",
      requirementSequence: 9,
      title: "严格动作映射",
      workflowState: "development",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-strict-intent",
      revision: 4,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    apiMock.project.mockResolvedValue({
      ...projectResponse(),
      activeWorkItem
    });
    apiMock.workItemAction.mockRejectedValue(
      Object.assign(
        new Error("无法确认需求：当前处于「开发」，该操作仅可在「需求讨论」执行。"),
        {
          details: {
            kind: "workflow_transition",
            actionLabel: "确认需求",
            currentStateLabel: "开发",
            allowedStateLabels: ["需求讨论"],
            guidance: "请先完成当前「开发」阶段，并在进入「需求讨论」后重试。"
          }
        }
      )
    );
    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "确认需求" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(apiMock.workItemAction).toHaveBeenCalledWith(
        guest.id,
        project.id,
        activeWorkItem.id,
        expect.objectContaining({
          action: "confirm_requirements",
          source: "natural_language"
        })
      )
    );
    expect(apiMock.workItemAction).not.toHaveBeenCalledWith(
      guest.id,
      project.id,
      activeWorkItem.id,
      expect.objectContaining({ action: "start_testing" })
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("暂时无法确认需求");
    expect(alert).toHaveTextContent("当前处于「开发」");
    expect(alert).toHaveTextContent("请先完成当前「开发」阶段");
  });

  it("直接编码完成后通过实时状态解锁发布，无需刷新页面", async () => {
    const runningWorkItem = {
      id: "work-direct",
      projectId: project.id,
      type: "direct_coding",
      requirementSequence: null,
      title: "世界杯网站",
      workflowState: "direct_coding",
      executionState: "running",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-direct",
      revision: 3,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    const runningTurn = {
      ...turn,
      status: "running",
      completedAt: null
    } satisfies ConversationTurn;
    apiMock.project.mockResolvedValue({
      ...projectResponse([runningTurn]),
      activeWorkItem: runningWorkItem
    });
    apiMock.workItemAction.mockResolvedValue({
      confirmationRequired: true,
      action: "publish",
      message: "将创建不可变正式代码版本",
      suggestedTitle: "世界杯网站",
      suggestedSummary: "发布直接编码改动"
    });

    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );

    const publish = await screen.findByRole("button", { name: "发布版本" });
    expect(publish).toBeDisabled();
    expect(
      screen.getByText("编码工作 · 直接编码 · 执行中 · 世界杯网站")
    ).toBeInTheDocument();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => {
      FakeWebSocket.instances[0].receive({
        kind: "turn_completed",
        data: {
          ...runningTurn,
          status: "completed",
          completedAt: "2026-01-01T00:00:02Z"
        }
      });
      FakeWebSocket.instances[0].receive({
        kind: "work_item_updated",
        data: {
          ...runningWorkItem,
          executionState: "idle",
          revision: 4,
          updatedAt: "2026-01-01T00:00:02Z"
        }
      });
    });

    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    await waitFor(() =>
      expect(apiMock.workItemAction).toHaveBeenCalledWith(
        guest.id,
        project.id,
        runningWorkItem.id,
        expect.objectContaining({
          action: "publish",
          revision: 4
        })
      )
    );
  });

  it("退回确认弹框明确展示当前阶段和目标阶段", async () => {
    const activeWorkItem = {
      id: "work-1",
      projectId: project.id,
      type: "structured_requirement",
      requirementSequence: 8,
      title: "开发世界杯网站",
      workflowState: "development",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-1",
      revision: 1,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    apiMock.project.mockResolvedValue({ ...projectResponse(), activeWorkItem });
    apiMock.workItemAction.mockResolvedValue({
      confirmationRequired: true,
      action: "return_to_stage",
      targetState: "technical_design",
      message: "将从「开发」退回到「技术方案」阶段"
    });

    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    fireEvent.click(await screen.findByRole("button", { name: "更多工作操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退回阶段" }));

    expect(
      await screen.findByRole("heading", { name: "退回到「技术方案」阶段？" })
    ).toBeInTheDocument();
    const transition = screen.getByRole("group", { name: "阶段变更" });
    expect(within(transition).getByText("开发")).toBeInTheDocument();
    expect(within(transition).getByText("技术方案")).toBeInTheDocument();
  });

  it("在对话中展示阶段事件的触发方式、结果和退回原因", async () => {
    const activeWorkItem = {
      id: "work-1",
      projectId: project.id,
      type: "structured_requirement",
      requirementSequence: 8,
      title: "开发世界杯网站",
      workflowState: "technical_design",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-1",
      revision: 2,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    apiMock.project.mockResolvedValue({
      ...projectResponse(),
      activeWorkItem,
      workItemEvents: [{
        id: "event-return",
        projectId: project.id,
        workItemId: activeWorkItem.id,
        kind: "transition",
        source: "natural_language",
        fromState: "development",
        toState: "technical_design",
        actorGuestId: guest.id,
        details: { reason: "验收范围发生变化" },
        createdAt: "2026-01-01T00:00:02Z"
      }]
    });

    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );

    expect(await screen.findByText("开发 → 技术方案")).toBeInTheDocument();
    expect(screen.getByText("通过自然语言触发")).toBeInTheDocument();
    expect(screen.getByText("原因：验收范围发生变化")).toBeInTheDocument();
    const messageRound = screen.getByText("创建网页").closest(".message-round");
    const eventCard = screen.getByText("开发 → 技术方案").closest(".workflow-event-card");
    expect(messageRound).not.toBeNull();
    expect(eventCard).not.toBeNull();
    expect(
      messageRound!.compareDocumentPosition(eventCard!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("开发中明确改变需求时复用退回动作并要求二次确认", async () => {
    const activeWorkItem = {
      id: "work-1",
      projectId: project.id,
      type: "structured_requirement",
      requirementSequence: 8,
      title: "开发世界杯网站",
      workflowState: "development",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-1",
      revision: 3,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    apiMock.project.mockResolvedValue({ ...projectResponse(), activeWorkItem });
    apiMock.workItemAction.mockResolvedValue({
      confirmationRequired: true,
      action: "return_to_stage",
      targetState: "requirements_discussion",
      message: "需求范围发生变化，将退回需求讨论"
    });
    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "修改功能流程并补充验收标准" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(apiMock.workItemAction).toHaveBeenCalledWith(
        guest.id,
        project.id,
        activeWorkItem.id,
        expect.objectContaining({
          action: "return_to_stage",
          targetState: "requirements_discussion",
          source: "natural_language",
          confirmed: false
        })
      )
    );
    expect(
      await screen.findByRole("heading", { name: "退回到「需求讨论」阶段？" })
    ).toBeInTheDocument();
    expect(screen.getByText("操作原因")).toBeInTheDocument();
  });

  it("待上线预览显示需求标识，发布确认可编辑标题和摘要", async () => {
    const activeWorkItem = {
      id: "work-release",
      projectId: project.id,
      type: "structured_requirement",
      requirementSequence: 8,
      title: "世界杯网站",
      workflowState: "pending_release",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-release",
      revision: 4,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;
    apiMock.project.mockResolvedValue({ ...projectResponse(), activeWorkItem });
    apiMock.workItemAction
      .mockResolvedValueOnce({
        confirmationRequired: true,
        action: "publish",
        message: "将创建不可变正式代码版本",
        suggestedTitle: "世界杯网站 V1",
        suggestedSummary: "新增赛程和球队页面"
      })
      .mockResolvedValueOnce({});

    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    fireEvent.click(await screen.findByRole("button", { name: "应用" }));
    expect(screen.getByText("待上线预览 · R008")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "发布版本" }));
    const title = await screen.findByRole("textbox", { name: "版本标题" });
    const summary = screen.getByRole("textbox", { name: "版本摘要" });
    expect(title).toHaveValue("世界杯网站 V1");
    expect(summary).toHaveValue("新增赛程和球队页面");

    fireEvent.change(title, { target: { value: "世界杯专题正式版" } });
    fireEvent.change(summary, { target: { value: "上线赛程、球队和响应式页面" } });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => expect(apiMock.workItemAction).toHaveBeenCalledTimes(2));
    expect(apiMock.workItemAction.mock.calls[1][3]).toMatchObject({
      action: "publish",
      confirmed: true,
      title: "世界杯专题正式版",
      summary: "上线赛程、球队和响应式页面"
    });
  });

  it("工具卡片展示本次调用的用户可见作用描述", async () => {
    apiMock.project.mockResolvedValue(
      projectResponse([{ ...turn, items: [userItem, toolItem, assistantItem] }])
    );
    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );

    expect(await screen.findByText("检查项目结构和关键配置")).toBeInTheDocument();
    expect(screen.getByText("inspect_project")).toBeInTheDocument();
  });

  it("按 item ordinal 穿插展示助手文字和工具卡片", async () => {
    const commentary = {
      ...assistantItem,
      id: "commentary",
      ordinal: 2,
      phase: "commentary" as const,
      text: "我先检查目录。"
    };
    const finalAnswer = {
      ...assistantItem,
      id: "final",
      ordinal: 4,
      text: "网站已经完成。"
    };
    apiMock.project.mockResolvedValue(
      projectResponse([{ ...turn, items: [userItem, commentary, fileItem, finalAnswer] }])
    );
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    const assistant = container.querySelector(".assistant-content")!;
    const visible = within(assistant as HTMLElement)
      .getAllByText(/我先检查目录|新建文件|网站已经完成/)
      .map((element) => element.textContent);
    expect(visible).toEqual(["我先检查目录。", "新建文件", "网站已经完成。"]);
  });

  it("输入框上方显示最新待办进度，hover 后展开详情且不生成工具卡", async () => {
    apiMock.project.mockResolvedValue(
      projectResponse([{
        ...turn,
        status: "running",
        completedAt: null,
        items: [userItem, todoItem, assistantItem]
      }])
    );
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    const trigger = await screen.findByRole("button", { name: "第 2 / 3 步" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".event-card.tool")).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByRole("region", { name: "待办事项详情" });
    expect(within(details).getByText("分析需求")).toBeInTheDocument();
    expect(within(details).getByText("实现功能")).toBeInTheDocument();
    expect(within(details).getByText("运行测试")).toBeInTheDocument();
    expect(details.querySelector(".todo-status-spinner")).toBeInTheDocument();
    expect(container.querySelector(".todo-progress-ring")).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("全部完成后显示低强调完成态并保留详情入口", async () => {
    apiMock.project.mockResolvedValue(
      projectResponse([{
        ...turn,
        items: [
          userItem,
          {
            ...todoItem,
            todos: todoItem.todos.map((todo) => ({ ...todo, status: "completed" }))
          },
          assistantItem
        ]
      }])
    );
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    const trigger = await screen.findByRole("button", { name: "已完成 3 / 3" });
    expect(container.querySelector(".todo-progress.completed")).toBeInTheDocument();
    expect(container.querySelector(".todo-progress-ring")).not.toBeInTheDocument();
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("region", { name: "待办事项详情" })).toBeVisible();
  });

  it("失败且未完成时显示停止态", async () => {
    apiMock.project.mockResolvedValue(
      projectResponse([{
        ...turn,
        status: "failed",
        error: "执行失败",
        items: [userItem, todoItem]
      }])
    );
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    expect(await screen.findByRole("button", { name: "已停止 2 / 3" })).toBeInTheDocument();
    expect(container.querySelector(".todo-progress.stopped")).toBeInTheDocument();
  });

  it("收到新的 todo_list item 后更新输入框上方的最新进度", async () => {
    apiMock.project.mockResolvedValue(
      projectResponse([{ ...turn, status: "running", items: [userItem, todoItem] }])
    );
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    expect(await screen.findByRole("button", { name: "第 2 / 3 步" })).toBeInTheDocument();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].receive({
      kind: "item_started",
      data: {
        ...todoItem,
        id: "item-todo-next",
        ordinal: 3,
        status: "in_progress",
        completedAt: null,
        todos: todoItem.todos.map((todo, index) => ({
          ...todo,
          status: index < 2 ? "completed" : "in_progress"
        }))
      }
    });
    expect(await screen.findByRole("button", { name: "第 3 / 3 步" })).toBeInTheDocument();
  });

  it("五类实时内容各采样 20 次且页面可见更新 p95 小于 1 秒", async () => {
    const streamingAssistant: AssistantMessageItem = {
      ...assistantItem,
      id: "item-assistant-stream",
      phase: "commentary",
      status: "in_progress",
      text: "",
      completedAt: null
    };
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem, streamingAssistant, commandItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    apiMock.files.mockResolvedValue({ items: [] });
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    const timings: Record<string, number[]> = {
      messageStatus: [],
      assistantDelta: [],
      terminalOutput: [],
      todoUpdate: [],
      fileWrite: []
    };
    const sample = async (
      category: keyof typeof timings,
      envelope: unknown,
      visible: () => void
    ) => {
      const startedAt = performance.now();
      socket.receive(envelope);
      await waitFor(visible);
      timings[category].push(performance.now() - startedAt);
    };

    for (let index = 0; index < 20; index += 1) {
      const text = `状态样本 ${index}`;
      await sample(
        "messageStatus",
        {
          kind: "turn_created",
          data: {
            ...running,
            id: `turn-latency-${index}`,
            sequence: index + 2,
            status: "queued",
            startedAt: null,
            items: [{
              ...userItem,
              id: `user-latency-${index}`,
              turnId: `turn-latency-${index}`,
              text
            }]
          }
        },
        () => {
          const round = [...container.querySelectorAll<HTMLElement>(".message-round")]
            .find((element) => element.textContent?.includes(text));
          expect(round).toBeDefined();
          expect(round?.querySelector(".message-status")).toHaveTextContent("排队中");
        }
      );
    }

    let assistantText = "";
    for (let index = 0; index < 20; index += 1) {
      const delta = `片段${index} `;
      assistantText += delta;
      await sample(
        "assistantDelta",
        {
          kind: "item_assistant_message_delta",
          data: { turnId: turn.id, itemId: streamingAssistant.id, delta }
        },
        () =>
          expect(container.querySelector(".assistant-content")).toHaveTextContent(assistantText)
      );
    }

    for (let index = 0; index < 20; index += 1) {
      const output = `终端样本 ${index}`;
      await sample(
        "terminalOutput",
        {
          kind: "item_command_output_snapshot",
          data: { turnId: turn.id, itemId: commandItem.id, output }
        },
        () => expect(container.querySelector(".terminal-output pre")).toHaveTextContent(output)
      );
    }

    for (let index = 0; index < 20; index += 1) {
      const total = index + 2;
      await sample(
        "todoUpdate",
        {
          kind: "item_started",
          data: {
            ...todoItem,
            id: `todo-latency-${index}`,
            ordinal: 10 + index,
            status: "in_progress",
            completedAt: null,
            todos: Array.from({ length: total }, (_, todoIndex) => ({
              content: `步骤 ${todoIndex + 1}`,
              status: todoIndex === 0 ? "in_progress" : "pending"
            }))
          }
        },
        () =>
          expect(
            screen.getByRole("button", { name: `第 1 / ${total} 步` })
          ).toBeInTheDocument()
      );
    }

    for (let index = 0; index < 20; index += 1) {
      const path = `sample-${index}.txt`;
      const content = `文件样本 ${index}`;
      socket.receive({
        kind: "file_create",
        data: {
          turnId: turn.id,
          streamId: `stream-${index}`,
          path,
          action: "create"
        }
      });
      await sample(
        "fileWrite",
        {
          kind: "file_append",
          data: {
            turnId: turn.id,
            streamId: `stream-${index}`,
            path,
            offset: 0,
            delta: content
          }
        },
        () => expect(hasCodeLine(content)).toBe(true)
      );
    }

    const p95: Record<string, number> = {};
    for (const [category, samples] of Object.entries(timings)) {
      const sorted = [...samples].sort((left, right) => left - right);
      const value = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
      p95[category] = Number(value.toFixed(1));
      expect(samples.filter((duration) => duration < 1_000)).toHaveLength(20);
      expect(value).toBeLessThan(1_000);
    }
    console.info("realtime-visible-p95-ms", p95);
  }, 15_000);

  it("展示历史和预览，并可从文件 item 打开文件", async () => {
    apiMock.project.mockResolvedValue(projectResponse());
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    expect(await screen.findByRole("heading", { name: "验收项目" })).toBeInTheDocument();
    expect(screen.getByText("网页")).toBeInTheDocument();
    expect(screen.getByTitle("验收项目 预览")).toHaveAttribute("sandbox");
    const assistant = container.querySelector(".assistant-message") as HTMLElement;
    const fileCard = screen.getByRole("button", {
      name: /新建文件 创建网站首页 index.html/
    });
    expect(within(assistant).getByText("luffi · 工程师")).toBeInTheDocument();
    expect(within(fileCard).getByText("2026/01/01")).toBeInTheDocument();
    expect(fileCard).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(fileCard);
    expect(fileCard).toHaveAttribute("aria-pressed", "true");
    expect(fileCard).toHaveClass("selected");
    await waitFor(() => expect(apiMock.file).toHaveBeenCalledWith(guest.id, project.id, "index.html"));
  });

  it("文件操作开始即选中目标并展示快照，完成后用磁盘内容校准", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    apiMock.files.mockResolvedValue({ items: [] });
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    FakeWebSocket.instances[0].receive({
      kind: "item_started",
      data: {
        ...fileItem,
        status: "in_progress",
        completedAt: null,
        contentSnapshot: "<main>正在写入</main>"
      }
    });

    expect(await findCodeLine("<main>正在写入</main>")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: /index.html 新建/ })).toHaveClass("selected");
    expect(apiMock.file).not.toHaveBeenCalled();

    apiMock.file.mockResolvedValue({
      kind: "text",
      name: "index.html",
      path: "index.html",
      size: 24,
      content: "<main>磁盘内容</main>",
      language: "html"
    });
    apiMock.files.mockResolvedValue({
      items: [{ name: "index.html", path: "index.html", type: "file", change: "new" }]
    });
    FakeWebSocket.instances[0].receive({
      kind: "item_completed",
      data: {
        ...fileItem,
        contentSnapshot: "<main>正在写入</main>"
      }
    });

    expect(await findCodeLine("<main>磁盘内容</main>")).toBeInTheDocument();
    expect(apiMock.file).toHaveBeenCalledWith(guest.id, project.id, "index.html");
  });

  it("write 参数流创建占位文件并持续追加查看器内容", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    apiMock.files.mockResolvedValue({ items: [] });
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const socket = FakeWebSocket.instances[0];
    socket.receive({
      kind: "file_create",
      data: {
        turnId: turn.id,
        streamId: "write-stream-1",
        path: "index.html",
        action: "create"
      }
    });

    expect(await screen.findByRole("button", { name: /index.html 新建/ })).toHaveClass(
      "selected"
    );
    expect(screen.getByRole("button", { name: "文件" })).toHaveClass("active");
    expect(apiMock.file).not.toHaveBeenCalled();

    socket.receive({
      kind: "file_append",
      data: {
        turnId: turn.id,
        streamId: "write-stream-1",
        path: "index.html",
        offset: 0,
        delta: "<main>"
      }
    });
    expect(await findCodeLine("<main>")).toBeInTheDocument();

    socket.receive({
      kind: "file_append",
      data: {
        turnId: turn.id,
        streamId: "write-stream-1",
        path: "index.html",
        offset: 6,
        delta: "实时</main>"
      }
    });
    expect(await findCodeLine("<main>实时</main>")).toBeInTheDocument();

    socket.receive({
      kind: "file_create",
      data: {
        turnId: turn.id,
        streamId: "write-stream-2",
        path: "style.css",
        action: "create"
      }
    });
    expect(await screen.findByRole("button", { name: /style.css 新建/ })).toHaveClass(
      "selected"
    );
    expect(apiMock.file).not.toHaveBeenCalled();
  });

  it("自动跟随开启时滚动到底部，用户上滚后关闭并可手动重新开启", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    apiMock.files.mockResolvedValue({ items: [] });
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.receive({
      kind: "file_create",
      data: {
        turnId: turn.id,
        streamId: "write-scroll",
        path: "index.html",
        action: "create"
      }
    });

    await screen.findByRole("button", { name: /index.html 新建/ });
    const followToggle = screen.getByRole("switch", { name: "自动跟随" });
    expect(followToggle).toHaveAttribute("aria-checked", "true");
    expect(container.querySelector(".viewer-tabs")).toContainElement(followToggle);
    expect(container.querySelector(".file-pane")).not.toContainElement(followToggle);
    const fileContent = container.querySelector(".file-content") as HTMLDivElement;
    Object.defineProperties(fileContent, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 }
    });
    socket.receive({
      kind: "file_append",
      data: {
        turnId: turn.id,
        streamId: "write-scroll",
        path: "index.html",
        offset: 0,
        delta: "第一段\n".repeat(30)
      }
    });
    await waitFor(() => expect(fileContent.scrollTop).toBe(600));

    fileContent.scrollTop = 100;
    fireEvent.scroll(fileContent);
    expect(followToggle).toHaveAttribute("aria-checked", "false");
    socket.receive({
      kind: "file_append",
      data: {
        turnId: turn.id,
        streamId: "write-scroll",
        path: "index.html",
        offset: "第一段\n".repeat(30).length,
        delta: "第二段\n"
      }
    });
    await screen.findByText("第二段");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(fileContent.scrollTop).toBe(100);

    fileContent.scrollTop = 400;
    fireEvent.scroll(fileContent);
    Object.defineProperty(fileContent, "scrollHeight", {
      configurable: true,
      value: 700
    });
    socket.receive({
      kind: "file_append",
      data: {
        turnId: turn.id,
        streamId: "write-scroll",
        path: "index.html",
        offset: "第一段\n".repeat(30).length + "第二段\n".length,
        delta: "第三段\n"
      }
    });
    await screen.findByText("第三段");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(fileContent.scrollTop).toBe(400);

    fireEvent.click(followToggle);
    expect(followToggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(fileContent.scrollTop).toBe(700));
  });

  it("新任务开始时同步解除上轮查看器锁并打开首个文件", async () => {
    apiMock.project.mockResolvedValue(projectResponse());
    apiMock.files.mockResolvedValue({ items: [] });
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "终端" }));

    const nextTurn = {
      ...turn,
      id: "turn-2",
      sequence: 2,
      status: "running" as const,
      completedAt: null,
      items: [{ ...userItem, id: "item-user-2", turnId: "turn-2" }]
    };
    const socket = FakeWebSocket.instances[0];
    socket.receive({ kind: "turn_started", data: nextTurn });
    socket.receive({
      kind: "item_started",
      data: {
        ...fileItem,
        id: "item-style",
        turnId: nextTurn.id,
        path: "style.css",
        status: "in_progress",
        completedAt: null,
        contentSnapshot: "body { color: blue; }"
      }
    });

    expect(await findCodeLine("body { color: blue; }")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: /style.css 新建/ })).toHaveClass("selected");
  });

  it("手动进入文件查看器等待生成时仍自动打开并连续跟随新文件", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    apiMock.files.mockResolvedValue({ items: [] });
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "文件" }));

    const files = [
      ["item-index", "index.html", "<main>TodoWrite 部署验收</main>"],
      ["item-style", "style.css", "body { font-family: sans-serif; }"],
      ["item-script", "script.js", "console.log('ready');"]
    ] as const;
    for (const [id, path, contentSnapshot] of files) {
      FakeWebSocket.instances[0].receive({
        kind: "item_started",
        data: {
          ...fileItem,
          id,
          path,
          status: "in_progress",
          completedAt: null,
          contentSnapshot
        }
      });
      expect(await findCodeLine(contentSnapshot)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: new RegExp(`${path} 新建`) })).toHaveClass(
        "selected"
      );
    }
  });

  it("手动选择具体文件后保留阅读位置，不被后续文件事件抢占", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await screen.findByRole("heading", { name: "验收项目" });
    fireEvent.click(screen.getByRole("button", { name: "文件" }));
    fireEvent.click(screen.getByRole("button", { name: /index.html 新建/ }));
    expect(await findCodeLine("<main />")).toBeInTheDocument();
    await waitFor(() =>
      expect(FakeWebSocket.instances[0]?.onmessage).toBeTypeOf("function")
    );

    const socket = FakeWebSocket.instances[0];
    socket.receive({
      kind: "item_started",
      data: {
        ...fileItem,
        id: "item-style",
        path: "style.css",
        status: "in_progress",
        completedAt: null,
        contentSnapshot: "body { color: blue; }"
      }
    });

    expect(await screen.findByRole("button", { name: /style.css 新建/ })).not.toHaveClass(
      "selected"
    );
    expect(screen.getByRole("button", { name: /index.html 新建/ })).toHaveClass("selected");
    expect(hasCodeLine("body { color: blue; }")).toBe(false);
    expect(hasCodeLine("<main />")).toBe(true);
  });

  it("重新打开执行中的项目时恢复目标文件和内容快照", async () => {
    const liveFile = {
      ...fileItem,
      status: "in_progress" as const,
      completedAt: null,
      contentSnapshot: "<main>重连快照</main>"
    };
    apiMock.project.mockResolvedValue(
      projectResponse([{
        ...turn,
        status: "running",
        completedAt: null,
        items: [userItem, liveFile]
      }])
    );

    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);

    expect(await findCodeLine("<main>重连快照</main>")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: /index.html 新建/ })).toHaveClass("selected");
    expect(apiMock.file).not.toHaveBeenCalled();
  });

  it("用户手动选择查看器后文件事件不抢占当前阅读位置", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].receive({
        kind: "item_started",
        data: {
          ...fileItem,
          status: "in_progress",
          completedAt: null,
          contentSnapshot: "<main>不应抢占</main>"
        }
      });
    });

    expect(screen.getByRole("button", { name: "应用" })).toHaveClass("active");
    expect(screen.queryByText("<main>不应抢占</main>")).not.toBeInTheDocument();
  });

  it("文件操作失败时保留已经展示的内容快照", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const liveFile = {
      ...fileItem,
      status: "in_progress" as const,
      completedAt: null,
      contentSnapshot: "<main>保留内容</main>"
    };
    act(() => {
      FakeWebSocket.instances[0].receive({ kind: "item_started", data: liveFile });
    });
    await findCodeLine("<main>保留内容</main>");
    act(() => {
      FakeWebSocket.instances[0].receive({
        kind: "item_completed",
        data: {
          ...liveFile,
          status: "failed",
          output: "当前阶段只能维护指定文档",
          completedAt: "2026-01-01T00:00:01Z"
        }
      });
    });

    expect(hasCodeLine("<main>保留内容</main>")).toBe(true);
    expect(await screen.findByText("当前阶段只能维护指定文档")).toHaveClass("event-error");
    expect(apiMock.file).not.toHaveBeenCalled();
  });

  it("新建文件重命名后保留“新建”标记、选择与已显示内容", async () => {
    apiMock.project.mockResolvedValue(projectResponse());
    apiMock.files.mockResolvedValueOnce({
      items: [{ name: "index.html", path: "index.html", type: "file", change: "new" }]
    }).mockResolvedValue({
      items: [{ name: "home.html", path: "home.html", type: "file", change: "new" }]
    });
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    const tree = screen.getByText("项目文件").closest("aside")!;
    fireEvent.click(within(tree).getByRole("button", { name: /index\.html/ }));
    await screen.findByRole("region", { name: "文件内容：index.html" });

    FakeWebSocket.instances[0].receive({
      kind: "item_completed",
      data: {
        ...fileItem,
        id: "rename-item",
        ordinal: 4,
        action: "rename",
        previousPath: "index.html",
        path: "home.html",
        description: "重命名页面",
        contentSnapshot: null
      }
    });

    expect(await screen.findByRole("button", { name: /home\.html.*新建/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /index\.html.*新建/ })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("region", { name: "文件内容：home.html" })).toBeInTheDocument();
    expect(screen.getByText("重命名文件")).toBeInTheDocument();
  });

  it("删除事件到达时立即移除文件，并让已选内容停止更新且显示原路径", async () => {
    apiMock.project.mockResolvedValue(projectResponse());
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    const tree = screen.getByText("项目文件").closest("aside")!;
    fireEvent.click(within(tree).getByRole("button", { name: /index\.html/ }));
    await screen.findByRole("region", { name: "文件内容：index.html" });

    FakeWebSocket.instances[0].receive({
      kind: "item_started",
      data: {
        ...fileItem,
        id: "delete-item",
        ordinal: 4,
        action: "delete",
        description: "删除旧页面",
        contentSnapshot: null,
        status: "in_progress",
        completedAt: null
      }
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /index\.html.*新建/ })).not.toBeInTheDocument();
    });
    expect(screen.getByText("文件已删除：index.html")).toBeInTheDocument();
    expect(screen.getByText("删除文件")).toBeInTheDocument();
  });

  it("命令累计输出快照替换旧内容且不会重复", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.receive({ kind: "item_started", data: commandItem });
    socket.receive({
      kind: "item_command_output_snapshot",
      data: { turnId: turn.id, itemId: commandItem.id, output: "first" }
    });
    socket.receive({
      kind: "item_command_output_snapshot",
      data: {
        turnId: turn.id,
        itemId: commandItem.id,
        output: "firstsecond",
        outputTruncated: true
      }
    });

    await waitFor(() =>
      expect(container.querySelector(".terminal-output pre")).toHaveTextContent("firstsecond")
    );
    expect(container.querySelector(".terminal-output pre")).not.toHaveTextContent("firstfirstsecond");
    expect(screen.getAllByText(/输出已截断/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "终端" })).toHaveClass("active");
  });

  it("统一自动跟随控制终端滚动，上滚后关闭并可手动恢复", async () => {
    const running = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.receive({ kind: "item_started", data: commandItem });
    expect(await screen.findByRole("button", { name: "终端" })).toHaveClass("active");

    const followToggle = screen.getByRole("switch", { name: "自动跟随" });
    const terminal = container.querySelector(".terminal-output") as HTMLDivElement;
    Object.defineProperties(terminal, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 }
    });
    socket.receive({
      kind: "item_command_output_snapshot",
      data: { turnId: turn.id, itemId: commandItem.id, output: "第一段输出" }
    });
    await waitFor(() => expect(terminal.scrollTop).toBe(600));

    terminal.scrollTop = 100;
    fireEvent.scroll(terminal);
    expect(followToggle).toHaveAttribute("aria-checked", "false");
    socket.receive({
      kind: "item_command_output_snapshot",
      data: { turnId: turn.id, itemId: commandItem.id, output: "第一段输出\n第二段输出" }
    });
    await screen.findByText("有新输出");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(terminal.scrollTop).toBe(100);

    Object.defineProperty(terminal, "scrollHeight", {
      configurable: true,
      value: 700
    });
    fireEvent.click(followToggle);
    expect(followToggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "终端" })).toHaveClass("active");
    await waitFor(() => expect(terminal.scrollTop).toBe(700));
  });

  it("用户消息只用当前游客头像标识身份，不显示名称", async () => {
    apiMock.project.mockResolvedValue(projectResponse());
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });
    const userMessage = container.querySelector(".user-message")!;
    expect(screen.getByRole("img", { name: "我的头像" })).toHaveTextContent("D");
    expect(within(userMessage as HTMLElement).queryByText("我", { exact: true })).not.toBeInTheDocument();
    expect(within(userMessage as HTMLElement).queryByText(guest.name)).not.toBeInTheDocument();
  });

  it("运行中把输入框主操作切换为停止，输入消息后恢复发送并进入队列", async () => {
    const runningTurn = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    const queuedTurn = {
      ...turn,
      id: "turn-queued",
      sequence: 2,
      status: "queued" as const,
      startedAt: null,
      completedAt: null,
      items: [{ ...userItem, id: "item-queued", turnId: "turn-queued", text: "继续优化移动端" }]
    };
    apiMock.project.mockResolvedValue(projectResponse([runningTurn]));
    apiMock.sendMessage.mockResolvedValue(queuedTurn);
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });

    const userMessage = container.querySelector(".user-message") as HTMLElement;
    expect(within(userMessage).queryByRole("button", { name: /停止/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止当前任务" }));
    expect(screen.getByRole("dialog", { name: "停止当前任务？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续执行" }));

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "继续优化移动端" }
    });
    expect(screen.queryByRole("button", { name: "停止当前任务" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(apiMock.sendMessage).toHaveBeenCalledWith(
        guest.id,
        project.id,
        "继续优化移动端",
        [],
        []
      )
    );
    expect(await screen.findByText("排队中")).toBeInTheDocument();
  });

  it("自然语言停止复用停止确认且不会进入消息队列", async () => {
    const runningTurn = {
      ...turn,
      status: "running" as const,
      completedAt: null,
      items: [userItem]
    };
    const activeWorkItem: WorkItem = {
      id: runningTurn.workItemId ?? "work-running",
      projectId: project.id,
      type: "direct_coding",
      requirementSequence: null,
      title: "运行中的工作",
      workflowState: "direct_coding",
      executionState: "running",
      baseCommit: "base",
      branchRef: `refs/heads/work/${runningTurn.workItemId ?? "work-running"}`,
      revision: 3,
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
      publishedVersionId: null
    };
    apiMock.project.mockResolvedValue({
      ...projectResponse([runningTurn]),
      activeWorkItem
    });
    apiMock.stopTurn.mockResolvedValue({
      ...runningTurn,
      status: "cancelled",
      completedAt: "2026-07-20T00:01:00Z"
    });
    render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByRole("heading", { name: "验收项目" });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "停止当前任务" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(
      await screen.findByRole("dialog", { name: "停止当前任务？" })
    ).toBeInTheDocument();
    expect(apiMock.sendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认停止" }));
    await waitFor(() =>
      expect(apiMock.stopTurn).toHaveBeenCalledWith(
        guest.id,
        project.id,
        runningTurn.id,
        expect.objectContaining({
          confirmed: true,
          revision: expect.any(Number),
          idempotencyKey: expect.any(String),
          source: "natural_language"
        })
      )
    );
  });

  it("turn_started 先于发送接口返回时，不被迟到的 queued 响应覆盖", async () => {
    const queuedTurn = {
      ...turn,
      id: "turn-race",
      sequence: 2,
      status: "queued" as const,
      startedAt: null,
      completedAt: null,
      items: [{
        ...userItem,
        id: "item-race",
        turnId: "turn-race",
        text: "触发竞态"
      }]
    };
    let resolveSend!: (value: ConversationTurn) => void;
    apiMock.project.mockResolvedValue(projectResponse());
    apiMock.sendMessage.mockReturnValue(
      new Promise<ConversationTurn>((resolve) => {
        resolveSend = resolve;
      })
    );
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "触发竞态" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(apiMock.sendMessage).toHaveBeenCalled());

    FakeWebSocket.instances[0].receive({
      kind: "turn_started",
      data: {
        ...queuedTurn,
        status: "running",
        startedAt: "2026-01-01T00:00:02Z"
      }
    });
    resolveSend(queuedTurn);

    expect(await screen.findByText("执行中")).toBeInTheDocument();
    expect(screen.queryByText("排队中")).not.toBeInTheDocument();
  });

  it("assistant delta 只追加到指定 item", async () => {
    const streaming = {
      ...assistantItem,
      text: "",
      phase: "commentary" as const,
      status: "in_progress" as const,
      completedAt: null
    };
    apiMock.project.mockResolvedValue(
      projectResponse([{ ...turn, status: "running", completedAt: null, items: [userItem, streaming] }])
    );
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    await screen.findByRole("heading", { name: "验收项目" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.receive({
      kind: "item_assistant_message_delta",
      data: { turnId: turn.id, itemId: streaming.id, delta: "第一段" }
    });
    socket.receive({
      kind: "item_assistant_message_delta",
      data: { turnId: turn.id, itemId: streaming.id, delta: "，第二段" }
    });
    expect(await screen.findByText("第一段，第二段")).toBeInTheDocument();
  });

  it("收到 thinking 时只展示状态，并在新 item 开始时收起", async () => {
    const running = { ...turn, status: "running" as const, completedAt: null, items: [userItem] };
    apiMock.project.mockResolvedValue(projectResponse([running]));
    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    expect(await screen.findByRole("status")).toHaveTextContent("正在思考中...");
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.receive({
      kind: "thinking",
      data: { turnId: turn.id, active: true, content: "不能展示的内部推理" }
    });
    expect(screen.queryByText(/内部推理/)).not.toBeInTheDocument();
    socket.receive({ kind: "thinking", data: { turnId: turn.id, active: false } });
    socket.receive({
      kind: "item_started",
      data: { ...assistantItem, text: "开始处理", status: "in_progress", completedAt: null }
    });
    expect(await screen.findByText("开始处理")).toBeInTheDocument();
    expect(screen.queryByText("正在思考中...")).not.toBeInTheDocument();
  });

  it("sync 用权威 items 补齐断线内容且不重复", async () => {
    const first = { ...assistantItem, text: "第一段" };
    apiMock.project.mockResolvedValue(projectResponse([{ ...turn, items: [userItem, first] }]));
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    await screen.findByText("第一段");
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].receive({
      kind: "sync",
      data: {
        connected: true,
        project,
        turns: [{ ...turn, items: [userItem, { ...first, text: "第一段，断线补齐" }] }]
      }
    });
    expect(await screen.findByText("第一段，断线补齐")).toBeInTheDocument();
    expect(container.querySelectorAll(".message-round")).toHaveLength(1);
  });

  it("按 item 游标加载更早内容并合并跨页的同一 turn", async () => {
    const latestAssistant = { ...assistantItem, id: "assistant-51", ordinal: 51, text: "消息 51" };
    const latest = {
      ...turn,
      sequence: 51,
      items: [latestAssistant]
    };
    apiMock.project.mockResolvedValue({
      ...projectResponse([latest]),
      turns: { items: [latest], hasMore: true, nextCursor: "51:51" }
    });
    apiMock.olderMessages.mockResolvedValue({
      items: [{
        ...latest,
        items: [
          { ...userItem, text: "消息 1" },
          { ...assistantItem, id: "assistant-2", ordinal: 2, text: "消息 2" }
        ]
      }],
      hasMore: false,
      nextCursor: "51:1"
    });
    const { container } = render(
      <ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />
    );
    expect(await screen.findByText("消息 51")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更早内容" }));
    expect(await screen.findByText("消息 1")).toBeInTheDocument();
    expect(screen.getByText("消息 51")).toBeInTheDocument();
    expect(apiMock.olderMessages).toHaveBeenCalledWith(guest.id, project.id, "51:51");
    expect(container.querySelectorAll(".message-round")).toHaveLength(1);
  });

  it("更早内容加载失败时保留现有内容并提供原游标重试", async () => {
    apiMock.project.mockResolvedValue({
      ...projectResponse(),
      turns: { items: [turn], hasMore: true, nextCursor: "1:1" }
    });
    apiMock.olderMessages
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce({
        items: [{
          ...turn,
          id: "old-turn",
          sequence: 0,
          items: [{ ...userItem, id: "old-user", turnId: "old-turn", text: "更早消息" }]
        }],
        hasMore: false,
        nextCursor: "0:1"
      });

    render(<ProjectPage guest={guest} projectId={project.id} onGuestChange={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "加载更早内容" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络暂时不可用");
    expect(screen.getByText(userItem.text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByText("更早消息")).toBeInTheDocument();
    expect(apiMock.olderMessages).toHaveBeenNthCalledWith(1, guest.id, project.id, "1:1");
    expect(apiMock.olderMessages).toHaveBeenNthCalledWith(2, guest.id, project.id, "1:1");
  });
});
