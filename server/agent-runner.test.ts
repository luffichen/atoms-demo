import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  archiveDocumentAttachments,
  AgentRunner,
  buildAgentPrompt,
  buildWorkItemPrompt,
  finalizeDocumentAttachmentReferences,
  findConfirmedRequirementDocument,
  shouldAutoRepairTestingAdmission,
  shouldContinueQueuedWork,
  validateStructuredTestReport,
  validateTechnicalDesignDocument,
  validateTestingAdmissionReport,
  workItemToolPolicy
} from "./agent-runner.js";
import type { AppConfig } from "./config.js";
import type { WorkItem } from "./domain/types.js";
import { openMemoryDatabase } from "./db.js";
import { RealtimeHub } from "./realtime.js";
import { Store } from "./store.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  workspaceRoot: "/tmp/atoms-demo-agent-runner-tests",
  databasePath: ":memory:",
  deepseekKeyFile: "/tmp/unused",
  deepseekModel: "deepseek-v4-pro",
  releaseMetadataModel: "deepseek-v4-flash",
  publicDomain: "localhost",
  isProduction: false
};

describe("AgentRunner 文档图片归档", () => {
  it("只把文档实际引用的暂存图片复制到可随版本保留的 assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "atoms-document-assets-"));
    try {
      const source = join(root, "upload.png");
      const unused = join(root, "unused.png");
      await writeFile(source, "image-bytes");
      await writeFile(unused, "unused");
      const workItem = {
        type: "structured_requirement",
        workflowState: "requirements_discussion",
        requirementSequence: 7
      } as const;
      const paths = await archiveDocumentAttachments(root, workItem, [
        { path: source, mimeType: "image/png" },
        { path: unused, mimeType: "image/png" }
      ]);

      expect(paths).toEqual([
        ".tmp/document-attachments/R007/requirements/01-upload.png",
        ".tmp/document-attachments/R007/requirements/02-unused.png"
      ]);
      expect(await readFile(join(root, paths[0]), "utf8")).toBe("image-bytes");
      const requirementRoot = join(root, "docs", "requirements", "R007-feature");
      await mkdir(requirementRoot, { recursive: true });
      const readme = join(requirementRoot, "README.md");
      await writeFile(readme, `# 需求\n\n![参考图](${paths[0]})`);
      await expect(
        finalizeDocumentAttachmentReferences(root, workItem)
      ).resolves.toEqual([
        "docs/requirements/R007-feature/assets/01-upload.png"
      ]);
      expect(await readFile(readme, "utf8")).toContain(
        "![参考图](assets/01-upload.png)"
      );
      await expect(
        readFile(join(requirementRoot, "assets", "02-unused.png"))
      ).rejects.toThrow();
      expect(
        await archiveDocumentAttachments(
          root,
          { ...workItem, workflowState: "development" },
          [{ path: source, mimeType: "image/png" }]
        )
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("结构化文档硬门禁", () => {
  it("技术方案缺少强制章节或包含待确认项时拒绝确认", async () => {
    const root = await mkdtemp(join(tmpdir(), "atoms-technical-gate-"));
    try {
      const technical = join(root, "docs", "technical");
      await mkdir(technical, { recursive: true });
      await writeFile(join(technical, "R003-feature.md"), "# 背景与需求引用\n\n待确认");
      await expect(validateTechnicalDesignDocument(root, 3)).rejects.toThrow(/缺少必备章节|待确认/);

      await writeFile(
        join(technical, "R003-feature.md"),
        [
          "# R003 技术方案",
          ...[
            "背景与需求引用", "现状分析", "总体方案", "数据模型", "接口与事件",
            "前端交互", "安全边界", "兼容性", "实施步骤", "测试计划",
            "上线与回滚", "风险", "非目标"
          ].map((heading) => `## ${heading}\n\n不适用：本需求无需额外处理。`)
        ].join("\n\n")
      );
      await expect(validateTechnicalDesignDocument(root, 3)).resolves.toContain("R003-feature.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("界面测试报告必须结构完整、结论通过并引用有效截图", async () => {
    const root = await mkdtemp(join(tmpdir(), "atoms-test-report-gate-"));
    try {
      const reports = join(root, "docs", "test-reports");
      await mkdir(join(reports, "assets"), { recursive: true });
      const reportPath = join(reports, "R004-feature.md");
      const report = (image = "") => [
        "# R004 测试报告",
        "## 环境\nChrome",
        "## 检查点\n测试通过",
        "## 命令\nnpm test",
        "## 耗时\n1s",
        "## 摘要\n界面流程通过",
        "## 验收映射\nAC1 → 自动化测试",
        `## 界面尺寸\n桌面端 1440px、移动端 390px\n${image}`,
        "## 已知限制\n无",
        "## 最终结论\n通过"
      ].join("\n\n");
      await writeFile(reportPath, report());
      await expect(validateStructuredTestReport(root, 4)).rejects.toThrow(/缺少.*截图/);
      await writeFile(join(reports, "assets", "desktop.png"), "png");
      await writeFile(reportPath, report("![桌面验收](assets/desktop.png)"));
      await expect(validateStructuredTestReport(root, 4)).resolves.toBe(reportPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const partial = {
  role: "assistant",
  content: [],
  api: "test",
  provider: "test",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: "stop",
  timestamp: 0
};

describe("AgentRunner 阶段文件权限", () => {
  it("把需求与测试阶段图片归档到对应编号的文档资产目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "atoms-document-assets-"));
    const source = join(root, "source.png");
    try {
      await writeFile(source, "image");
      await mkdir(
        join(root, "docs", "requirements", "R099-upload-images"),
        { recursive: true }
      );
      const requirementPaths = await archiveDocumentAttachments(
        root,
        {
          type: "structured_requirement",
          workflowState: "requirements_pending_confirmation",
          requirementSequence: 99
        },
        [{ path: source, mimeType: "image/png" }]
      );
      expect(requirementPaths).toEqual([
        ".tmp/document-attachments/R099/requirements/01-source.png"
      ]);
      await expect(
        readFile(join(root, requirementPaths[0]), "utf8")
      ).resolves.toBe("image");

      const testingPaths = await archiveDocumentAttachments(
        root,
        {
          type: "structured_requirement",
          workflowState: "testing",
          requirementSequence: 99
        },
        [{ path: source, mimeType: "image/png" }]
      );
      expect(testingPaths).toEqual([
        ".tmp/document-attachments/R099/testing/01-source.png"
      ]);
      await expect(
        readFile(join(root, testingPaths[0]), "utf8")
      ).resolves.toBe("image");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("需求目录尚未生成时使用同编号暂存资产目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "atoms-staged-assets-"));
    const source = join(root, "source.jpg");
    try {
      await writeFile(source, "image");
      const paths = await archiveDocumentAttachments(
        root,
        {
          type: "structured_requirement",
          workflowState: "requirements_discussion",
          requirementSequence: 7
        },
        [{ path: source, mimeType: "image/jpeg" }]
      );
      expect(paths).toEqual([
        ".tmp/document-attachments/R007/requirements/01-source.jpg"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("开发和测试阶段冻结已确认需求与技术文档", () => {
    for (const workflowState of ["development", "testing_admission", "testing"] as const) {
      const policy = workItemToolPolicy({
        type: "structured_requirement",
        workflowState
      });
      expect(policy.allowBash).toBe(true);
      expect(policy.writablePrefixes).toBeUndefined();
      expect(policy.readOnlyPrefixes).toEqual(expect.arrayContaining([
        "docs/requirements",
        "docs/technical",
        "docs/technical-decisions.md"
      ]));
    }
  });

  it("待上线阶段冻结候选工作区并关闭终端", () => {
    const policy = workItemToolPolicy({
      type: "structured_requirement",
      workflowState: "pending_release"
    });
    expect(policy.allowBash).toBe(false);
    expect(policy.writablePrefixes).toEqual([]);
  });

  it("退回需求或技术阶段后只恢复对应文档写入", () => {
    expect(workItemToolPolicy({
      type: "structured_requirement",
      workflowState: "requirements_discussion"
    })).toMatchObject({
      writablePrefixes: ["docs/requirements"],
      allowBash: false
    });
    expect(workItemToolPolicy({
      type: "structured_requirement",
      workflowState: "technical_design"
    })).toMatchObject({
      writablePrefixes: ["docs/technical", "docs/technical-decisions.md"],
      allowBash: false
    });
  });

  it("所有阶段均保护平台元数据目录", () => {
    const policy = workItemToolPolicy({
      type: "direct_coding",
      workflowState: "direct_coding"
    });
    expect(policy.readOnlyPrefixes).toEqual(expect.arrayContaining([
      ".git",
      ".agents",
      ".codex",
      ".sessions"
    ]));
  });
});

describe("AgentRunner 队列恢复边界", () => {
  it("失败、停止或重启后暂停普通队列，只允许显式恢复和准入自动修复", () => {
    expect(shouldContinueQueuedWork("failed", "普通排队消息")).toBe(false);
    expect(shouldContinueQueuedWork("cancelled", "普通排队消息")).toBe(false);
    expect(shouldContinueQueuedWork("failed", "人工恢复执行：检查现场")).toBe(true);
    expect(shouldContinueQueuedWork("failed", "测试准入自动修复：修复测试")).toBe(true);
    expect(shouldContinueQueuedWork("completed", "普通排队消息")).toBe(true);
  });
});

describe("AgentRunner 对话 Item 事件", () => {
  let db: Database.Database;
  let store: Store;
  let hub: RealtimeHub;

  beforeEach(() => {
    db = openMemoryDatabase();
    store = new Store(db);
    hub = new RealtimeHub();
  });

  afterEach(() => db.close());

  it("服务重启只收敛中断状态，不自动启动遗留队列", () => {
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "重启恢复", "运行中");
    store.claimNextTurn(project.id);
    const queued = store.enqueueTurn(project.id, "遗留队列");
    const events: Array<{ kind: string; data: any }> = [];
    hub.subscribe(project.id, (event) => events.push({ kind: event.kind, data: event.data }));
    const runner = new AgentRunner(config, store, hub);
    const kick = vi.spyOn(runner, "kick");

    runner.recoverAndStart();

    expect(kick).not.toHaveBeenCalled();
    expect(store.getTurn(queued.id)?.status).toBe("queued");
    expect(store.getWorkItem(queued.workItemId)).toMatchObject({
      executionState: "failed",
      error: "服务重启导致中断"
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "work_item_updated",
      data: expect.objectContaining({
        id: queued.workItemId,
        executionState: "failed"
      })
    }));
  });

  function harness() {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "流式回复", "开始");
    store.claimNextTurn(project.id);
    const events: Array<{ kind: string; data: any }> = [];
    hub.subscribe(project.id, (event) => events.push({ kind: event.kind, data: event.data }));
    const runner = new AgentRunner(config, store, hub);
    const handle = (
      runner as unknown as {
        handleAgentEvent(
          projectId: string,
          turnId: string,
          event: AgentSessionEvent,
          state: {
            assistantScope: number;
            textItems: Map<string, string>;
            toolItems: Map<string, string>;
            fileStreams: Map<string, {
              rawArgs: string;
              streamId?: string;
              path?: string;
              content: string;
            }>;
            fileAnnouncements: Map<string, {
              rawArgs: string;
              streamId: string;
              path?: string;
              claimed: boolean;
            }>;
          }
        ): void;
      }
    ).handleAgentEvent.bind(runner);
    return {
      project,
      turn,
      events,
      handle,
      state: {
        assistantScope: 0,
        textItems: new Map<string, string>(),
        toolItems: new Map<string, string>(),
        fileStreams: new Map(),
        fileAnnouncements: new Map()
      }
    };
  }

  it("按 contentIndex 将文本 delta 路由到独立 item", () => {
    const { project, turn, events, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "第一段",
        partial
      }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "第一段",
        partial
      }
    } as AgentSessionEvent, state);

    const assistant = store.listAssistantItems(turn.id)[0];
    expect(assistant.text).toBe("第一段");
    expect(assistant.status).toBe("completed");
    expect(events.map(({ kind }) => kind)).toContain("item_assistant_message_delta");
    expect(events.find(({ kind }) => kind === "item_assistant_message_delta")?.data).toMatchObject({
      turnId: turn.id,
      itemId: assistant.id,
      delta: "第一段"
    });
  });

  it("保留文字、工具、文字的首次出现顺序", () => {
    const { project, turn, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "先检查。",
        partial
      }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd", description: "确认当前项目目录" }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "/project" }] },
      isError: false
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "message_start",
      message: partial
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "检查完成。",
        partial
      }
    } as AgentSessionEvent, state);

    expect(store.getTurn(turn.id)?.items.map(({ type }) => type)).toEqual([
      "user_message",
      "assistant_message",
      "command_execution",
      "assistant_message"
    ]);
    expect(
      store.getTurn(turn.id)?.items.find(({ type }) => type === "command_execution")
    ).toMatchObject({ description: "确认当前项目目录" });
    expect(store.listAssistantItems(turn.id)[0].phase).toBe("commentary");
  });

  it("thinking 只发布状态且在工具开始时收起", () => {
    const { project, turn, events, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "内部推理",
        partial
      }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    } as AgentSessionEvent, state);

    expect(events.filter(({ kind }) => kind === "thinking").map(({ data }) => data)).toEqual([
      { turnId: turn.id, active: true },
      { turnId: turn.id, active: false }
    ]);
    expect(JSON.stringify(events)).not.toContain("内部推理");
    expect(events.map(({ kind }) => kind)).toContain("item_started");
  });

  it("write 开始时持久化并发布目标文件内容快照", () => {
    const { project, turn, events, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "index.html", content: "<main>实时内容</main>" }
    } as AgentSessionEvent, state);

    const item = store.getTurn(turn.id)?.items.find(({ type }) => type === "file_change");
    expect(item).toMatchObject({
      type: "file_change",
      action: "create",
      path: "index.html",
      contentSnapshot: "<main>实时内容</main>",
      status: "in_progress"
    });
    expect(events.find(({ kind }) => kind === "item_started")?.data).toMatchObject({
      contentSnapshot: "<main>实时内容</main>"
    });
  });

  it("write 失败时持久化并发布具体错误", () => {
    const { project, turn, events, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "tool_execution_start",
      toolCallId: "write-failed",
      toolName: "write",
      args: { path: "docs/technical-decisions.md", content: "# Decisions" }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "tool_execution_end",
      toolCallId: "write-failed",
      toolName: "write",
      result: {
        content: [{ type: "text", text: "当前阶段只能维护指定文档" }]
      },
      isError: true
    } as AgentSessionEvent, state);

    const item = store.getTurn(turn.id)?.items.find(({ type }) => type === "file_change");
    expect(item).toMatchObject({
      type: "file_change",
      status: "failed",
      output: "当前阶段只能维护指定文档"
    });
    expect(
      events.find(({ kind }) => kind === "item_command_output_snapshot")?.data
    ).toMatchObject({
      turnId: turn.id,
      itemId: item?.id,
      output: "当前阶段只能维护指定文档"
    });
    expect(events.find(({ kind }) => kind === "item_completed")?.data).toMatchObject({
      type: "file_change",
      status: "failed",
      output: "当前阶段只能维护指定文档"
    });
  });

  it("write 工具参数生成期间发布 UI 文件创建和内容追加事件", () => {
    const { project, turn, events, handle, state } = harness();
    const firstPartial = {
      ...partial,
      content: [{
        type: "toolCall",
        id: "write-stream-1",
        name: "write",
        arguments: { path: "index.html", content: "<main>" }
      }]
    };
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"index.html","content":"<main>',
        partial: firstPartial
      }
    } as AgentSessionEvent, state);

    expect(store.getTurn(turn.id)?.items.map(({ type }) => type)).toEqual(["user_message"]);
    expect(events.find(({ kind }) => kind === "file_create")?.data).toEqual({
      turnId: turn.id,
      streamId: "write-stream-1",
      path: "index.html",
      action: "create"
    });
    expect(events.find(({ kind }) => kind === "file_append")?.data).toEqual({
      turnId: turn.id,
      streamId: "write-stream-1",
      path: "index.html",
      offset: 0,
      delta: "<main>"
    });

    const finalPartial = {
      ...partial,
      content: [{
        type: "toolCall",
        id: "write-stream-1",
        name: "write",
        arguments: { path: "index.html", content: "<main>实时</main>" }
      }]
    };
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '实时</main>"}',
        partial: finalPartial
      }
    } as AgentSessionEvent, state);

    expect(events.filter(({ kind }) => kind === "file_create")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "file_append").at(-1)?.data).toEqual({
      turnId: turn.id,
      streamId: "write-stream-1",
      path: "index.html",
      offset: 6,
      delta: "实时</main>"
    });
  });

  it("路径字符串未完整生成时不创建 UI 文件", () => {
    const { project, turn, events, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"index.ht',
        partial: {
          ...partial,
          content: [{
            type: "toolCall",
            id: "write-stream-2",
            name: "write",
            arguments: { path: "index.ht" }
          }]
        }
      }
    } as AgentSessionEvent, state);

    expect(events.map(({ kind }) => kind).filter((kind) => kind.startsWith("file_"))).toEqual([]);
  });

  it("同一 contentIndex 的连续 write 按 toolCall ID 隔离文件流", () => {
    const { project, turn, events, handle, state } = harness();
    const writeDelta = (
      id: string,
      path: string,
      content: string
    ) => {
      handle(project.id, turn.id, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 1,
          delta: `{"path":"${path}","content":"${content}"}`,
          partial: {
            ...partial,
            content: [
              { type: "text", text: "创建文件" },
              {
                type: "toolCall",
                id,
                name: "write",
                arguments: { path, content }
              }
            ]
          }
        }
      } as AgentSessionEvent, state);
    };

    writeDelta("write-index", "index.html", "<main />");
    writeDelta("write-style", "style.css", "body {}");

    expect(
      events
        .filter(({ kind }) => kind === "file_create")
        .map(({ data }) => ({ streamId: data.streamId, path: data.path }))
    ).toEqual([
      { streamId: "write-index", path: "index.html" },
      { streamId: "write-style", path: "style.css" }
    ]);
    expect(
      events
        .filter(({ kind }) => kind === "file_append")
        .map(({ data }) => ({ streamId: data.streamId, path: data.path, delta: data.delta }))
    ).toEqual([
      { streamId: "write-index", path: "index.html", delta: "<main />" },
      { streamId: "write-style", path: "style.css", delta: "body {}" }
    ]);
  });

  it("write 先生成 content 时使用 file_create 预告路径持续发布内容", () => {
    const { project, turn, events, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"styles.css"}',
        partial: {
          ...partial,
          content: [{
            type: "toolCall",
            id: "announce-styles",
            name: "file_create",
            arguments: { path: "styles.css" }
          }]
        }
      }
    } as AgentSessionEvent, state);

    handle(project.id, turn.id, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"content":"body { color: blue; }"',
        partial: {
          ...partial,
          content: [{
            type: "toolCall",
            id: "write-styles",
            name: "write",
            arguments: { content: "body { color: blue; }" }
          }]
        }
      }
    } as AgentSessionEvent, state);

    expect(
      events
        .filter(({ kind }) => kind === "file_create")
        .map(({ data }) => ({ streamId: data.streamId, path: data.path }))
    ).toEqual([{ streamId: "announce-styles", path: "styles.css" }]);
    expect(events.filter(({ kind }) => kind === "file_append").at(-1)?.data).toEqual({
      turnId: turn.id,
      streamId: "announce-styles",
      path: "styles.css",
      offset: 0,
      delta: "body { color: blue; }"
    });
    expect(store.getTurn(turn.id)?.items.map(({ type }) => type)).toEqual(["user_message"]);
  });

  it("命令累计输出使用快照替换而不是重复追加", () => {
    const { project, turn, events, handle, state } = harness();
    handle(project.id, turn.id, {
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "printf first; printf second" }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "tool_execution_update",
      toolCallId: "bash-1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "first" }] }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "tool_execution_update",
      toolCallId: "bash-1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "firstsecond" }] }
    } as AgentSessionEvent, state);

    const command = store.getTurn(turn.id)?.items.find(
      ({ type }) => type === "command_execution"
    );
    expect(command).toMatchObject({ output: "firstsecond" });
    expect(
      events
        .filter(({ kind }) => kind === "item_command_output_snapshot")
        .map(({ data }) => data.output)
    ).toEqual(["first", "firstsecond"]);
  });

  it("TodoWrite 产生独立 todo_list item 并实时完成", () => {
    const { project, turn, events, handle, state } = harness();
    const todos = [
      { content: "梳理需求", status: "completed" },
      { content: "实现功能", status: "in_progress" },
      { content: "验证结果", status: "pending" }
    ];
    handle(project.id, turn.id, {
      type: "tool_execution_start",
      toolCallId: "todo-1",
      toolName: "todo_write",
      args: { todos }
    } as AgentSessionEvent, state);
    handle(project.id, turn.id, {
      type: "tool_execution_end",
      toolCallId: "todo-1",
      toolName: "todo_write",
      result: { content: [{ type: "text", text: "待办事项已更新：1/3 已完成" }] },
      isError: false
    } as AgentSessionEvent, state);

    const item = store.getTurn(turn.id)?.items.find(({ type }) => type === "todo_list");
    expect(item).toMatchObject({ type: "todo_list", status: "completed", todos });
    expect(events.filter(({ kind }) => kind === "item_started")).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === "item_completed")).toHaveLength(1);
    expect(events.map(({ kind }) => kind)).not.toContain("item_command_output_snapshot");
  });
});

