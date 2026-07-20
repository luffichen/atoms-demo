import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export class WorkflowDocumentError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "WorkflowDocumentError";
  }
}

function sequenceLabel(requirementSequence: number | null): string {
  if (!requirementSequence) {
    throw new WorkflowDocumentError("requirement_sequence_missing", "工作项缺少需求编号");
  }
  return `R${String(requirementSequence).padStart(3, "0")}`;
}

async function listFiles(root: string, extension: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

function markdownSections(markdown: string): Array<{ heading: string; body: string }> {
  const matches = [...markdown.matchAll(/^#{1,4}\s+(.+?)\s*$/gmu)];
  return matches.map((match, index) => ({
    heading: match[1].replaceAll(/[*_`]/g, "").trim().toLowerCase(),
    body: markdown
      .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? markdown.length)
      .trim()
  }));
}

function requireSections(
  markdown: string,
  sections: Array<{ label: string; aliases: string[] }>,
  documentLabel: string
): void {
  const parsed = markdownSections(markdown);
  const missing = sections
    .filter(({ aliases }) =>
      !aliases.some((alias) =>
        parsed.some(
          ({ heading }) =>
            heading.includes(alias.toLowerCase()) &&
            !(alias === "目标" && heading.includes("非目标"))
        )
      )
    )
    .map(({ label }) => label);
  if (missing.length) {
    throw new WorkflowDocumentError(
      "document_sections_missing",
      `${documentLabel}缺少必备章节：${missing.join("、")}`
    );
  }
}

function linkedMarkdownDocuments(root: string, readme: string): string[] {
  const rootPrefix = resolve(root) + sep;
  return [
    ...new Set(
      [...readme.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]+)?\)/giu)]
        .map((match) => match[1].replace(/^\.\//u, ""))
        .filter((target) => !target.includes("://") && !target.startsWith("/"))
        .map((target) => resolve(root, target))
        .filter((target) => target.startsWith(rootPrefix))
    )
  ].sort();
}

export async function validateRequirementPackage(
  projectRoot: string,
  requirementSequence: number | null
): Promise<{ root: string; readme: string; documents: string[] }> {
  const sequence = sequenceLabel(requirementSequence);
  const requirementsRoot = join(projectRoot, "docs", "requirements");
  const directories = await readdir(requirementsRoot, { withFileTypes: true }).catch(() => []);
  const candidates = directories
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(`${sequence}-`) &&
        entry.name !== `${sequence}-attachments`
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const candidate of candidates) {
    const root = join(requirementsRoot, candidate.name);
    const readme = join(root, "README.md");
    let content: string;
    try {
      content = await readFile(readme, "utf8");
    } catch {
      continue;
    }
    requireSections(
      content,
      [
        { label: "总体目标", aliases: ["总体目标", "目标", "overview", "goal"] },
        { label: "范围", aliases: ["范围", "scope"] },
        { label: "非目标", aliases: ["非目标", "out of scope", "non-goal"] },
        { label: "依赖", aliases: ["依赖", "dependencies"] },
        { label: "原子需求索引", aliases: ["原子需求索引", "需求索引", "atomic requirements"] }
      ],
      "正式需求 README"
    );
    const atomicIndex = markdownSections(content).find(({ heading }) =>
      /原子需求索引|需求索引|atomic requirements/iu.test(heading)
    );
    const documents = linkedMarkdownDocuments(root, atomicIndex?.body ?? "");
    for (const document of documents) {
      const atomic = await readFile(document, "utf8");
      requireSections(
        atomic,
        [
          { label: "目标", aliases: ["目标", "goal"] },
          { label: "需求", aliases: ["需求", "requirements"] },
          { label: "验收标准", aliases: ["验收标准", "acceptance"] },
          { label: "非目标", aliases: ["非目标", "out of scope", "non-goal"] },
          { label: "原子性检查", aliases: ["原子性检查", "atomicity"] }
        ],
        `原子需求 ${relative(root, document)}`
      );
    }
    return { root, readme, documents };
  }
  throw new WorkflowDocumentError(
    "requirement_package_missing",
    `未找到结构完整的正式需求包 ${sequence}-*/README.md`
  );
}

export async function validateTechnicalDesign(
  projectRoot: string,
  requirementSequence: number | null
): Promise<string> {
  const sequence = sequenceLabel(requirementSequence);
  const technicalRoot = join(projectRoot, "docs", "technical");
  const files = (await listFiles(technicalRoot, ".md")).filter((path) =>
    relative(technicalRoot, path).split(/[\\/]/u).some((part) => part.startsWith(`${sequence}-`))
  );
  let lastError: WorkflowDocumentError | null = null;
  for (const path of files) {
    const content = await readFile(path, "utf8");
    try {
      requireSections(
        content,
        [
          { label: "背景与需求引用", aliases: ["背景与需求引用", "背景", "需求引用"] },
          { label: "现状分析", aliases: ["现状分析"] },
          { label: "总体方案", aliases: ["总体方案"] },
          { label: "数据模型", aliases: ["数据模型"] },
          { label: "接口与事件", aliases: ["接口与事件", "接口", "事件"] },
          { label: "前端交互", aliases: ["前端交互"] },
          { label: "安全边界", aliases: ["安全边界"] },
          { label: "兼容性", aliases: ["兼容性"] },
          { label: "实施步骤", aliases: ["实施步骤"] },
          { label: "测试计划", aliases: ["测试计划"] },
          { label: "上线回滚", aliases: ["上线回滚", "回滚"] },
          { label: "风险", aliases: ["风险"] },
          { label: "非目标", aliases: ["非目标"] }
        ],
        "技术方案"
      );
      return path;
    } catch (error) {
      if (!(error instanceof WorkflowDocumentError)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new WorkflowDocumentError(
    "technical_design_incomplete",
    `未找到结构完整的技术方案 ${sequence}-*.md`
  );
}

export type TestEvidence = {
  reportPath: string;
  screenshotPaths: string[];
};

export async function recordUiEvidence(
  projectRoot: string,
  requirementSequence: number | null,
  references: { desktop: string; mobile: string }
): Promise<string> {
  const sequence = sequenceLabel(requirementSequence);
  const reportsRoot = join(projectRoot, "docs", "test-reports");
  const report = (await listFiles(reportsRoot, ".md")).find((path) =>
    relative(reportsRoot, path).split(/[\\/]/u).some((part) => part.startsWith(`${sequence}-`))
  );
  if (!report) {
    throw new WorkflowDocumentError(
      "test_report_missing",
      `未找到测试报告 ${sequence}-*.md`
    );
  }
  const existing = await readFile(report, "utf8");
  if (!existing.includes(references.desktop) || !existing.includes(references.mobile)) {
    await appendFile(
      report,
      [
        "",
        "### 平台截图证据",
        "",
        `![桌面端关键流程](${references.desktop})`,
        `![移动端关键流程](${references.mobile})`,
        ""
      ].join("\n")
    );
  }
  return report;
}

export async function validateTestReport(
  projectRoot: string,
  requirementSequence: number | null,
  requireUiEvidence: boolean
): Promise<TestEvidence> {
  const sequence = sequenceLabel(requirementSequence);
  const reportsRoot = join(projectRoot, "docs", "test-reports");
  const files = (await listFiles(reportsRoot, ".md")).filter((path) =>
    relative(reportsRoot, path).split(/[\\/]/u).some((part) => part.startsWith(`${sequence}-`))
  );
  let lastError: WorkflowDocumentError | null = null;
  for (const path of files) {
    const content = await readFile(path, "utf8");
    try {
      requireSections(
        content,
        [
          { label: "环境", aliases: ["环境"] },
          { label: "检查点", aliases: ["检查点"] },
          { label: "命令", aliases: ["命令"] },
          { label: "耗时", aliases: ["耗时"] },
          { label: "摘要", aliases: ["摘要"] },
          { label: "验收映射", aliases: ["验收映射", "验收标准映射"] },
          { label: "界面尺寸", aliases: ["界面尺寸", "视口"] },
          { label: "已知限制", aliases: ["已知限制"] },
          { label: "最终结论", aliases: ["最终结论", "结论"] }
        ],
        "测试报告"
      );
      const screenshotPaths = [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
        .map((match) => match[1].split("#", 1)[0].split("?", 1)[0])
        .filter((reference) => /\.(?:png|jpe?g)$/iu.test(reference))
        .map((reference) => join(dirname(path), decodeURIComponent(reference)));
      if (requireUiEvidence && screenshotPaths.length < 2) {
        throw new WorkflowDocumentError(
          "ui_evidence_missing",
          "界面项目的测试报告必须引用桌面端和移动端关键截图"
        );
      }
      for (const screenshot of screenshotPaths) {
        const metadata = await stat(screenshot).catch(() => null);
        if (!metadata?.isFile() || metadata.size === 0 || metadata.size > 10 * 1024 * 1024) {
          throw new WorkflowDocumentError(
            "ui_evidence_invalid",
            `测试报告引用的截图不可用或超过 10 MB：${relative(projectRoot, screenshot)}`
          );
        }
      }
      return { reportPath: path, screenshotPaths };
    } catch (error) {
      if (!(error instanceof WorkflowDocumentError)) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new WorkflowDocumentError(
    "test_report_incomplete",
    `未找到结构完整且证据齐全的测试报告 ${sequence}-*.md`
  );
}
