import { describe, expect, it } from "vitest";
import { selectTodoProgress } from "./todo-progress";
import type { ConversationTurn, Todo, TodoListItem, UserMessageItem } from "./types";

function turn(
  sequence: number,
  status: ConversationTurn["status"],
  todos?: Todo[]
): ConversationTurn {
  const id = `turn-${sequence}`;
  const user: UserMessageItem = {
    id: `user-${sequence}`,
    projectId: "project",
    turnId: id,
    ordinal: 1,
    type: "user_message",
    status: "completed",
    text: `消息 ${sequence}`,
    attachments: [],
    createdAt: "2026-01-01",
    completedAt: "2026-01-01"
  };
  const todo: TodoListItem | undefined = todos && {
    id: `todo-${sequence}`,
    projectId: "project",
    turnId: id,
    ordinal: 2,
    type: "todo_list",
    status: "completed",
    todos,
    createdAt: "2026-01-01",
    completedAt: "2026-01-01"
  };
  return {
    id,
    projectId: "project",
    sequence,
    status,
    error: null,
    createdAt: "2026-01-01",
    startedAt: status === "queued" ? null : "2026-01-01",
    completedAt: ["queued", "running"].includes(status) ? null : "2026-01-01",
    items: todo ? [user, todo] : [user]
  };
}

const activeTodos: Todo[] = [
  { content: "分析", status: "completed" },
  { content: "实现", status: "in_progress" },
  { content: "测试", status: "pending" }
];
const completedTodos: Todo[] = activeTodos.map((todo) => ({
  ...todo,
  status: "completed"
}));

describe("selectTodoProgress", () => {
  it("运行中按 in_progress 位置显示 active", () => {
    expect(selectTodoProgress([turn(1, "running", activeTodos)])).toMatchObject({
      kind: "active",
      current: 2,
      total: 3,
      turnId: "turn-1"
    });
  });

  it("全部完成后显示 completed", () => {
    expect(selectTodoProgress([turn(1, "completed", completedTodos)])).toMatchObject({
      kind: "completed",
      current: 3,
      total: 3
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "%s turn 即使列表完整也显示 stopped",
    (status) => {
      expect(selectTodoProgress([turn(1, status, completedTodos)])?.kind).toBe("stopped");
    }
  );

  it("终态仍有未完成事项时显示 stopped", () => {
    expect(selectTodoProgress([turn(1, "completed", activeTodos)])).toMatchObject({
      kind: "stopped",
      current: 2,
      total: 3
    });
  });

  it("排队消息不覆盖上一轮结果", () => {
    expect(
      selectTodoProgress([
        turn(1, "completed", completedTodos),
        turn(2, "queued")
      ])
    ).toMatchObject({ kind: "completed", turnId: "turn-1" });
  });

  it("下一轮开始且没有 TodoWrite 时隐藏上一轮计划", () => {
    expect(
      selectTodoProgress([
        turn(1, "completed", completedTodos),
        turn(2, "running")
      ])
    ).toBeNull();
  });

  it("更新的简单任务完成后不回退展示旧计划", () => {
    expect(
      selectTodoProgress([
        turn(1, "completed", completedTodos),
        turn(2, "completed")
      ])
    ).toBeNull();
  });

  it("最新空列表清除当前计划", () => {
    expect(selectTodoProgress([turn(1, "running", [])])).toBeNull();
  });
});
