import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Notification } from "../types";
import { ResultToast } from "./ResultToast";

const notification: Notification = {
  id: "notification-1",
  turnId: "turn-1",
  projectId: "project-1",
  guestId: "guest-1",
  projectName: "后台任务",
  result: "completed",
  createdAt: "2026-07-19T00:00:00Z"
};

describe("ResultToast", () => {
  it("可独立关闭且不会打开项目", () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    render(
      <ResultToast
        notification={notification}
        onDismiss={onDismiss}
        onOpen={onOpen}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭任务通知" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("点击通知正文时关闭通知并打开对应项目", () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    render(
      <ResultToast
        notification={notification}
        onDismiss={onDismiss}
        onOpen={onOpen}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /后台任务/ }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(notification);
  });

  it("到达展示时限后自动关闭", async () => {
    const onDismiss = vi.fn();
    render(
      <ResultToast
        notification={notification}
        onDismiss={onDismiss}
        onOpen={() => undefined}
        dismissAfterMs={10}
      />
    );

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });
});
