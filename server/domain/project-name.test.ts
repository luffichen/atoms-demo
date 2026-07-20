import { describe, expect, it } from "vitest";
import { fallbackProjectName } from "./project-name.js";

describe("fallbackProjectName", () => {
  it("把常见英文主题转成中文项目名", () => {
    expect(fallbackProjectName("Build me a todo app")).toBe("待办事项");
  });

  it.each([
    ["Create an expense tracker for a small business", "费用追踪"],
    ["Build a recipe planner for families", "食谱规划"],
    ["Create an inventory management dashboard", "库存管理"],
    ["Build a landing page for a coffee shop", "咖啡店落地页"]
  ])("把不同英文主题 %s 概括为中文名称", (request, expected) => {
    expect(fallbackProjectName(request)).toBe(expected);
  });

  it("从中英混合需求中提取中文核心主题", () => {
    expect(fallbackProjectName("Please build 一个宠物健康记录 dashboard")).toBe("宠物健康记录");
  });

  it("不会直接复制长需求且不超过 20 个字符", () => {
    const request = "请帮我创建一个可以记录每日喝水次数并展示趋势图的健康管理网页应用";
    const result = fallbackProjectName(request);
    expect(Array.from(result).length).toBeLessThanOrEqual(20);
    expect(result).not.toBe(request);
  });

  it("始终返回不超过 20 个可见字符的中文名称", () => {
    for (const request of [
      "Build a customer relationship management dashboard with sales analytics",
      "Please create a website for booking appointments",
      "请创建一个用于团队协作的 project management dashboard"
    ]) {
      const result = fallbackProjectName(request);
      expect(Array.from(result).length).toBeLessThanOrEqual(20);
      expect(result).toMatch(/\p{Script=Han}/u);
      expect(result).not.toBe(request.trim());
    }
  });

  it.each([
    ["Build a quantum research dashboard", "科研数据看板"],
    ["Create a travel schedule for remote teams", "旅行日程工具"],
    ["Please build an obscure bespoke experience", "定制项目"]
  ])("未命中特定主题的英文需求 %s 仍生成中文核心标题", (request, expected) => {
    expect(fallbackProjectName(request)).toBe(expected);
  });

  it("无法提取有效主题时使用新项目兜底", () => {
    expect(fallbackProjectName("Build me a thing")).toBe("新项目");
    expect(fallbackProjectName("   ")).toBe("新项目");
  });
});
