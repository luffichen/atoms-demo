import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import type { ConversationTurn, WorkItem } from "./domain/types.js";

export type ReleaseMetadata = {
  title: string;
  summary: string;
};

export type ReleaseMetadataGenerator = (
  workItem: Pick<WorkItem, "title" | "type" | "requirementSequence">,
  turns: ConversationTurn[],
  cumulativeDiff?: string
) => Promise<ReleaseMetadata>;

type CompleteText = (prompt: string) => Promise<string>;

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (Array.from(normalized).length <= limit) return normalized;
  return `${Array.from(normalized).slice(0, limit - 1).join("")}…`;
}

function fallbackMetadata(
  workItem: Pick<WorkItem, "title" | "type" | "requirementSequence">
): ReleaseMetadata {
  return {
    title: compact(workItem.title, 100) || "代码版本",
    summary:
      workItem.type === "structured_requirement"
        ? `完成需求 R${String(workItem.requirementSequence ?? 0).padStart(3, "0")} 的实现与验证`
        : `完成“${workItem.title}”的直接编码改动`
  };
}

function releaseContext(
  workItem: Pick<WorkItem, "title" | "type" | "requirementSequence">,
  turns: ConversationTurn[],
  cumulativeDiff = ""
): string {
  const lines = [
    `工作类型：${workItem.type}`,
    `当前工作标题：${workItem.title}`
  ];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "user_message") {
        lines.push(`用户：${compact(item.text, 1_000)}`);
      } else if (
        item.type === "assistant_message" &&
        item.phase === "final_answer"
      ) {
        lines.push(`完成结果：${compact(item.text, 2_000)}`);
      } else if (item.type === "todo_list") {
        lines.push(
          `任务清单：${item.todos
            .map(({ content, status }) => `[${status}] ${compact(content, 200)}`)
            .join("；")}`
        );
      } else if (item.type === "file_change") {
        lines.push(
          `文件变更：${item.action} ${item.path} — ${compact(item.description, 300)}`
        );
      }
    }
  }
  lines.push(
    "相对工作项正式基线的累计 Diff：",
    cumulativeDiff.trim() || "无累计文件变化"
  );
  return compact(lines.join("\n"), 6_000);
}

function parseMetadata(text: string): ReleaseMetadata | null {
  const json = text.match(/\{[\s\S]*\}/u)?.[0];
  if (!json) return null;
  try {
    const value = JSON.parse(json) as { title?: unknown; summary?: unknown };
    if (typeof value.title !== "string" || typeof value.summary !== "string") {
      return null;
    }
    const title = compact(value.title, 30);
    const summary = compact(value.summary, 120);
    return title && summary ? { title, summary } : null;
  } catch {
    return null;
  }
}

export function createReleaseMetadataGenerator(
  modelName: string,
  completeText?: CompleteText
): ReleaseMetadataGenerator {
  const generate =
    completeText ??
    (async (prompt: string) => {
      const model = getModel(
        "deepseek",
        modelName as "deepseek-v4-pro" | "deepseek-v4-flash"
      );
      const response = await completeSimple(
        model,
        {
          systemPrompt: [
            "你是软件版本发布编辑。",
            "根据完整工作上下文生成面向用户的版本标题和版本摘要。",
            "标题概括实际完成的产品，不要复制用户原始输入，不要使用“生成一个”“帮我”等请求前缀。",
            "摘要概括本版本实际完成的主要功能和变化。",
            "只输出 JSON：{\"title\":\"...\",\"summary\":\"...\"}。",
            "标题不超过 30 个汉字，摘要不超过 120 个汉字。"
          ].join("\n"),
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }]
        },
        {
          reasoning: "minimal",
          maxTokens: 180,
          timeoutMs: 8_000,
          maxRetries: 0
        }
      );
      return response.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("");
    });

  return async (workItem, turns, cumulativeDiff) => {
    try {
      const generated = parseMetadata(
        await generate(releaseContext(workItem, turns, cumulativeDiff))
      );
      return generated ?? fallbackMetadata(workItem);
    } catch {
      return fallbackMetadata(workItem);
    }
  };
}
