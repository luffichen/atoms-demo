import { describe, expect, it, vi } from "vitest";
import type { ConversationTurn, WorkItem } from "./domain/types.js";
import { createReleaseMetadataGenerator } from "./release-metadata.js";

const workItem = {
  title: "生成一个世界杯官方网站只需要一个",
  type: "direct_coding",
  requirementSequence: null
} satisfies Pick<WorkItem, "title" | "type" | "requirementSequence">;

const turns = [{
  items: [
    {
      type: "user_message",
      text: "生成一个世界杯官方网站，一个 index.html"
    },
    {
      type: "todo_list",
      todos: [
        { content: "设计网站结构与视觉方案", status: "completed" },
        { content: "创建赛程、积分榜、新闻和球队展示", status: "completed" }
      ]
    },
    {
      type: "file_change",
      action: "create",
      path: "index.html",
      description: "写入完整的世界杯官网"
    },
    {
      type: "assistant_message",
      phase: "final_answer",
      text: "已完成响应式世界杯网站，包含导航、倒计时、赛程和新闻。"
    }
  ]
}] as ConversationTurn[];

describe("LLM 发布版本元数据", () => {
  it("把累计工作上下文交给 LLM 并解析 JSON 标题与摘要", async () => {
    const complete = vi.fn().mockResolvedValue(
      "```json\n{\"title\":\"2026 世界杯官方网站\",\"summary\":\"新增响应式导航、赛事倒计时、赛程积分榜、新闻和球队展示。\"}\n```"
    );
    const generate = createReleaseMetadataGenerator("deepseek-v4-pro", complete);

    await expect(
      generate(workItem, turns, "modified: src/App.ts\nadded: src/version-panel.tsx")
    ).resolves.toEqual({
      title: "2026 世界杯官方网站",
      summary: "新增响应式导航、赛事倒计时、赛程积分榜、新闻和球队展示。"
    });
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("用户：生成一个世界杯官方网站，一个 index.html")
    );
    expect(complete.mock.calls[0][0]).toContain("文件变更：create index.html");
    expect(complete.mock.calls[0][0]).toContain("完成结果：已完成响应式世界杯网站");
    expect(complete.mock.calls[0][0]).toContain("相对工作项正式基线的累计 Diff");
    expect(complete.mock.calls[0][0]).toContain("added: src/version-panel.tsx");
  });

  it("LLM 失败或返回非法内容时安全回退，不阻塞发布", async () => {
    const failed = createReleaseMetadataGenerator(
      "deepseek-v4-pro",
      vi.fn().mockRejectedValue(new Error("upstream unavailable"))
    );
    const invalid = createReleaseMetadataGenerator(
      "deepseek-v4-pro",
      vi.fn().mockResolvedValue("not json")
    );
    const fallback = {
      title: workItem.title,
      summary: `完成“${workItem.title}”的直接编码改动`
    };

    await expect(failed(workItem, turns)).resolves.toEqual(fallback);
    await expect(invalid(workItem, turns)).resolves.toEqual(fallback);
  });
});
