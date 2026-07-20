import { beforeEach, describe, expect, it } from "vitest";
import { rememberedWorkMode, rememberWorkMode } from "./work-mode";

describe("work mode preference", () => {
  beforeEach(() => localStorage.clear());

  it("默认直接编码并在当前浏览器记住上次选择", () => {
    expect(rememberedWorkMode()).toBe("direct_coding");
    rememberWorkMode("structured_requirement");
    expect(rememberedWorkMode()).toBe("structured_requirement");
  });
});
