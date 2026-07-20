import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildApp,
  cleanupExpiredPendingUploads,
  rewritePreviewLocation
} from "./app.js";
import { openMemoryDatabase } from "./db.js";
import { Store } from "./store.js";
import type { AppConfig } from "./config.js";
import type { AgentRunner } from "./agent-runner.js";
import { ensureProjectPaths } from "./paths.js";
import { RealtimeHub } from "./realtime.js";
import { ReleaseValidationError } from "./release-validation.js";
import { PreviewManager } from "./preview-manager.js";
import { PreviewThumbnailer } from "./preview-thumbnail.js";
import { VersionControl } from "./version-control.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  workspaceRoot: "/tmp/atoms-demo-tests",
  databasePath: ":memory:",
  deepseekKeyFile: "/tmp/unused",
  deepseekModel: "deepseek-v4-pro",
  releaseMetadataModel: "deepseek-v4-flash",
  publicDomain: "localhost",
  isProduction: false
};

async function writeRequirementPackage(
  guestId: string,
  projectId: string,
  requirementSequence = 1
): Promise<void> {
  const paths = await ensureProjectPaths(config, guestId, projectId);
  const sequence = `R${String(requirementSequence).padStart(3, "0")}`;
  const root = `${paths.projectRoot}/docs/requirements/${sequence}-feature`;
  await mkdir(root, { recursive: true });
  await writeFile(
    `${root}/README.md`,
    [
      "# 功能需求",
      "## 总体目标",
      "交付可验收功能。",
      "## 范围",
      "使用推荐默认方案。",
      "## 非目标",
      "无。",
      "## 依赖",
      "无。",
      "## 原子需求索引",
      "- [核心功能](./REQ-01.md)",
      "## 决策记录",
      "此前待确认的事项已采用默认方案。"
    ].join("\n")
  );
  await writeFile(
    `${root}/REQ-01.md`,
    [
      "# 核心功能",
      "## 目标",
      "提供核心能力。",
      "## 需求",
      "按默认方案实现。",
      "## 验收标准",
      "用户可见功能结果。",
      "## 非目标",
      "无。",
      "## 原子性检查",
      "可独立验收。"
    ].join("\n")
  );
}

describe("动态预览代理", () => {
  it("把框架返回的本地运行端口重定向改写为公开预览域名", () => {
    const target = { hostname: "127.0.0.1", port: 36787 };
    const origin = "https://p-project.example.com";

    expect(
      rewritePreviewLocation("https://localhost:36787/en?tab=1#hero", target, origin)
    ).toBe("https://p-project.example.com/en?tab=1#hero");
    expect(rewritePreviewLocation("/en", target, origin)).toBe("/en");
    expect(rewritePreviewLocation("https://example.org/en", target, origin)).toBe(
      "https://example.org/en"
    );
    expect(rewritePreviewLocation(undefined, target, origin)).toBeUndefined();
  });
});

