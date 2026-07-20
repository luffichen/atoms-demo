import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "./types";
import { mergeConversationTurn, promoteTurnForActivity } from "./turn-state";

function turn(
  status: ConversationTurn["status"],
  items: ConversationTurn["items"] = []
): ConversationTurn {
  return {
    id: "turn-1",
    projectId: "project-1",
    workItemId: "work-1",
    sequence: 1,
    status,
    error: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-07-19T00:00:01.000Z",
    completedAt: ["completed", "failed", "cancelled"].includes(status)
      ? "2026-07-19T00:00:02.000Z"
      : null,
    items
  };
}

describe("turn state merge", () => {
  it("WebSocket running 先到时，迟到的 HTTP queued 不能让状态回退", () => {
    const running = turn("running");
    const staleResponse = turn("queued");

    expect(mergeConversationTurn(running, staleResponse).status).toBe("running");
  });

  it("终态不会被 queued 或 running 覆盖", () => {
    expect(mergeConversationTurn(turn("completed"), turn("queued")).status).toBe("completed");
    expect(mergeConversationTurn(turn("failed"), turn("running")).status).toBe("failed");
  });

  it("收到助手或工具活动时，把仍显示 queued 的父消息提升为 running", () => {
    expect(promoteTurnForActivity(turn("queued")).status).toBe("running");
    expect(promoteTurnForActivity(turn("completed")).status).toBe("completed");
  });
});
