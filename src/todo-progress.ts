import type { ConversationTurn, Todo } from "./types";

export type TodoProgressKind = "active" | "completed" | "stopped";

export interface TodoProgressState {
  kind: TodoProgressKind;
  current: number;
  total: number;
  todos: Todo[];
  turnId: string;
}

const terminalStatuses = new Set<ConversationTurn["status"]>([
  "completed",
  "failed",
  "cancelled"
]);

function latestBySequence(turns: ConversationTurn[]): ConversationTurn | undefined {
  return [...turns].sort((left, right) => right.sequence - left.sequence)[0];
}

function selectDisplayTurn(turns: ConversationTurn[]): ConversationTurn | undefined {
  const running = latestBySequence(turns.filter(({ status }) => status === "running"));
  if (running) return running;

  const queued = turns.filter(({ status }) => status === "queued");
  if (queued.length) {
    const firstQueuedSequence = Math.min(...queued.map(({ sequence }) => sequence));
    return latestBySequence(
      turns.filter(
        ({ sequence, status }) =>
          sequence < firstQueuedSequence && terminalStatuses.has(status)
      )
    );
  }

  return latestBySequence(turns.filter(({ status }) => terminalStatuses.has(status)));
}

export function selectTodoProgress(turns: ConversationTurn[]): TodoProgressState | null {
  const turn = selectDisplayTurn(turns);
  if (!turn) return null;

  const todoList = turn.items
    .filter(
      (item) =>
        item.type === "todo_list" &&
        item.status !== "failed" &&
        item.status !== "cancelled"
    )
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (!todoList || todoList.type !== "todo_list" || !todoList.todos.length) return null;

  const todos = todoList.todos;
  const total = todos.length;
  const inProgress = todos.findIndex(({ status }) => status === "in_progress");
  const pending = todos.findIndex(({ status }) => status === "pending");
  const current = (inProgress >= 0 ? inProgress : pending >= 0 ? pending : total - 1) + 1;
  const allCompleted = todos.every(({ status }) => status === "completed");
  const stopped =
    turn.status === "failed" ||
    turn.status === "cancelled" ||
    (turn.status !== "running" && !allCompleted);

  return {
    kind: stopped ? "stopped" : allCompleted ? "completed" : "active",
    current,
    total,
    todos,
    turnId: turn.id
  };
}