describe("HTTP API", () => {
  let db: Database.Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let store: Store;
  let hub: RealtimeHub;
  const runner = {
    kick: vi.fn(),
    stop: vi.fn()
  } as unknown as AgentRunner;

  beforeEach(async () => {
    db = openMemoryDatabase();
    store = new Store(db);
    hub = new RealtimeHub();
    app = await buildApp({
      config,
      store,
      hub,
      runner,
      releaseMetadataGenerator: async (workItem) => ({
        title: workItem.title,
        summary:
          workItem.type === "structured_requirement"
            ? "完成结构化需求的实现与验证"
            : "完成当前工作的直接编码改动"
      })
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    vi.clearAllMocks();
  });

  it("游客列表始终有 default，并可创建合法游客", async () => {
    const list = await app.inject({ method: "GET", url: "/api/guests" });
    expect(list.json().items[0].name).toBe("default");
    const created = await app.inject({
      method: "POST",
      url: "/api/guests",
      payload: { name: "小明" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().name).toBe("小明");
  });

  it("无效首页需求不创建项目，有效需求只创建一次并启动任务", async () => {
    const guest = store.listGuests()[0];
    const invalid = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "   " }
    });
    expect(invalid.statusCode).toBe(400);
    expect(store.listProjects(guest.id).items).toHaveLength(0);
    const valid = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "做一个待办应用" }
    });
    expect(valid.statusCode).toBe(201);
    expect(store.listProjects(guest.id).items).toHaveLength(1);
    expect(runner.kick).toHaveBeenCalledTimes(1);
  });

  it("服务端拒绝未二次确认的结构化需求创建且不产生副作用", async () => {
    const guest = store.listGuests()[0];
    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "规划支付流程", mode: "structured_requirement" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "work_item_confirmation_required" }
    });
    expect(store.listProjects(guest.id).items).toEqual([]);
    expect(runner.kick).not.toHaveBeenCalled();
  });

  it("结构化需求入口同时拒绝未确认请求和偏离正式版本的工作区", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "先做直接编码" }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    await writeFile(`${paths.projectRoot}/unpublished.txt`, "dirty");
    store.archiveWorkItem(payload.workItem.id, "abandoned");

    const unconfirmed = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items`,
      payload: { text: "新需求", type: "structured_requirement" }
    });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({
      error: { code: "work_item_confirmation_required" }
    });

    const dirty = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items`,
      payload: {
        text: "新需求",
        type: "structured_requirement",
        confirmed: true
      }
    });
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toMatchObject({
      error: { code: "workspace_not_at_formal_version" }
    });
    expect(store.getActiveWorkItem(payload.project.id)).toBeNull();
    expect(store.listWorkItems(payload.project.id).items).toHaveLength(1);
  });

  it("项目实时连接传递 item delta，并在重连后返回权威 items 快照", async () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "流式回复", "开始");
    store.claimNextTurn(project.id);
    const assistant = store.createAssistantItem(project.id, turn.id, "commentary");
    store.appendAssistantText(assistant.id, "第一段");
    await app.ready();

    let resolveFirstSnapshot!: (value: Record<string, any>) => void;
    const firstSnapshotReceived = new Promise<Record<string, any>>((resolve) => {
      resolveFirstSnapshot = resolve;
    });
    const firstSocket = await app.injectWS(
      `/ws/projects/${project.id}?guestId=${encodeURIComponent(guest.id)}`,
      {},
      {
        onInit: (socket) => {
          socket.once("message", (data) =>
            resolveFirstSnapshot(JSON.parse(data.toString()))
          );
        }
      }
    );
    const firstSnapshot = await firstSnapshotReceived;
    expect(firstSnapshot.kind).toBe("sync");
    expect(firstSnapshot.data.turns[0].items).toEqual([
      expect.objectContaining({ type: "user_message", text: "开始" }),
      expect.objectContaining({ id: assistant.id, text: "第一段" })
    ]);

    const liveDelta = new Promise<Record<string, any>>((resolve) => {
      firstSocket.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    store.appendAssistantText(assistant.id, "，第二段");
    hub.publish(project.id, "item_assistant_message_delta", {
      turnId: turn.id,
      itemId: assistant.id,
      delta: "，第二段"
    }, assistant.id);
    expect(await liveDelta).toMatchObject({
      kind: "item_assistant_message_delta",
      data: { turnId: turn.id, itemId: assistant.id, delta: "，第二段" }
    });
    firstSocket.terminate();

    store.appendAssistantText(assistant.id, "，断线补齐");
    let resolveRecovered!: (value: Record<string, any>) => void;
    const recoveredSnapshot = new Promise<Record<string, any>>((resolve) => {
      resolveRecovered = resolve;
    });
    const reconnected = await app.injectWS(
      `/ws/projects/${project.id}?guestId=${encodeURIComponent(guest.id)}`,
      {},
      {
        onInit: (socket) => {
          socket.once("message", (data) => resolveRecovered(JSON.parse(data.toString())));
        }
      }
    );
    const recovered = await recoveredSnapshot;
    expect(recovered.data.turns[0].items).toContainEqual(
      expect.objectContaining({
        id: assistant.id,
        text: "第一段，第二段，断线补齐"
      })
    );
    reconnected.terminate();
  });

  it("停止接口强制二次确认并记录按钮或自然语言来源", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "运行一个长任务" }
    });
    const payload = created.json();
    const running = store.claimNextTurn(payload.project.id)!;

    const unconfirmed = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/turns/${running.id}/stop`,
      payload: {}
    });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({
      error: { code: "action_confirmation_required" }
    });
    expect(runner.stop).not.toHaveBeenCalled();

    (runner.stop as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_projectId: string, turnId: string) =>
        store.finishTurn(turnId, "cancelled")
    );
    const revision = store.getWorkItem(payload.workItem.id)!.revision;
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/turns/${running.id}/stop`,
      payload: {
        confirmed: true,
        revision: revision - 1,
        idempotencyKey: "natural-stop-1",
        source: "natural_language"
      }
    });

    expect(confirmed.statusCode, JSON.stringify(confirmed.json())).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "cancelled" });
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "direct_coding",
      executionState: "stopped"
    });
    expect(store.listWorkItemEvents(payload.workItem.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "confirmed_action",
          source: "natural_language",
          details: expect.objectContaining({ action: "stop", turnId: running.id })
        })
      ])
    );
  });

  it("其他游客访问项目时只得到统一不可用信息", async () => {
    const owner = store.listGuests()[0];
    const stranger = store.createGuest("旁观者");
    const { project } = store.createProjectWithTurn(owner.id, "私有身份边界", "内容");
    const response = await app.inject({
      method: "GET",
      url: `/api/guests/${stranger.id}/projects/${project.id}`
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "project_unavailable", message: "项目不可用" }
    });
  });

  it("图片随消息原子保存并可由所属游客预览", async () => {
    const guest = store.listGuests()[0];
    const bytes = Buffer.from("image-bytes");
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: {
        text: "参考图片创建页面",
        images: [{
          name: "reference.png",
          type: "image/png",
          size: bytes.length,
          data: bytes.toString("base64")
        }]
      }
    });
    expect(created.statusCode).toBe(201);
    const payload = created.json();
    const userItem = payload.turn.items.find(({ type }: { type: string }) => type === "user_message");
    expect(userItem.attachments).toHaveLength(1);
    const attachment = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/turns/${payload.turn.id}/items/${userItem.id}/attachments/${userItem.attachments[0].id}`
    });
    expect(attachment.statusCode).toBe(200);
    expect(attachment.rawPayload).toEqual(bytes);
  });

  it("图片逐张独立上传后可由消息引用，且不设置消息图片数量上限", async () => {
    const guest = store.listGuests()[0];
    const bytes = Buffer.from("independent-image");
    const boundary = "atoms-test-boundary";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="independent.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const uploaded = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "POST",
          url: `/api/guests/${guest.id}/uploads`,
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: multipart
        })
      )
    );
    expect(uploaded.every(({ statusCode }) => statusCode === 201)).toBe(true);

    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: {
        text: "使用独立上传图片",
        uploadIds: uploaded.map((response) => response.json().id)
      }
    });
    expect(created.statusCode).toBe(201);
    const userItem = created.json().turn.items.find(
      ({ type }: { type: string }) => type === "user_message"
    );
    expect(userItem.attachments).toHaveLength(8);
    expect(userItem.attachments).toEqual(
      expect.arrayContaining(
        uploaded.map((response) =>
          expect.objectContaining({
            id: response.json().id,
            originalName: "independent.png",
            size: bytes.length
          })
        )
      )
    );
  });

  it("移除待发送图片会立即删除临时记录和文件", async () => {
    const guest = store.listGuests()[0];
    const storagePath = `/tmp/atoms-demo-tests/delete-${crypto.randomUUID()}.png`;
    await writeFile(storagePath, "pending");
    const pending = store.createPendingUpload({
      id: crypto.randomUUID(),
      guestId: guest.id,
      originalName: "delete.png",
      mimeType: "image/png",
      size: 7,
      storagePath
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/guests/${guest.id}/uploads/${pending.id}`
    });

    expect(removed.statusCode).toBe(204);
    expect(store.getPendingUploads(guest.id, [pending.id])).toEqual([]);
    await expect(readFile(storagePath)).rejects.toThrow();
  });

  it("自动清理超过 24 小时仍未发送的临时图片", async () => {
    const guest = store.listGuests()[0];
    const storagePath = `/tmp/atoms-demo-tests/expired-${crypto.randomUUID()}.jpg`;
    await writeFile(storagePath, "expired");
    const pending = store.createPendingUpload({
      id: crypto.randomUUID(),
      guestId: guest.id,
      originalName: "expired.jpg",
      mimeType: "image/jpeg",
      size: 7,
      storagePath
    });

    await expect(
      cleanupExpiredPendingUploads(store, Date.now() + 25 * 60 * 60 * 1000)
    ).resolves.toBe(1);
    expect(store.getPendingUploads(guest.id, [pending.id])).toEqual([]);
    await expect(readFile(storagePath)).rejects.toThrow();
  });

  it("任一图片无效时整条首页提交失败且不留下项目", async () => {
    const guest = store.listGuests()[0];
    const before = store.listProjects(guest.id).items.length;
    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: {
        text: "不能部分发送",
        images: [
          { name: "ok.png", type: "image/png", size: 1, data: Buffer.from("a").toString("base64") },
          { name: "bad.webp", type: "image/webp", size: 1, data: Buffer.from("b").toString("base64") }
        ]
      }
    });
    expect(response.statusCode).toBe(400);
    expect(store.listProjects(guest.id).items).toHaveLength(before);
  });

  it("直接编码工作经二次确认发布 V1，并可浏览不可变代码快照", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "实现版本示例", mode: "direct_coding" }
    });
    expect(created.statusCode).toBe(201);
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    await writeFile(paths.projectRoot + "/versioned.txt", "immutable V1");
    const publishRevision = store.getWorkItem(payload.workItem.id)!.revision;
    const publishKey = "publish-version-1";

    const confirmation = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        source: "button",
        revision: publishRevision,
        idempotencyKey: publishKey
      }
    });
    expect(confirmation.json()).toMatchObject({
      confirmationRequired: true,
      action: "publish",
      suggestedTitle: payload.workItem.title,
      suggestedSummary: expect.stringContaining("直接编码改动")
    });

    const published = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        confirmed: true,
        title: "首个代码版本",
        summary: "直接编码验证",
        revision: publishRevision,
        idempotencyKey: publishKey
      }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().version).toMatchObject({
      sequence: 1,
      tagRef: "refs/tags/code/v1",
      title: "首个代码版本"
    });
    expect(store.listWorkItemEvents(payload.workItem.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "publish_attempt",
          actorGuestId: guest.id,
          details: expect.objectContaining({ action: "publish" })
        }),
        expect.objectContaining({
          kind: "checkpoint",
          details: expect.objectContaining({ name: "Release candidate" })
        }),
        expect.objectContaining({
          kind: "published",
          actorGuestId: guest.id,
          details: expect.objectContaining({ versionId: published.json().version.id })
        })
      ])
    );
    expect(store.listNotifications(guest.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "版本发布成功",
          versionId: published.json().version.id,
          targetUrl: expect.stringContaining(
            `section=versions&version=${published.json().version.id}`
          )
        })
      ])
    );

    const files = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/versions/${published.json().version.id}/files`
    });
    expect(files.json().items).toContainEqual(
      expect.objectContaining({ path: "versioned.txt", type: "file" })
    );
    const file = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/versions/${published.json().version.id}/file?path=versioned.txt`
    });
    expect(file.json()).toMatchObject({ kind: "text", content: "immutable V1" });
    const versionId = published.json().version.id as string;
    const performanceEndpoints = {
      currentWork: `/api/guests/${guest.id}/projects/${payload.project.id}`,
      versionHistory: `/api/guests/${guest.id}/projects/${payload.project.id}/versions`,
      workRecords: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items`,
      versionFiles: `/api/guests/${guest.id}/projects/${payload.project.id}/versions/${versionId}/files`,
      singleFileDiff: `/api/guests/${guest.id}/projects/${payload.project.id}/versions/${versionId}/diff?path=versioned.txt`
    };
    const performanceP95: Record<string, number> = {};
    for (const [name, url] of Object.entries(performanceEndpoints)) {
      const samples: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const startedAt = performance.now();
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        samples.push(performance.now() - startedAt);
      }
      samples.sort((left, right) => left - right);
      performanceP95[name] = samples[Math.ceil(samples.length * 0.95) - 1];
    }
    expect(performanceP95.currentWork).toBeLessThan(2_000);
    expect(performanceP95.versionHistory).toBeLessThan(2_000);
    expect(performanceP95.workRecords).toBeLessThan(2_000);
    expect(performanceP95.versionFiles).toBeLessThan(2_000);
    expect(performanceP95.singleFileDiff).toBeLessThan(3_000);
    console.info(
      "version-workflow-p95-ms",
      Object.fromEntries(
        Object.entries(performanceP95).map(([name, duration]) => [
          name,
          Number(duration.toFixed(1))
        ])
      )
    );
    const releaseRecord = await readFile(
      `${paths.projectRoot}/docs/releases/V1.md`,
      "utf8"
    );
    expect(releaseRecord).toContain("- 来源：直接编码");
    expect(releaseRecord).toContain("- 候选提交：");
    expect(releaseRecord).toContain("- Git tag：code/v1");
    expect(releaseRecord).toContain("- 累计 Diff：");
    expect(releaseRecord).toContain("added：versioned.txt");
    expect(releaseRecord).toContain("- 最低文件与配置：");
    expect(releaseRecord).toContain("- 发布结果：成功");
    expect(releaseRecord).toContain("- 测试与构建：");
    expect(releaseRecord).toContain("- 预览：非网页项目，无需预览门禁");
  });

  it("发布前门禁失败时不占用版本号并保留活动工作供重新确认", async () => {
    await app.close();
    app = await buildApp({
      config,
      store,
      hub,
      runner,
      releaseValidator: async () => {
        throw new ReleaseValidationError(
          "quality_check_failed",
          "发布前检查失败：npm run test",
          "1 test failed"
        );
      }
    });
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "失败门禁示例", mode: "direct_coding" }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    await writeFile(`${paths.projectRoot}/candidate.txt`, "not published");
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        confirmed: true,
        revision,
        idempotencyKey: "failed-preflight-1"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "quality_check_failed",
        message: expect.stringContaining("npm run test"),
        evidence: "1 test failed"
      }
    });
    expect(store.listCodeVersions(payload.project.id).items).toEqual([]);
    expect(store.nextCodeVersionSequence(payload.project.id)).toBe(1);
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "direct_coding",
      executionState: "idle",
      archivedAt: null,
      error: expect.stringContaining("npm run test")
    });
  });

  it("直接编码没有累计改动时拒绝发布且不占用版本号", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "只讨论不改文件", mode: "direct_coding" }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        confirmed: true,
        revision,
        idempotencyKey: "unchanged-publish-1"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "release_candidate_unchanged" }
    });
    expect(store.nextCodeVersionSequence(payload.project.id)).toBe(1);
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "direct_coding",
      executionState: "idle",
      archivedAt: null
    });
  });

  it("预检后的 Git 发布失败会收敛执行状态并保留活动工作", async () => {
    await app.close();
    const failingVersions = new VersionControl();
    vi.spyOn(failingVersions, "publish").mockRejectedValue(
      new Error("merge transaction failed")
    );
    app = await buildApp({
      config,
      store,
      hub,
      runner,
      versions: failingVersions,
      releaseMetadataGenerator: async (workItem) => ({
        title: workItem.title,
        summary: "累计直接编码改动"
      })
    });
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "验证发布失败收敛", mode: "direct_coding" }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    await writeFile(`${paths.projectRoot}/candidate.txt`, "candidate");
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        confirmed: true,
        revision,
        idempotencyKey: "failed-git-publish-1"
      }
    });

    expect(response.statusCode).toBe(500);
    expect(store.listCodeVersions(payload.project.id).items).toEqual([]);
    expect(store.nextCodeVersionSequence(payload.project.id)).toBe(1);
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "direct_coding",
      executionState: "idle",
      archivedAt: null,
      error: "merge transaction failed"
    });
    expect(store.listWorkItemEvents(payload.workItem.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "publish_failed",
          details: expect.objectContaining({ error: "merge transaction failed" })
        })
      ])
    );
  });

  it("发布事务进行中可从服务端快照看到进度并在完成后收敛", async () => {
    await app.close();
    let markStarted!: () => void;
    let finishValidation!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    app = await buildApp({
      config,
      store,
      hub,
      runner,
      releaseValidator: async ({ projectId }) => {
        markStarted();
        await validationGate;
        return {
          status: "passed",
          checks: [
            { id: "test", status: "not_applicable", evidence: "无测试脚本" },
            { id: "typecheck", status: "not_applicable", evidence: "无类型检查脚本" },
            { id: "lint", status: "not_applicable", evidence: "无 Lint 脚本" },
            { id: "build", status: "not_applicable", evidence: "无构建脚本" },
            { id: "sensitive_content", status: "passed", evidence: "未发现敏感内容" },
            { id: "preview", status: "not_applicable", evidence: "非网页项目" }
          ],
          commands: [],
          preview: {
            projectId,
            previewCapable: false,
            previewStatus: "none",
            previewUrl: null,
            previewError: null
          },
          validatedAt: "2026-07-20T00:00:00.000Z"
        };
      }
    });
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "可观察发布进度", mode: "direct_coding" }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    await writeFile(`${paths.projectRoot}/candidate.txt`, "candidate");
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const publishing = app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        confirmed: true,
        revision,
        idempotencyKey: "observable-publish-key"
      }
    });
    await started;
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      executionState: "running",
      archivedAt: null
    });

    finishValidation();
    const response = await publishing;
    expect(response.statusCode).toBe(200);
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "published",
      executionState: "idle",
      archivedAt: expect.any(String)
    });
  });

  it("结构化需求的候选预览门禁失败后仍停留待上线", async () => {
    await app.close();
    app = await buildApp({
      config,
      store,
      hub,
      runner,
      releaseValidator: async () => {
        throw new ReleaseValidationError(
          "preview_unavailable",
          "候选预览启动失败，已阻止发布",
          "application boot failed"
        );
      }
    });
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "结构化发布示例", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    store.transitionWorkItem(
      payload.workItem.id,
      "pending_release",
      "system",
      guest.id
    );
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        confirmed: true,
        revision,
        idempotencyKey: "failed-preview-1"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("preview_unavailable");
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "pending_release",
      executionState: "idle",
      archivedAt: null,
      error: expect.stringContaining("候选预览")
    });
    expect(store.nextCodeVersionSequence(payload.project.id)).toBe(1);
  });

  it("正式预览切换失败时回滚 main、tag 和工作分支", async () => {
    await app.close();
    const previews = new PreviewManager(config);
    vi.spyOn(previews, "refresh").mockResolvedValue({
      projectId: "placeholder",
      previewCapable: true,
      previewStatus: "failed",
      previewUrl: null,
      previewError: "formal preview failed"
    });
    app = await buildApp({
      config,
      store,
      hub,
      runner,
      previews,
      releaseValidator: async ({ projectId }) => ({
        status: "passed",
        checks: [
          { id: "test", status: "not_applicable", evidence: "无测试脚本" },
          { id: "typecheck", status: "not_applicable", evidence: "无类型检查脚本" },
          { id: "lint", status: "not_applicable", evidence: "无 Lint 脚本" },
          { id: "build", status: "not_applicable", evidence: "无构建脚本" },
          { id: "sensitive_content", status: "passed", evidence: "未发现敏感内容" },
          { id: "preview", status: "passed", evidence: "候选预览就绪" }
        ],
        commands: [],
        preview: {
          projectId,
          previewCapable: true,
          previewStatus: "ready",
          previewUrl: `/preview/${projectId}/`,
          previewError: null
        },
        validatedAt: "2026-07-20T00:00:00.000Z"
      })
    });
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "正式预览失败示例", mode: "direct_coding" }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    await writeFile(`${paths.projectRoot}/index.html`, "<main>candidate</main>");
    const versions = new VersionControl();
    const mainBefore = await versions.currentMain(paths.repositoryRoot, paths.projectRoot);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "publish",
        confirmed: true,
        revision,
        idempotencyKey: "failed-formal-preview-1"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("formal_preview_unavailable");
    expect(await versions.currentMain(paths.repositoryRoot, paths.projectRoot)).toBe(mainBefore);
    expect(store.listCodeVersions(payload.project.id).items).toEqual([]);
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "direct_coding",
      archivedAt: null
    });
    await expect(
      versions.readFileAt(paths.repositoryRoot, paths.projectRoot, mainBefore, "index.html")
    ).rejects.toThrow();
  });

  it("历史工作项对话可以按工作项和游标继续分页", async () => {
    const guest = store.listGuests()[0];
    const created = store.createProjectWithTurn(guest.id, "历史记录", "消息 1");
    store.claimNextTurn(created.project.id);
    store.finishTurn(created.turn.id, "completed");
    for (let sequence = 2; sequence <= 55; sequence += 1) {
      const turn = store.enqueueTurn(created.project.id, `消息 ${sequence}`);
      store.claimNextTurn(created.project.id);
      store.finishTurn(turn.id, "completed");
    }

    const latest = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${created.project.id}/work-items/${created.workItem.id}`
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().turns.items).toHaveLength(50);
    expect(latest.json().turns.items[0].sequence).toBe(6);
    expect(latest.json().turns.hasMore).toBe(true);

    const older = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${created.project.id}/work-items/${created.workItem.id}?before=6`
    });
    expect(older.statusCode).toBe(200);
    expect(older.json().turns.items.map(({ sequence }: { sequence: number }) => sequence))
      .toEqual([1, 2, 3, 4, 5]);
    expect(older.json().turns.hasMore).toBe(false);
  });

  it("确认需求后直接固定当前需求包并进入技术设计", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "规划一个任务管理功能", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    await writeRequirementPackage(guest.id, payload.project.id);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;
    const idempotencyKey = "confirm-requirements-1";

    const confirmation = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "confirm_requirements",
        source: "button",
        revision,
        idempotencyKey
      }
    });
    expect(confirmation.json()).toMatchObject({
      confirmationRequired: true,
      action: "confirm_requirements"
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "confirm_requirements",
        source: "button",
        confirmed: true,
        revision,
        idempotencyKey
      }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      workItem: { workflowState: "technical_design" },
      turn: {
        status: "queued",
        sequence: 2,
        items: [
          expect.objectContaining({
            type: "user_message",
            text: expect.stringContaining("采用需求文档中的推荐默认方案")
          })
        ]
      }
    });
    expect(runner.kick).toHaveBeenCalledTimes(2);
    expect(
      store.listTurns(payload.project.id, undefined, 50, payload.workItem.id).items
    ).toHaveLength(2);
  });

  it("确认时需求包尚未落盘只创建一次补全文档轮次", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "尚未落盘的需求", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "confirm_requirements",
        source: "button",
        confirmed: true,
        revision,
        idempotencyKey: "confirm-missing-package"
      }
    });

    expect(confirmed.statusCode, JSON.stringify(confirmed.json())).toBe(200);
    expect(confirmed.json()).toMatchObject({
      workItem: { workflowState: "requirements_pending_confirmation" },
      turn: {
        status: "queued",
        sequence: 2,
        items: [
          expect.objectContaining({
            text: expect.stringContaining("不要创建重复目录")
          })
        ]
      }
    });
  });

  it("同一阶段确认幂等键只成功一次，过期 revision 被拒绝", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "验证并发确认", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    await writeRequirementPackage(guest.id, payload.project.id);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;
    const actionPayload = {
      action: "confirm_requirements",
      source: "button",
      confirmed: true,
      revision,
      idempotencyKey: "same-confirmation-key"
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: actionPayload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: actionPayload
    });
    const stale = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        ...actionPayload,
        idempotencyKey: "different-stale-key"
      }
    });

    expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("action_already_processed");
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("revision_conflict");
    expect(
      store.listTurns(payload.project.id, undefined, 50, payload.workItem.id).items
        .filter(({ status }) => status === "queued")
    ).toHaveLength(1);
  });

  it("旧版需求待确认失败工作项重新执行时直接进入技术设计", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "恢复旧版需求", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    await writeRequirementPackage(guest.id, payload.project.id);
    store.transitionWorkItem(
      payload.workItem.id,
      "requirements_pending_confirmation",
      "system",
      guest.id
    );
    store.setWorkItemExecution(payload.workItem.id, "failed", "旧版全文关键词校验失败");
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const resumed = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "continue_execution",
        source: "button",
        revision,
        idempotencyKey: "resume-legacy-requirements"
      }
    });

    expect(resumed.statusCode, JSON.stringify(resumed.json())).toBe(200);
    expect(resumed.json()).toMatchObject({
      workItem: {
        workflowState: "technical_design",
        executionState: "idle",
        error: null
      },
      turn: {
        status: "queued",
        items: [
          expect.objectContaining({
            text: expect.stringContaining("推荐默认方案")
          })
        ]
      }
    });
  });

  it("无法流转时返回动作、当前阶段、允许阶段和下一步建议", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: {
        text: "验证结构化流转错误",
        mode: "structured_requirement",
        confirmed: true
      }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    store.transitionWorkItem(payload.workItem.id, "development", "system", guest.id);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const response = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "confirm_requirements",
        source: "natural_language",
        revision,
        idempotencyKey: "invalid-stage-hint-1"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_transition",
        message: expect.stringContaining("当前处于「开发」"),
        details: {
          kind: "workflow_transition",
          action: "confirm_requirements",
          actionLabel: "确认需求",
          currentState: "development",
          currentStateLabel: "开发",
          allowedStates: ["requirements_discussion"],
          allowedStateLabels: ["需求讨论"],
          guidance: expect.stringContaining("先完成当前「开发」阶段")
        }
      }
    });
    expect(store.getWorkItem(payload.workItem.id)).toMatchObject({
      workflowState: "development",
      revision
    });
  });

  it("放弃结构化工作保留原因、时间、分支与可浏览的只读快照", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "需要保留放弃快照", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    await mkdir(`${paths.projectRoot}/docs/requirements/R001`, { recursive: true });
    await writeFile(
      `${paths.projectRoot}/docs/requirements/R001/README.md`,
      "# R001\n\n放弃前草稿"
    );
    const item = store.getWorkItem(payload.workItem.id)!;
    const confirmationPayload = {
      action: "abandon",
      source: "button",
      revision: item.revision,
      idempotencyKey: "abandon-structured-work",
      reason: "方向已由用户取消"
    };
    const confirmation = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${item.id}/actions`,
      payload: confirmationPayload
    });
    expect(confirmation.json()).toMatchObject({
      confirmationRequired: true,
      action: "abandon"
    });

    const abandoned = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${item.id}/actions`,
      payload: { ...confirmationPayload, confirmed: true }
    });
    expect(abandoned.statusCode).toBe(200);
    expect(abandoned.json().workItem).toMatchObject({
      workflowState: "abandoned",
      archivedAt: expect.any(String)
    });
    const renameArchived = await app.inject({
      method: "PATCH",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${item.id}`,
      payload: { title: "不允许修改", revision: abandoned.json().workItem.revision }
    });
    expect(renameArchived.statusCode).toBe(404);

    const record = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${item.id}`
    });
    expect(record.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "abandoned",
          details: expect.objectContaining({
            reason: "方向已由用户取消",
            snapshotCommit: expect.any(String)
          })
        })
      ])
    );
    const snapshotFiles = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${item.id}/snapshot/files`
    });
    expect(snapshotFiles.statusCode).toBe(200);
    expect(snapshotFiles.json().items).toContainEqual(
      expect.objectContaining({ path: "docs", type: "directory" })
    );
    const snapshotDiff = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${item.id}/snapshot/diff`
    });
    expect(snapshotDiff.statusCode, snapshotDiff.body).toBe(200);
    expect(snapshotDiff.json().diff).toContain("放弃前草稿");
    await expect(
      new VersionControl().resolveRef(
        paths.repositoryRoot,
        paths.projectRoot,
        item.branchRef
      )
    ).resolves.toMatch(/^[a-f0-9]{40}$/);

    const nextWork = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items`,
      payload: { text: "后续工作", type: "direct_coding" }
    });
    expect(nextWork.statusCode).toBe(201);
    expect(nextWork.json().workItem.id).not.toBe(item.id);
  });

  it("重启中断后只在人工继续时创建高优先级恢复轮次", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "需要恢复的编码任务", mode: "direct_coding" }
    });
    const payload = created.json();
    store.claimNextTurn(payload.project.id);
    const queued = store.enqueueTurn(payload.project.id, "重启前排队消息");
    store.recoverInterruptedTurns();
    const interrupted = store.getWorkItem(payload.workItem.id)!;

    const resumed = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "continue_execution",
        revision: interrupted.revision,
        idempotencyKey: "manual-resume-key",
        source: "button"
      }
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      workItem: { executionState: "idle" },
      turn: {
        status: "queued",
        items: [
          expect.objectContaining({
            type: "user_message",
            text: expect.stringContaining("工作区、相对基线 Diff、待办状态和最近检查点")
          })
        ]
      }
    });
    expect(store.claimNextTurn(payload.project.id)?.id).toBe(resumed.json().turn.id);
    expect(store.getTurn(queued.id)?.status).toBe("queued");
  });

  it("开始测试时先进入准入阶段并自动创建检查修复轮次", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "规划一个任务管理功能", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    store.transitionWorkItem(payload.workItem.id, "development", "system", guest.id);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const started = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "start_testing",
        source: "button",
        revision,
        idempotencyKey: "start-testing-1"
      }
    });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      workItem: { workflowState: "testing_admission" },
      turn: {
        status: "queued",
        sequence: 2,
        items: [
          expect.objectContaining({
            type: "user_message",
            text: "执行测试阶段准入检查；发现问题时先向用户说明，再自动修复并重新检查。"
          })
        ]
      }
    });
    expect(runner.kick).toHaveBeenCalledTimes(2);
  });

  it("界面需求进入待上线前生成桌面与移动截图并校验完整测试报告", async () => {
    await app.close();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d
    ]);
    const thumbnailer = new PreviewThumbnailer(async (projectRoot, command) => {
      const outputName = /--screenshot=\/tmp\/([a-z0-9-]+\.png)/u.exec(command)?.[1];
      if (!outputName) throw new Error("截图输出名缺失");
      await writeFile(`${projectRoot}/.tmp/${outputName}`, png);
    });
    app = await buildApp({ config, store, hub, runner, thumbnailer });
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "规划一个响应式界面", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    store.transitionWorkItem(payload.workItem.id, "testing", "system", guest.id);
    store.updatePreview(payload.project.id, {
      previewCapable: true,
      previewStatus: "ready",
      previewUrl: `/preview/${payload.project.id}/`
    });
    const paths = await ensureProjectPaths(config, guest.id, payload.project.id);
    const reports = `${paths.projectRoot}/docs/test-reports`;
    await mkdir(reports, { recursive: true });
    await writeFile(
      `${reports}/R001-responsive-ui.md`,
      [
        "# R001 测试报告",
        "## 环境\nChrome",
        "## 检查点\n实现完成",
        "## 命令\nnpm test",
        "## 耗时\n1s",
        "## 摘要\n关键流程通过",
        "## 验收映射\nAC1 → 自动化测试",
        "## 界面尺寸\n桌面端 1440x900、移动端 390x844",
        "## 已知限制\n无",
        "## 最终结论\n通过"
      ].join("\n\n")
    );
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const ready = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "ready_release",
        source: "button",
        confirmed: true,
        revision,
        idempotencyKey: "ready-release-ui-1"
      }
    });

    expect(ready.statusCode).toBe(200);
    expect(ready.json().workItem.workflowState).toBe("pending_release");
    await expect(
      readFile(`${reports}/R001-assets/ui-desktop.png`)
    ).resolves.toEqual(png);
    await expect(
      readFile(`${reports}/R001-assets/ui-mobile.png`)
    ).resolves.toEqual(png);
    const report = await readFile(`${reports}/R001-responsive-ui.md`, "utf8");
    expect(report).toContain("![桌面端关键流程](./R001-assets/ui-desktop.png)");
    expect(report).toContain("![移动端关键流程](./R001-assets/ui-mobile.png)");
  });

  it("退回阶段确认信息明确包含当前阶段和目标阶段", async () => {
    const guest = store.listGuests()[0];
    const created = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects`,
      payload: { text: "规划一个任务管理功能", mode: "structured_requirement", confirmed: true }
    });
    const payload = created.json();
    store.cancelQueuedTurn(payload.turn.id);
    store.transitionWorkItem(payload.workItem.id, "development", "system", guest.id);
    const revision = store.getWorkItem(payload.workItem.id)!.revision;

    const confirmation = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "return_to_stage",
        targetState: "technical_design",
        source: "button",
        revision,
        idempotencyKey: "return-stage-1"
      }
    });

    expect(confirmation.json()).toMatchObject({
      confirmationRequired: true,
      action: "return_to_stage",
      targetState: "technical_design",
      message: "将从「开发」退回到「技术方案」阶段"
    });

    const returned = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${payload.project.id}/work-items/${payload.workItem.id}/actions`,
      payload: {
        action: "return_to_stage",
        targetState: "technical_design",
        source: "natural_language",
        confirmed: true,
        reason: "实现范围需要重新核对技术方案",
        revision,
        idempotencyKey: "return-stage-1"
      }
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().workItem.workflowState).toBe("technical_design");
    expect(store.listWorkItemEvents(payload.workItem.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "transition",
          source: "natural_language",
          fromState: "development",
          toState: "technical_design",
          details: { reason: "实现范围需要重新核对技术方案" }
        })
      ])
    );
  });

  it("预览重试可恢复静态页面，并允许隔离 iframe 加载 CSS 与 JS", async () => {
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "预览", "创建网页");
    store.updatePreview(project.id, {
      previewCapable: true,
      previewStatus: "failed",
      previewUrl: null
    });
    const paths = await ensureProjectPaths(config, guest.id, project.id);
    await writeFile(
      paths.projectRoot + "/index.html",
      '<link rel="stylesheet" href="style.css"><main>Atoms preview</main><script src="script.js"></script></body>'
    );
    await writeFile(paths.projectRoot + "/style.css", "main { color: rgb(66 103 255); }");
    await writeFile(paths.projectRoot + "/script.js", "document.body.dataset.ready = 'true';");

    const retried = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${project.id}/preview/retry`
    });
    expect(retried.json()).toMatchObject({
      previewStatus: "ready",
      previewUrl: `/preview/${project.id}/`
    });

    const preview = await app.inject({
      method: "GET",
      url: `/preview/${project.id}/`
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(preview.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(preview.body).toContain('source: "atoms-preview"');
    expect(preview.body).toContain("Atoms preview");

    const stylesheet = await app.inject({
      method: "GET",
      url: `/preview/${project.id}/style.css`
    });
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers["content-type"]).toContain("text/css");
    expect(stylesheet.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(stylesheet.body).toContain("rgb(66 103 255)");

    const script = await app.inject({
      method: "GET",
      url: `/preview/${project.id}/script.js`
    });
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(script.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(script.body).toContain("dataset.ready");
  });

  it("预览成功后生成并持久提供入口页缩略图，后续失败不清除", async () => {
    await app.close();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d
    ]);
    const thumbnailer = new PreviewThumbnailer(async (projectRoot, command) => {
      expect(command).toContain("/preview/");
      await writeFile(`${projectRoot}/.tmp/preview-thumbnail.png`, png);
    });
    app = await buildApp({ config, store, hub, runner, thumbnailer });
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "缩略图", "创建网页");
    const paths = await ensureProjectPaths(config, guest.id, project.id);
    await writeFile(paths.projectRoot + "/index.html", "<main>entry page</main>");

    const retried = await app.inject({
      method: "POST",
      url: `/api/guests/${guest.id}/projects/${project.id}/preview/retry`
    });
    expect(retried.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(store.getProject(project.id)?.thumbnailUrl).toContain(
        `/api/guests/${guest.id}/projects/${project.id}/thumbnail?v=`
      );
    });

    const thumbnail = await app.inject({
      method: "GET",
      url: store.getProject(project.id)!.thumbnailUrl!
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers["content-type"]).toContain("image/png");
    expect(thumbnail.rawPayload).toEqual(png);

    const previousUrl = store.getProject(project.id)!.thumbnailUrl;
    store.updatePreview(project.id, {
      previewCapable: true,
      previewStatus: "failed",
      previewUrl: null,
      previewError: "后续修改预览失败"
    });
    expect(store.getProject(project.id)?.thumbnailUrl).toBe(previousUrl);
  });

  it("项目列表为历史就绪预览补充缩略图地址并在首次请求时生成", async () => {
    await app.close();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d
    ]);
    const capture = vi.fn(async (projectRoot: string) => {
      await writeFile(`${projectRoot}/.tmp/preview-thumbnail.png`, png);
    });
    app = await buildApp({
      config,
      store,
      hub,
      runner,
      thumbnailer: new PreviewThumbnailer(capture)
    });
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "历史预览", "创建网页");
    const paths = await ensureProjectPaths(config, guest.id, project.id);
    await writeFile(paths.projectRoot + "/index.html", "<main>history</main>");
    store.updatePreview(project.id, {
      previewCapable: true,
      previewStatus: "stopped",
      previewUrl: null,
      previewError: null
    });

    const projects = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects`
    });
    const listed = projects.json().items.find(({ id }: { id: string }) => id === project.id);
    expect(listed.thumbnailUrl).toContain(
      `/api/guests/${guest.id}/projects/${project.id}/thumbnail?v=3-backfill-`
    );

    const thumbnail = await app.inject({ method: "GET", url: listed.thumbnailUrl });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.rawPayload).toEqual(png);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(store.getProject(project.id)?.thumbnailUrl).toContain("?v=");
    expect(store.getProject(project.id)?.previewStatus).toBe("stopped");
  });

  it("仅允许已登记项目的合法预览子域名申请证书", async () => {
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "动态预览", "创建 Next.js");
    store.updatePreview(project.id, {
      previewCapable: true,
      previewStatus: "starting",
      previewUrl: null
    });
    const allowed = await app.inject({
      method: "GET",
      url: `/api/preview-domain-check?domain=p-${project.id}.localhost`
    });
    expect(allowed.statusCode).toBe(200);

    const malformed = await app.inject({
      method: "GET",
      url: "/api/preview-domain-check?domain=p-not-a-project.localhost"
    });
    expect(malformed.statusCode).toBe(404);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/preview-domain-check?domain=p-11111111-1111-1111-1111-111111111111.localhost"
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("文件树按最近一轮持久化标记新建与更新文件", async () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "文件标记", "修改文件");
    const paths = await ensureProjectPaths(config, guest.id, project.id);
    await writeFile(paths.projectRoot + "/new.ts", "export {};");
    store.createActionItem({
      projectId: project.id,
      turnId: turn.id,
      type: "file_change",
      action: "create",
      target: "new.ts",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/guests/${guest.id}/projects/${project.id}/files`
    });
    expect(response.json().items).toContainEqual(
      expect.objectContaining({ path: "new.ts", change: "new" })
    );
  });
});
