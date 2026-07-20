import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Todo } from "./domain/types.js";

export const TODO_WRITE_DESCRIPTION = "更新待办事项列表，跟踪任务进度和状态";

export const TODO_WRITE_SYSTEM_GUIDELINES = [
  "始终使用 todo_write 工具规划和跟踪多步骤任务；简单单步骤任务不需要创建待办列表。",
  "开始多步骤任务时，先用 todo_write 提交完整计划，再调用其他执行工具。",
  "每当任务进度变化时，用 todo_write 提交更新后的完整列表；同一时间最多保留一个 in_progress 项。",
  "完成任务前，将所有已完成事项标记为 completed；不要把 todo_write 当作面向用户的进展说明。"
];

const TodoSchema = Type.Object({
  content: Type.String({ minLength: 1, description: "待办事项的描述，例如“完成项目文档”" }),
  status: StringEnum(["pending", "in_progress", "completed"] as const, {
    description: "待办事项的状态"
  })
});

export const todoWriteTool = defineTool({
  name: "todo_write",
  label: "TodoWrite",
  description: TODO_WRITE_DESCRIPTION,
  promptSnippet: "Use todo_write to create and update the complete plan for multi-step tasks.",
  promptGuidelines: TODO_WRITE_SYSTEM_GUIDELINES,
  parameters: Type.Object({
    description: Type.String({
      minLength: 1,
      description: "面向用户简短说明本次待办更新的作用"
    }),
    todos: Type.Array(TodoSchema, { description: "当前完整待办事项列表" })
  }),
  executionMode: "sequential",
  async execute(_toolCallId, params) {
    const todos = params.todos as Todo[];
    const completed = todos.filter(({ status }) => status === "completed").length;
    return {
      content: [{
        type: "text",
        text: todos.length
          ? `待办事项已更新：${completed}/${todos.length} 已完成`
          : "待办事项列表已清空"
      }],
      details: { todos }
    };
  }
});
