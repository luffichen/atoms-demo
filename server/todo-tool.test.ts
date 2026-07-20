import { describe, expect, it } from "vitest";
import {
  TODO_WRITE_DESCRIPTION,
  TODO_WRITE_SYSTEM_GUIDELINES,
  todoWriteTool
} from "./todo-tool.js";

describe("TodoWrite tool", () => {
  it("声明清晰协议并返回完整列表进度", async () => {
    expect(todoWriteTool.name).toBe("todo_write");
    expect(todoWriteTool.label).toBe("TodoWrite");
    expect(todoWriteTool.description).toBe(TODO_WRITE_DESCRIPTION);
    expect(TODO_WRITE_SYSTEM_GUIDELINES.join("\n")).toContain("始终使用 todo_write");
    expect(TODO_WRITE_SYSTEM_GUIDELINES.join("\n")).toContain("多步骤任务");

    const todos = [
      { content: "分析需求", status: "completed" as const },
      { content: "实现页面", status: "in_progress" as const },
      { content: "运行测试", status: "pending" as const }
    ];
    const result = await todoWriteTool.execute(
      "todo-1",
      { todos },
      undefined,
      undefined,
      {} as never
    );
    expect(result.content).toEqual([
      { type: "text", text: "待办事项已更新：1/3 已完成" }
    ]);
    expect(result.details).toEqual({ todos });
  });
});
