import { describe, expect, it } from "vitest";
import { compareGuests, normalizeGuestName, validateGuestName } from "./guest.js";

describe("guest rules", () => {
  it("接受约定字符并拒绝空格、emoji 和保留名称", () => {
    expect(validateGuestName("小明_A-2")).toMatchObject({ valid: true });
    expect(validateGuestName("Alex Smith")).toMatchObject({ valid: false, code: "invalid_characters" });
    expect(validateGuestName("😀")).toMatchObject({ valid: false, code: "invalid_characters" });
    expect(validateGuestName("DEFAULT")).toMatchObject({ valid: false, code: "reserved" });
  });

  it("使用大小写不敏感的唯一键", () => {
    expect(normalizeGuestName("Alex")).toBe(normalizeGuestName("alex"));
  });

  it("default 固定置顶，其余自然排序", () => {
    const values = [{ name: "游客10" }, { name: "游客2" }, { name: "default" }].sort(compareGuests);
    expect(values.map(({ name }) => name)).toEqual(["default", "游客2", "游客10"]);
  });
});
