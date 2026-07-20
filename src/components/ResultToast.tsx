import { useEffect } from "react";
import { X } from "lucide-react";
import type { Notification } from "../types";

export const RESULT_TOAST_DURATION_MS = 8_000;

interface ResultToastProps {
  notification: Notification;
  onDismiss: () => void;
  onOpen: (notification: Notification) => void;
  dismissAfterMs?: number;
}

function resultLabel(result: Notification["result"]): string {
  if (result === "completed") return "任务已完成";
  if (result === "cancelled") return "任务已取消";
  return "任务执行失败";
}

export function ResultToast({
  notification,
  onDismiss,
  onOpen,
  dismissAfterMs = RESULT_TOAST_DURATION_MS
}: ResultToastProps) {
  useEffect(() => {
    const timeout = window.setTimeout(onDismiss, dismissAfterMs);
    return () => window.clearTimeout(timeout);
  }, [dismissAfterMs, notification.id, onDismiss]);

  return (
    <aside className="result-toast" aria-label="任务通知">
      <button
        className="result-toast-open"
        onClick={() => {
          onDismiss();
          onOpen(notification);
        }}
      >
        <strong>{notification.projectName}</strong>
        <span role="status">{notification.message ?? resultLabel(notification.result)}</span>
      </button>
      <button
        type="button"
        className="result-toast-close"
        aria-label="关闭任务通知"
        title="关闭"
        onClick={onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
