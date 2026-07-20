# 对话 Item 协议

本文档是 Atoms Demo 对话历史与实时更新的唯一协议定义。需求文档描述用户结果；本文档定义服务端、数据库和前端共同遵循的数据语义。

## 设计原则

1. 一次用户提交创建一个 `ConversationTurn`。
2. 用户消息、助手文字、待办列表、文件操作、命令和通用工具调用都是独立的 `ConversationItem`。
3. `items` 按首次出现顺序排列。item 创建后只能按稳定 `itemId` 原地更新，不能按类型重新排序。
4. 历史接口和 WebSocket 重连快照使用相同的 turn/item 结构。
5. 助手文字 delta 只更新所属的 `assistant_message` item，不存在 turn 级 `final_reply`。
6. `item_completed` 携带该 item 的权威最终快照。
7. 原始 thinking 只产生临时活动状态，不保存、不传输内容，也不属于持久化 items。
8. 文件工具参数流可派生 UI 临时事件，但不改变工具参数、磁盘写入和持久化 item 的语义。

## 持久化模型

```ts
type TurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface ConversationTurn {
  id: string;
  projectId: string;
  sequence: number;
  status: TurnStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  items: ConversationItem[];
}
```

`items[0]` 必须是本轮的 `user_message`。其余 item 按智能体运行期间首次出现的先后顺序追加。

```ts
type ItemStatus = "in_progress" | "completed" | "failed" | "cancelled";

interface ItemBase {
  id: string;
  projectId: string;
  turnId: string;
  ordinal: number;
  status: ItemStatus;
  createdAt: string;
  completedAt: string | null;
}

interface UserMessageItem extends ItemBase {
  type: "user_message";
  status: "completed";
  text: string;
  attachments: MessageAttachment[];
}

interface AssistantMessageItem extends ItemBase {
  type: "assistant_message";
  phase: "commentary" | "final_answer" | "unknown";
  text: string;
}

interface ReasoningSummaryItem extends ItemBase {
  type: "reasoning_summary";
  summary: string[];
}

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  content: string;
  status: TodoStatus;
}

interface TodoListItem extends ItemBase {
  type: "todo_list";
  todos: TodoItem[];
}

interface CommandExecutionItem extends ItemBase {
  type: "command_execution";
  command: string;
  output: string;
  exitCode: number | null;
}

interface FileChangeItem extends ItemBase {
  type: "file_change";
  action: "create" | "update" | "delete";
  path: string;
  contentSnapshot: string | null;
}

interface ToolCallItem extends ItemBase {
  type: "tool_call";
  toolName: string;
  target: string;
  output: string;
}
```

`commentary` 是工具调用前后的用户可见进展说明；`final_answer` 是本轮最终答复；上游没有提供或服务端尚不能判断时使用 `unknown`。一轮可以包含多段助手文字，不得为了展示方便把它们重新拼成一段。

`reasoning_summary` 只接收上游明确标记为可向用户展示的摘要。模型原始 thinking 不能转换成 reasoning summary。

`todo_list` 是一次 `todo_write` 调用提交的完整列表快照。它保留真实 `ordinal`，但前端不把它渲染为普通工具卡片。实时 `item_started`、`item_completed` 与重连 `sync` 都使用同一结构。

### Todo 列表展示生命周期

前端不能简单选取项目中最后一个 `todo_list`，必须先确定所属 turn：

1. 存在 `running` turn 时，只考虑最新的 `running` turn；它尚未产生 `todo_list` 时不展示旧计划。
2. 不存在 `running` turn、但存在 `queued` turn 时，选择排队任务之前最近的终态 turn，因此排队本身不会提前清除上一轮结果。
3. 既不存在 `running` 也不存在 `queued` turn 时，选择 sequence 最大的终态 turn。
4. 不能为了寻找 Todo 列表而跨过更新的 turn 回退到更早历史；选中的 turn 没有 `todo_list` 就不展示。
5. 在选中的 turn 内，取 `ordinal` 最大且 item 状态不是 `failed`、`cancelled` 的 `todo_list`。
6. 最新 `todos` 为空数组时不展示进度入口。

展示状态由 turn 和列表共同决定：

```ts
type TodoDisplayState =
  | { kind: "active"; label: `第 ${number} / ${number} 步` }
  | { kind: "completed"; label: `已完成 ${number} / ${number}` }
  | { kind: "stopped"; label: `已停止 ${number} / ${number}` };
```

- running 且仍有未完成事项：`active`。
- 所有事项均为 completed：`completed`。
- turn 为 failed、cancelled，或终态 turn 仍有未完成事项：`stopped`。
- completed 使用勾图标和低强调中性色；active 才显示进度环；stopped 使用停止图标。
- 三种状态均可通过 hover 或键盘 focus 展开完整详情。

