import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "./db.js";
import { Store, StoreError } from "./store.js";

describe("Store", () => {
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    db = openMemoryDatabase();
    store = new Store(db);
  });

  afterEach(() => db.close());

  it("首次启动建立 default，游客名大小写唯一", () => {
    expect(store.listGuests().map(({ name }) => name)).toEqual(["default"]);
    store.createGuest("Alex");
    expect(() => store.createGuest("alex")).toThrowError(
      expect.objectContaining<Partial<StoreError>>({ code: "guest_exists" })
    );
  });

  it("以稳定 ID 隔离同名项目并只列出当前游客项目", () => {
    const firstGuest = store.listGuests()[0];
    const secondGuest = store.createGuest("访客2");
    const first = store.createProjectWithTurn(firstGuest.id, "同名项目", "需求 A");
    const second = store.createProjectWithTurn(secondGuest.id, "同名项目", "需求 B");
    expect(first.project.id).not.toBe(second.project.id);
    expect(store.listProjects(firstGuest.id).items.map(({ id }) => id)).toEqual([first.project.id]);
    expect(store.getProjectForGuest(second.project.id, firstGuest.id)).toBeNull();
  });

  it("每页 20 个且无重复地加载项目", () => {
    const guest = store.listGuests()[0];
    for (let index = 0; index < 21; index += 1) {
      store.createProjectWithTurn(guest.id, `项目${index}`, `需求${index}`);
    }
    const first = store.listProjects(guest.id);
    const second = store.listProjects(guest.id, 20);
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(21);
  });

  it("严格串行领取、取消队列并执行后续消息", () => {
    const guest = store.listGuests()[0];
    const { project, turn: first } = store.createProjectWithTurn(guest.id, "队列", "第一条");
    const second = store.enqueueTurn(project.id, "第二条");
    const third = store.enqueueTurn(project.id, "第三条");
    expect(store.claimNextTurn(project.id)?.id).toBe(first.id);
    expect(store.claimNextTurn(project.id)).toBeNull();
    expect(store.cancelQueuedTurn(second.id).status).toBe("cancelled");
    store.finishTurn(first.id, "completed");
    expect(store.claimNextTurn(project.id)?.id).toBe(third.id);
  });

  it("最多保留 10 条排队消息，空出后立即恢复", () => {
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "满队列", "执行中");
    store.claimNextTurn(project.id);
    const queued = Array.from({ length: 10 }, (_, index) =>
      store.enqueueTurn(project.id, `排队${index}`)
    );
    expect(() => store.enqueueTurn(project.id, "第十一条")).toThrowError(
      expect.objectContaining<Partial<StoreError>>({ code: "queue_full" })
    );
    store.cancelQueuedTurn(queued[4].id);
    expect(store.enqueueTurn(project.id, "补位").status).toBe("queued");
  });

  it("服务重启把执行中消息标记失败并保留后续队列", () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "恢复", "运行");
    store.claimNextTurn(project.id);
    const next = store.enqueueTurn(project.id, "后续");
    expect(store.recoverInterruptedTurns()[0]).toMatchObject({
      id: turn.id,
      status: "failed",
      error: "服务重启导致中断"
    });
    expect(store.claimNextTurn(project.id)?.id).toBe(next.id);
  });

  it("人工恢复轮次优先于重启前遗留队列且不清除现场", () => {
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "人工恢复", "运行中");
    store.claimNextTurn(project.id);
    const queued = store.enqueueTurn(project.id, "重启前排队消息");
    store.recoverInterruptedTurns();
    const recovery = store.enqueueTurn(
      project.id,
      "人工恢复执行：检查工作区、Diff、待办和检查点",
      { priority: 2, bypassQueueLimit: true }
    );

    expect(store.claimNextTurn(project.id)?.id).toBe(recovery.id);
    store.finishTurn(recovery.id, "completed");
    expect(store.claimNextTurn(project.id)?.id).toBe(queued.id);
  });

  it("按首次出现顺序保存独立助手与工具 items，并按 ID 原地更新", () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "流式回复", "开始");
    store.claimNextTurn(project.id);
    const first = store.createAssistantItem(project.id, turn.id, "commentary");
    store.appendAssistantText(first.id, "第一段");
    const command = store.createActionItem({
      projectId: project.id,
      turnId: turn.id,
      type: "command_execution",
      target: "echo",
    });
    const second = store.createAssistantItem(project.id, turn.id, "final_answer");
    store.appendAssistantText(second.id, "第二段");

    const updated = store.replaceItemOutput(command.id, "abcdef", 4);
    expect(updated.id).toBe(command.id);
    expect(updated.output).toBe("abcd");
    expect(updated.outputTruncated).toBe(true);
    expect(store.getItem(command.id)).toMatchObject({
      output: "abcd",
      outputTruncated: true
    });
    expect(store.getTurn(turn.id)?.items.map(({ id }) => id)).toEqual([
      expect.any(String),
      first.id,
      command.id,
      second.id
    ]);
  });

  it("按真实 ordinal 持久化完整待办列表快照", () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "待办", "完成多步任务");
    store.claimNextTurn(project.id);
    const commentary = store.createAssistantItem(project.id, turn.id, "commentary");
    const todo = store.createActionItem({
      projectId: project.id,
      turnId: turn.id,
      type: "todo_list",
      target: "",
      todos: [
        { content: "分析需求", status: "completed" },
        { content: "实现功能", status: "in_progress" }
      ]
    });

    expect(todo).toMatchObject({
      type: "todo_list",
      todos: [
        { content: "分析需求", status: "completed" },
        { content: "实现功能", status: "in_progress" }
      ]
    });
    expect(store.getTurn(turn.id)?.items.map(({ id }) => id)).toEqual([
      expect.any(String),
      commentary.id,
      todo.id
    ]);
  });

  it("持久化文件操作内容快照并区分空文件与未知内容", () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "文件快照", "开始");
    store.claimNextTurn(project.id);
    const empty = store.createActionItem({
      projectId: project.id,
      turnId: turn.id,
      type: "file_change",
      action: "create",
      target: "empty.txt",
      contentSnapshot: ""
    });
    const unknown = store.createActionItem({
      projectId: project.id,
      turnId: turn.id,
      type: "file_change",
      action: "update",
      target: "existing.txt",
      contentSnapshot: null
    });

    expect(empty).toMatchObject({ contentSnapshot: "" });
    expect(unknown).toMatchObject({ contentSnapshot: null });
  });

  it("持久化预览失败的具体原因并在成功后清除", () => {
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "预览错误", "开始");
    expect(
      store.updatePreview(project.id, {
        previewCapable: true,
        previewStatus: "failed",
        previewUrl: null,
        previewError: "依赖安装失败"
      })
    ).toMatchObject({
      previewStatus: "failed",
      previewError: "依赖安装失败"
    });
    expect(
      store.updatePreview(project.id, {
        previewCapable: true,
        previewStatus: "ready",
        previewUrl: `/preview/${project.id}/`,
        previewError: null
      })
    ).toMatchObject({
      previewStatus: "ready",
      previewError: null
    });
  });

  it("每条终态消息只产生一条可恢复的站内通知", () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "通知项目", "运行");
    store.claimNextTurn(project.id);
    store.finishTurn(turn.id, "completed");
    const first = store.createNotification(turn.id);
    const duplicate = store.createNotification(turn.id);
    expect(duplicate.id).toBe(first.id);
    expect(store.listNotifications(guest.id)).toEqual([
      expect.objectContaining({
        turnId: turn.id,
        projectId: project.id,
        projectName: "通知项目",
        result: "completed"
      })
    ]);
  });

  it("对话历史按 50 条倒序窗口稳定加载且不重复", () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "长对话", "消息 1");
    store.claimNextTurn(project.id);
    store.finishTurn(turn.id, "completed");
    for (let sequence = 2; sequence <= 120; sequence += 1) {
      const next = store.enqueueTurn(project.id, `消息 ${sequence}`);
      store.claimNextTurn(project.id);
      store.finishTurn(next.id, "completed");
    }
    const latest = store.listTurns(project.id);
    const middle = store.listTurns(project.id, latest.items[0].sequence);
    const oldest = store.listTurns(project.id, middle.items[0].sequence);
    expect(latest.items.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 71)
    );
    expect(middle.items[0].sequence).toBe(21);
    expect(oldest.items.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1)
    );
    expect(
      new Set([...latest.items, ...middle.items, ...oldest.items].map(({ id }) => id)).size
    ).toBe(120);
  });

  it("时间线按最多 50 条内容分页，并可在同一 turn 内稳定续页", () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "密集事件", "开始");
    for (let index = 2; index <= 60; index += 1) {
      store.createAssistantItem(project.id, turn.id, "commentary");
    }

    const latest = store.listTimelineTurns(project.id);
    const older = store.listTimelineTurns(project.id, latest.nextCursor ?? undefined);
    const latestItems = latest.items.flatMap(({ items }) => items);
    const olderItems = older.items.flatMap(({ items }) => items);

    expect(latestItems).toHaveLength(50);
    expect(latestItems[0].ordinal).toBe(11);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextCursor).toBe("1:11");
    expect(olderItems).toHaveLength(10);
    expect(olderItems.map(({ ordinal }) => ordinal)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1)
    );
    expect(older.hasMore).toBe(false);
    expect(new Set([...latestItems, ...olderItems].map(({ id }) => id)).size).toBe(60);
  });

  it("拒绝无效的时间线分页游标", () => {
    const guest = store.listGuests()[0];
    const { project } = store.createProjectWithTurn(guest.id, "游标校验", "开始");
    expect(() => store.listTimelineTurns(project.id, "not-a-cursor")).toThrowError(
      expect.objectContaining<Partial<StoreError>>({ code: "invalid_cursor" })
    );
  });

  it("归档上一工作项后，新工作项拥有独立的对话序号空间", () => {
    const guest = store.listGuests()[0];
    const created = store.createProjectWithTurn(guest.id, "多次迭代", "第一项");
    store.cancelQueuedTurn(created.turn.id);
    store.archiveWorkItem(created.workItem.id, "abandoned");

    const second = store.createWorkItem(
      created.project.id,
      "structured_requirement",
      "第二项",
      "a".repeat(40)
    );
    const turn = store.enqueueTurn(created.project.id, "第二项的首次消息");

    expect(turn).toMatchObject({ workItemId: second.id, sequence: 1 });
    expect(store.listTurns(created.project.id).items).toHaveLength(1);
    expect(store.listTurns(created.project.id).items[0].id).toBe(turn.id);
  });

  it("活动工作可修改标题，归档后标题锁定且旧修订号被拒绝", () => {
    const guest = store.listGuests()[0];
    const created = store.createProjectWithTurn(guest.id, "标题项目", "开始");
    const renamed = store.updateWorkItemTitle(
      created.workItem.id,
      "新的工作标题",
      created.workItem.revision
    );
    expect(renamed.title).toBe("新的工作标题");
    expect(renamed.revision).toBe(created.workItem.revision + 1);
    expect(() =>
      store.updateWorkItemTitle(created.workItem.id, "过期修改", created.workItem.revision)
    ).toThrowError(expect.objectContaining<Partial<StoreError>>({ code: "revision_conflict" }));
    store.cancelQueuedTurn(created.turn.id);
    store.archiveWorkItem(created.workItem.id, "abandoned");
    expect(() =>
      store.updateWorkItemTitle(created.workItem.id, "归档修改", renamed.revision)
    ).toThrowError(expect.objectContaining<Partial<StoreError>>({ code: "work_item_not_found" }));
  });

  it("工作流动作预留会原子占用 revision 并拒绝不同幂等键的并发确认", () => {
    const guest = store.listGuests()[0];
    const created = store.createProjectWithTurn(guest.id, "并发动作", "开始");
    const revision = created.workItem.revision;

    const reserved = store.reserveWorkflowAction({
      workItemId: created.workItem.id,
      action: "publish",
      revision,
      idempotencyKey: "concurrent-action-1",
      source: "button",
      actorGuestId: guest.id
    });

    expect(reserved.revision).toBe(revision + 1);
    expect(() =>
      store.reserveWorkflowAction({
        workItemId: created.workItem.id,
        action: "publish",
        revision,
        idempotencyKey: "concurrent-action-2",
        source: "button",
        actorGuestId: guest.id
      })
    ).toThrowError(expect.objectContaining<Partial<StoreError>>({ code: "revision_conflict" }));
  });
});
