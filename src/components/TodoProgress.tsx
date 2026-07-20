import { Check, CheckCircle2, Circle, CircleStop, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import type { TodoProgressState } from "../todo-progress";

const statusLabel = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成"
} as const;

export function TodoProgress({ progress }: { progress: TodoProgressState | null }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (!progress) return null;
  const { current, kind, todos, total } = progress;
  const label =
    kind === "completed"
      ? `已完成 ${total} / ${total}`
      : kind === "stopped"
        ? `已停止 ${current} / ${total}`
        : `第 ${current} / ${total} 步`;

  return (
    <div
      className={`todo-progress ${kind}`}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={() => setExpanded(false)}
    >
      <button
        type="button"
        className="todo-progress-trigger"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded(true)}
      >
        {kind === "active" ? (
          <span className="todo-progress-ring" aria-hidden="true" />
        ) : kind === "completed" ? (
          <CheckCircle2 className="todo-progress-mark" size={14} aria-hidden="true" />
        ) : (
          <CircleStop className="todo-progress-mark" size={14} aria-hidden="true" />
        )}
        {label}
      </button>
      <div
        id={detailsId}
        className={`todo-progress-details ${expanded ? "expanded" : ""}`}
        role="region"
        aria-label="待办事项详情"
        aria-hidden={!expanded}
      >
        <ol>
          {todos.map((todo, index) => (
            <li className={todo.status} key={`${index}-${todo.content}`}>
              <span className="todo-status-icon" aria-hidden="true">
                {todo.status === "completed" ? (
                  <Check size={14} />
                ) : todo.status === "in_progress" ? (
                  <LoaderCircle className="todo-status-spinner" size={14} />
                ) : (
                  <Circle size={14} />
                )}
              </span>
              <span>{todo.content}</span>
              <span className="sr-only">，{statusLabel[todo.status]}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
