import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  validateImage,
  validateMessageText
} from "./validation.js";

describe("validateMessageText", () => {
  it("拒绝空白和仅图片所对应的空文字", () => {
    expect(validateMessageText(" \n\t")).toMatchObject({ valid: false, code: "required" });
  });

  it("接受一万字符并拒绝第一万个字符之后的输入", () => {
    expect(validateMessageText("好".repeat(10_000))).toMatchObject({ valid: true });
    expect(validateMessageText("好".repeat(10_001))).toMatchObject({ valid: false, code: "too_long" });
  });

  it("按 Unicode 字符而非 UTF-16 单元计数", () => {
    expect(validateMessageText("😀")).toMatchObject({ valid: true, visibleCharacters: 1 });
  });
});

describe("validateImage", () => {
  it("接受 PNG/JPEG 并拒绝其他类型", () => {
    expect(validateImage({ type: "image/png", size: 1 }, 0)).toEqual({ valid: true });
    expect(validateImage({ type: "image/webp", size: 1 }, 0)).toMatchObject({
      valid: false,
      code: "unsupported_type"
    });
  });

  it("落实单张 10MB 上限且不限制消息图片数量", () => {
    expect(validateImage({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }, 0)).toMatchObject({
      valid: false,
      code: "too_large"
    });
    expect(validateImage({ type: "image/jpeg", size: 1 }, 10_000)).toEqual({ valid: true });
  });
});