## TodoWrite 工具协议

```ts
type TodoWriteInput = {
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
};
```

- 工具名称：`todo_write`
- 展示名称：`TodoWrite`
- 描述：更新待办事项列表，跟踪任务进度和状态。
- 每次调用提交完整列表；空数组表示清空当前计划。
- `content` 必须为非空字符串，`status` 只能取协议枚举值。
- 多步骤任务必须在首次执行工具前调用，并在任务状态变化时更新。
- 简单单步骤任务不强制创建待办列表。

## REST 快照

项目详情返回最近 50 个 turn：

```json
{
  "project": {},
  "turns": {
    "items": [
      {
        "id": "turn-1",
        "status": "running",
        "items": [
          {
            "id": "item-user-1",
            "type": "user_message",
            "ordinal": 1,
            "text": "创建一个网站",
            "status": "completed"
          },
          {
            "id": "item-assistant-1",
            "type": "assistant_message",
            "ordinal": 2,
            "phase": "commentary",
            "text": "我先检查项目目录。",
            "status": "completed"
          },
          {
            "id": "item-command-1",
            "type": "command_execution",
            "ordinal": 3,
            "command": "ls -la",
            "status": "in_progress"
          }
        ]
      }
    ],
    "hasMore": false
  }
}
```

分页以 turn 的 `sequence` 为游标。客户端只能按照 `turn.sequence` 和 `item.ordinal` 展示，不得另外按 `type` 分组排序。

## WebSocket 生命周期

所有事件沿用统一 envelope：

```ts
interface RealtimeEnvelope<T> {
  id: string;
  projectId: string;
  kind: RealtimeKind;
  occurredAt: string;
  data: T;
}
```

一轮的标准生命周期为：

```text
turn_created
turn_started
  item_started
  item_assistant_message_delta*
  item_completed
  item_started
  item_command_output_snapshot*
  item_completed
  ...
turn_completed
```

事件语义：

- `turn_created`：新 turn 已进入队列，携带完整 turn 快照。
- `turn_started`：turn 开始执行，携带完整 turn 快照。
- `item_started`：首次出现的 item，客户端将其 append 到所属 turn。
- `item_assistant_message_delta`：`{ turnId, itemId, delta }`，只追加到指定助手 item。
- `item_command_output_snapshot`：`{ turnId, itemId, output }`，使用指定命令或工具的最新累计输出替换旧快照。
- `item_completed`：携带完整 item，客户端按 ID 原地替换。
- `file_create`：UI 临时事件，表示 `write` 参数流中已得到完整目标路径；立即在文件树建立占位文件并自动打开。
- `file_append`：UI 临时事件，表示 `write.content` 已产生新内容；按 `offset` 截断当前临时快照后追加 `delta`。
- `turn_completed`：正常、失败或取消的权威 turn 快照。
- `thinking`：`{ turnId, active }`，不包含 thinking 内容。
- `sync`：重连权威快照，结构与 REST 项目详情一致。

客户端收到重复的 `item_started` 或 `item_completed` 时必须按 ID upsert，不能重复 append。delta 不负责去重；重连时使用 `sync` 权威快照覆盖本地对应 turn，从而补齐断线内容且不重复。

## Pi 事件映射

Pi 的 text、thinking 和 tool call 内容块可能穿插，服务端必须使用 `contentIndex` 路由，不能维护一个跨整轮共享的助手文本缓冲区。

```text
message_start(assistant)
  建立新的 assistant message scope

text_start(contentIndex)
  创建 assistant_message item
  key = assistant message scope + contentIndex

text_delta(contentIndex)
  追加到对应 item，并发布 item_assistant_message_delta

text_end(contentIndex)
  完成对应 item，并发布 item_completed

toolcall_delta(contentIndex, file_create)
  预告 path 完整后发布一次 file_create，并排队等待下一次 write

toolcall_delta(contentIndex, write)
  使用最近的未消费预告路径；content 增长时发布 file_append
  未预告时兼容从 write.path 派生 file_create

tool_execution_start(toolCallId)
  创建工具 item；todo_write 创建 todo_list item；发布 item_started

tool_execution_update(toolCallId)
  用最新累计快照替换对应工具输出

tool_execution_end(toolCallId)
  完成对应工具 item，并发布 item_completed
```

### 文件查看器实时快照

- Pi 的 `toolcall_delta` 中包含逐步解析的工具参数。智能体在每次原始 `write` 前调用 UI 专用 `file_create(path)` 工具；服务端从 `file_create` 与随后的 `write` 派生以下不持久化 UI 事件：

