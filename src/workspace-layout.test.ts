import { describe, expect, it } from "vitest";
import {
  clampConversationRatio,
  MIN_CONVERSATION_WIDTH,
  MIN_WORKSPACE_WIDTH,
  WORKSPACE_RESIZER_WIDTH
} from "./workspace-layout";

describe("clampConversationRatio", () => {
  it("按两个面板的实际最小像素宽度限制拖动比例", () => {
    const width = 1200;
    expect(clampConversationRatio(5, width)).toBe((MIN_CONVERSATION_WIDTH / width) * 100);
    expect(clampConversationRatio(90, width)).toBe(
      ((width - MIN_WORKSPACE_WIDTH - WORKSPACE_RESIZER_WIDTH) / width) * 100
    );
    expect(clampConversationRatio(30, width)).toBe(30);
  });
});