describe("AgentRunner 系统提示", () => {
  it("要求在 thinking 与工具调用之间先播报用户可见进展", () => {
    const prompt = buildAgentPrompt("创建一个世界杯网站");
    expect(prompt).toContain("准备首次调用工具或进入下一执行阶段前");
    expect(prompt).toContain("先输出一句面向用户的简短进展说明，再调用工具");
    expect(prompt).toContain("不要在没有任何面向用户文字的情况下从思考直接进入工具调用");
    expect(prompt).toContain("连续执行高度相关的工具可以合并播报");
    expect(prompt).toContain("不暴露内部推理");
    expect(prompt).toContain("每次调用工具时都填写 description 参数");
    expect(prompt).toContain("面向用户");
    expect(prompt).toContain("始终使用 todo_write 工具规划和跟踪多步骤任务");
    expect(prompt).toContain("进度变化时更新完整列表");
    expect(prompt).toContain("用户需求：创建一个世界杯网站");
  });

  it("需求讨论阶段只访谈产品决策并把技术选择留到技术设计阶段", () => {
    const workItem = {
      id: "work-1",
      projectId: "project-1",
      type: "structured_requirement",
      requirementSequence: 1,
      title: "世界杯网站",
      workflowState: "requirements_discussion",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-1",
      revision: 1,
      error: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;

    const prompt = buildWorkItemPrompt(
      "使用 NestJS 和 Mock 数据制作世界杯网站，其他选择采用最优方案",
      workItem
    );

    expect(prompt).toContain("需求讨论只解决产品层决策");
    expect(prompt).toContain("SSR/SPA");
    expect(prompt).toContain("模块划分、API 设计");
    expect(prompt).toContain("只作为已确认的实现约束记录");
    expect(prompt).toContain("不要继续提问");
    expect(prompt).toContain("待办列表和需求草稿也必须保持产品视角");
    expect(prompt).not.toContain("relentlessly");
    expect(prompt).not.toContain("design tree");
  });

  it("需求确认后要求先根据完整对话生成带编号的正式需求文档", () => {
    const workItem = {
      id: "work-1",
      projectId: "project-1",
      type: "structured_requirement",
      requirementSequence: 7,
      title: "版本管理",
      workflowState: "requirements_pending_confirmation",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-1",
      revision: 1,
      error: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;

    const prompt = buildWorkItemPrompt("整理正式需求文档", workItem);

    expect(prompt).toContain("前面完整对话中已确认的结论");
    expect(prompt).toContain("docs/requirements/R007-<short-slug>/");
    expect(prompt).toContain("当前任务不是继续访谈");
    expect(prompt).toContain("用户明确给出的技术信息只记录为实现约束");
    expect(prompt).toContain("不得自行补充技术选型");
  });

  it("只接受当前需求编号目录下的 Markdown 作为阶段门禁", async () => {
    const root = await mkdtemp(join(tmpdir(), "atoms-requirement-doc-"));
    try {
      await mkdir(join(root, "docs", "requirements", "R006-old"), { recursive: true });
      await writeFile(join(root, "docs", "requirements", "R006-old", "README.md"), "# 旧需求");
      expect(await findConfirmedRequirementDocument(root, 7)).toBeNull();

      const expected = join(root, "docs", "requirements", "R007-version-management", "README.md");
      await mkdir(join(root, "docs", "requirements", "R007-version-management"), {
        recursive: true
      });
      await writeFile(expected, "# 已确认需求");
      expect(await findConfirmedRequirementDocument(root, 7)).toBe(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("测试准入提示要求先告知失败项、自动修复并输出机器可校验报告", () => {
    const workItem = {
      id: "work-2",
      projectId: "project-1",
      type: "structured_requirement",
      requirementSequence: 8,
      title: "测试准入",
      workflowState: "testing_admission",
      executionState: "idle",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-2",
      revision: 1,
      error: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;

    const prompt = buildWorkItemPrompt("执行测试准入", workItem);

    expect(prompt).toContain("先用简短进展消息向用户明确失败项");
    expect(prompt).toContain("直接修复代码或测试并重新执行");
    expect(prompt).toContain("docs/test-reports/R008-admission.json");
    expect(prompt).toContain("checks 每项使用 id 字段");
    expect(prompt).toContain("只有复检全部通过后才能写 status=passed");
  });

  it("测试准入只接受检查项和执行证据完整的通过报告", async () => {
    const root = await mkdtemp(join(tmpdir(), "atoms-testing-admission-"));
    const reports = join(root, "docs", "test-reports");
    const requirements = join(root, "docs", "requirements", "R008-testing-admission");
    const technical = join(root, "docs", "technical");
    const reportPath = join(reports, "R008-admission.json");
    await mkdir(requirements, { recursive: true });
    await mkdir(technical, { recursive: true });
    await mkdir(reports, { recursive: true });
    try {
      await writeFile(join(requirements, "README.md"), "# 测试准入");
      await writeFile(join(technical, "R008-testing-admission.md"), "# 技术方案");
      await writeFile(
        reportPath,
        JSON.stringify({
          requirement: "R008",
          status: "passed",
          checks: [
            { name: "requirements_document", status: "passed", evidence: "README.md" },
            { name: "technical_design", status: "passed", evidence: "technical.md" },
            { name: "implementation_complete", status: "passed", evidence: "diff reviewed" },
            { name: "automated_tests", status: "passed", evidence: "12 tests passed" },
            { name: "typecheck", status: "passed", evidence: "tsc passed" },
            { name: "lint", status: "not_applicable", evidence: "project has no lint script" },
            { name: "build", status: "passed", evidence: "vite build passed" }
          ],
          commands: [
            { command: "npm test", exitCode: 0, summary: "12 tests passed" }
          ],
          failuresFound: 1,
          repairsApplied: ["fixed test"]
        })
      );
      expect(await validateTestingAdmissionReport(root, 8)).toBe(reportPath);

      await writeFile(
        reportPath,
        JSON.stringify({
          requirement: "R008",
          status: "passed",
          checks: [],
          commands: [],
          failuresFound: 0,
          repairsApplied: []
        })
      );
      await expect(validateTestingAdmissionReport(root, 8)).rejects.toThrow(
        "requirements_document"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("测试准入失败时最多自动创建两轮修复，停止和超时不自动重试", () => {
    const workItem = {
      id: "work-3",
      projectId: "project-1",
      type: "structured_requirement",
      requirementSequence: 9,
      title: "自动修复",
      workflowState: "testing_admission",
      executionState: "failed",
      baseCommit: "a".repeat(40),
      branchRef: "refs/heads/work/work-3",
      revision: 1,
      error: "准入失败",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      archivedAt: null,
      publishedVersionId: null
    } satisfies WorkItem;

    expect(shouldAutoRepairTestingAdmission(workItem, "failed", false, 0)).toBe(true);
    expect(shouldAutoRepairTestingAdmission(workItem, "failed", false, 1)).toBe(true);
    expect(shouldAutoRepairTestingAdmission(workItem, "failed", false, 2)).toBe(false);
    expect(shouldAutoRepairTestingAdmission(workItem, "cancelled", false, 0)).toBe(false);
    expect(shouldAutoRepairTestingAdmission(workItem, "failed", true, 0)).toBe(false);
  });
});