```ts
type FileCreateEvent = {
  turnId: string;
  streamId: string;
  path: string;
  action: "create" | "update";
};

type FileAppendEvent = {
  turnId: string;
  streamId: string;
  path: string;
  offset: number;
  delta: string;
};
```

- 只有预告工具的 `path` JSON 字符串完整闭合且解析为项目内路径后才发布一次 `file_create`，不能用尚未生成完成的部分路径创建文件。
- `file_create` 工具只声明紧随其后的单次 `write` 路径，不写磁盘、不创建对话 item。多个文件必须按 `file_create → write` 逐个声明和消费。
- 服务端将最早未消费的预告路径绑定到下一次 `write` 参数流，因此不得依赖 `write` JSON 属性顺序；当模型先生成 `content`、最后生成 `path` 时仍可立即发布 `file_append`。
- 未调用预告工具时，服务端可以在 `write.path` 完整后按旧逻辑派生 `file_create`，作为非保证性的兜底。
- 每个参数流必须以 Pi 的 `toolCall.id` 作为唯一身份；`contentIndex` 只用于在当前 partial 中定位内容块，不能作为跨响应的文件流 key。连续多个 `write` 即使复用同一 `contentIndex` 也必须各自产生独立的 `file_create` 与 `file_append`。
- `file_append` 的 `offset` 是 JavaScript 字符串索引。客户端执行 `current.slice(0, offset) + delta`，既支持通常的尾部追加，也能校正上游流式 JSON 解析对末尾字符的修订。
- 客户端维护显式的自动跟随开关。开关开启时跟随 `file_append` 滚动，并在后续 `file_create` 时切换到最新文件；用户上滚超过 80px 或手动选择文件时关闭，且只能由用户手动重新开启。新 turn 默认重新开启。
- `file_create`、`file_append` 只更新文件树和查看器，不创建对话 item、不落库、不写磁盘。断线时允许丢失；后续 `tool_execution_start` 和 REST/sync 快照负责收敛。
- 原始 `write` 工具仍在参数完整后按原协议一次执行并写入磁盘，不允许 UI 事件触发磁盘写入。
- `write` 的完整目标内容在 `tool_execution_start` 时保存到持久化 `file_change.contentSnapshot`，作为历史与重连的权威进行中快照。
- 未被用户手动锁定查看器时，客户端收到 `file_change item_started` 后立即打开“文件”模式、选中 `path`，并展示 `contentSnapshot`。
- `edit` 等无法在开始时得到完整结果的操作使用 `contentSnapshot: null`；客户端立即打开磁盘上的当前文件，并在操作完成后刷新。
- 成功完成后，客户端读取磁盘上的权威内容校准快照。失败或取消时不得清除已经展示的快照。
- 用户本轮已经手动选择其他查看器时，文件事件只产生新活动提示，不抢占当前阅读位置。

命令工具的 `tool_execution_update.partialResult` 是累计输出快照，不是新增字符。服务端和客户端必须使用 replace 语义，避免把多个累计快照追加成重复输出。

工具开始前已经结束但 phase 仍为 `unknown` 的助手文字归类为 `commentary`。整轮结束时，最后一段仍为 `unknown` 的助手文字归类为 `final_answer`，更早的未知文字归类为 `commentary`。

## Thinking 展示

- 收到 `thinking_start` 或 `thinking_delta`：发布 `{ turnId, active: true }`。
- 收到用户可见文字、工具开始、`thinking_end` 或 turn 终态：发布 `{ turnId, active: false }`。
- WebSocket 事件不能包含 thinking delta 的内容。
- running turn 尚未出现任何智能体 item 时，前端也展示“正在思考中...”作为首次事件前的等待反馈。
- thinking 是临时状态，不在重连快照中恢复。重连后前端根据 running turn 是否已有活动决定等待提示。

## 完成条件

正常完成必须同时满足：

1. 所有工具 item 已进入终态。
2. 至少存在一条 `phase: "final_answer"` 且已完成的助手 item。
3. turn 状态更新为 `completed`。

若上游正常结束但没有最终答复，服务端创建一条独立的 fallback `final_answer` item，而不是写入 turn 字段。

## 明确废弃的设计

以下结构不得重新引入：

- `messages.final_reply` 或任何 turn 级助手正文。
- 将所有助手 delta 拼入同一个跨 item 字段。
- 工具卡片和助手文字分开存储、分开排序。
- 先渲染全部工具卡片，再渲染最终答复。
- 持久化或传输模型原始 thinking。
- 为旧协议保留双写或运行时兼容分支。
