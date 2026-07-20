import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextSignatureV1 } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AppConfig } from "./config.js";
import type {
  AssistantMessageItem,
  ConversationItem,
  ConversationTurn,
  Todo,
  WorkItem
} from "./domain/types.js";
import { ensureProjectPaths, ensureWorkItemSessionPath } from "./paths.js";
import { RealtimeHub } from "./realtime.js";
import { createSafeToolDefinitions } from "./safe-tools.js";
import { Store } from "./store.js";
import { todoWriteTool } from "./todo-tool.js";
import { fileCreateTool } from "./file-create-tool.js";
import { VersionControl } from "./version-control.js";
import { PreviewManager } from "./preview-manager.js";
import {
  diffProjectFileStructure,
  snapshotProjectFiles,
  type FileStructureSnapshot
} from "./file-structure-diff.js";
import {
  validateRequirementPackage,
  validateTechnicalDesign
} from "./workflow-documents.js";

const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;
const TOOL_DESCRIPTION_RULE =
  "每次调用工具时都填写 description 参数，用一句面向用户的简短中文说明本次调用的具体作用；描述目标和价值，不复述工具名、命令、路径或内部实现。";
const REQUIREMENT_INTERVIEW_RULES = [
  "围绕尚未明确且会影响用户可见行为或验收结果的产品决策进行访谈，逐项解决依赖关系，直到目标、范围和验收标准达成共同理解；每个问题给出推荐答案。",
  "一次只提出一个问题。",
  "整个需求讨论最多向用户提出三个问题；达到上限后，剩余事项直接采用已经给出的推荐方案或合理默认值。",
  "能通过代码库、现有文档或项目约定回答的问题，先自行探索，不要反问用户。",
  "需求讨论只解决产品层决策：目标用户、使用场景、功能与内容范围、用户流程、可见交互、业务状态、异常体验、权限规则、产品兼容性、验收标准和非目标。",
  "不要询问或自行展开实现层决策，包括技术栈、框架或库选型、SSR/SPA、模板引擎、模块划分、API 设计、代码或数据结构、存储方案、CSS 工程方案、部署方式和测试工具；这些属于后续技术设计阶段。",
  "用户主动给出的框架、数据库、部署环境等技术信息只作为已确认的实现约束记录，不要沿着这些信息继续追问相邻技术选型。",
  "提出问题前先判断它是产品决策还是实现决策；只有会实质影响用户可见行为或验收结果、且无法从现有信息合理推断的产品决策才可以询问。",
  "用户明确授权按推荐方案或最优默认值自行决定时，直接采用合理默认值并记录关键假设，不要继续提问。",
  "需求阶段的待办列表和需求草稿也必须保持产品视角，不得把技术设计任务伪装成需求访谈项。"
].join("\n");
const TESTING_ADMISSION_AUTO_REPAIR_PREFIX = "测试准入自动修复：";
const MAX_TESTING_ADMISSION_AUTO_REPAIRS = 2;

export async function archiveDocumentAttachments(
  projectRoot: string,
  workItem: Pick<WorkItem, "type" | "workflowState" | "requirementSequence">,
  attachments: Array<{ path: string; mimeType: "image/png" | "image/jpeg" }>
): Promise<string[]> {
  if (
    workItem.type !== "structured_requirement" ||
    workItem.requirementSequence === null ||
    attachments.length === 0
  ) {
    return [];
  }
  const sequence = `R${String(workItem.requirementSequence).padStart(3, "0")}`;
  const requirementsStage =
    workItem.workflowState === "requirements_discussion" ||
    workItem.workflowState === "requirements_pending_confirmation";
  const testingStage =
    workItem.workflowState === "testing_admission" ||
    workItem.workflowState === "testing";
  if (!requirementsStage && !testingStage) return [];
  const relativeRoot = join(
    ".tmp",
    "document-attachments",
    sequence,
    requirementsStage ? "requirements" : "testing"
  );
  const destinationRoot = join(projectRoot, relativeRoot);
  await mkdir(destinationRoot, { recursive: true });
  const archived: string[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const extension = attachment.mimeType === "image/png" ? ".png" : ".jpg";
    const sourceName = basename(attachment.path, extension);
    const filename = `${String(index + 1).padStart(2, "0")}-${sourceName}${extension}`;
    await copyFile(attachment.path, join(destinationRoot, filename));
    archived.push(join(relativeRoot, filename).replaceAll("\\", "/"));
  }
  return archived;
}

export async function finalizeDocumentAttachmentReferences(
  projectRoot: string,
  workItem: Pick<WorkItem, "type" | "workflowState" | "requirementSequence">
): Promise<string[]> {
  if (workItem.type !== "structured_requirement" || !workItem.requirementSequence) {
    return [];
  }
  const sequence = `R${String(workItem.requirementSequence).padStart(3, "0")}`;
  const requirementsStage =
    workItem.workflowState === "requirements_discussion" ||
    workItem.workflowState === "requirements_pending_confirmation";
  const testingStage =
    workItem.workflowState === "testing_admission" ||
    workItem.workflowState === "testing";
  if (!requirementsStage && !testingStage) return [];
  const stagedRoot = join(
    projectRoot,
    ".tmp",
    "document-attachments",
    sequence,
    requirementsStage ? "requirements" : "testing"
  );
  const stagedFiles = await readdir(stagedRoot, { withFileTypes: true }).catch(() => []);
  const stagedByReference = new Map(
    stagedFiles
      .filter((entry) => entry.isFile())
      .map((entry) => [
        relative(projectRoot, join(stagedRoot, entry.name)).replaceAll("\\", "/"),
        join(stagedRoot, entry.name)
      ])
  );
  if (!stagedByReference.size) return [];
  const documentsRoot = requirementsStage
    ? join(projectRoot, "docs", "requirements")
    : join(projectRoot, "docs", "test-reports");
  const documents: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        relative(documentsRoot, path)
          .split(/[\\/]/u)
          .some((part) => part.startsWith(sequence))
      ) {
        documents.push(path);
      }
    }
  };
  await visit(documentsRoot);
  const localized: string[] = [];
  for (const document of documents) {
    let markdown = await readFile(document, "utf8");
    let changed = false;
    for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const reference = match[1].trim().split(/\s+/u)[0].replace(/^\.\//u, "");
      const source = stagedByReference.get(reference);
      if (!source) continue;
      const assetRoot = requirementsStage
        ? join(dirname(document), "assets")
        : join(documentsRoot, `${sequence}-assets`);
      await mkdir(assetRoot, { recursive: true });
      const target = join(assetRoot, basename(source));
      await copyFile(source, target);
      const localizedReference = relative(dirname(document), target).replaceAll("\\", "/");
      markdown = markdown.replaceAll(match[1], localizedReference);
      localized.push(relative(projectRoot, target).replaceAll("\\", "/"));
      changed = true;
    }
    if (changed) await writeFile(document, markdown);
  }
  if (workItem.workflowState !== "requirements_discussion") {
    await rm(stagedRoot, { recursive: true, force: true });
  }
  return [...new Set(localized)];
}

export function shouldAutoRepairTestingAdmission(
  workItem: ReturnType<Store["getWorkItem"]>,
  status: "completed" | "failed" | "cancelled",
  timedOut: boolean,
  priorAutoRepairs: number
): boolean {
  return (
    status === "failed" &&
    !timedOut &&
    workItem?.type === "structured_requirement" &&
    workItem.workflowState === "testing_admission" &&
    priorAutoRepairs < MAX_TESTING_ADMISSION_AUTO_REPAIRS
  );
}

export function shouldContinueQueuedWork(
  completedStatus: ConversationTurn["status"] | undefined,
  nextUserText: string | undefined
): boolean {
  if (completedStatus === "completed") return true;
  return Boolean(
    nextUserText?.startsWith(TESTING_ADMISSION_AUTO_REPAIR_PREFIX) ||
    nextUserText?.startsWith("人工恢复执行：")
  );
}

async function findNumberedMarkdownDocument(
  documentRoot: string,
  sequence: string
): Promise<string | null> {
  const visit = async (directory: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(path);
        if (found) return found;
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        relative(documentRoot, path).split(/[\\/]/).some((part) => part.startsWith(sequence))
      ) {
        return path;
      }
    }
    return null;
  };
  return visit(documentRoot);
}

export async function findConfirmedRequirementDocument(
  projectRoot: string,
  requirementSequence: number | null
): Promise<string | null> {
  if (!requirementSequence) return null;
  const requirementsRoot = join(projectRoot, "docs", "requirements");
  const prefix = `R${String(requirementSequence).padStart(3, "0")}`;
  return findNumberedMarkdownDocument(requirementsRoot, prefix);
}

const technicalSectionGroups = [
  ["背景", "需求引用"],
  ["现状分析"],
  ["总体方案"],
  ["数据模型"],
  ["接口", "事件"],
  ["前端交互"],
  ["安全边界"],
  ["兼容性"],
  ["实施步骤"],
  ["测试计划"],
  ["上线", "回滚"],
  ["风险"],
  ["非目标"]
] as const;

function markdownHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => match[1].trim());
}

export async function validateTechnicalDesignDocument(
  projectRoot: string,
  requirementSequence: number | null
): Promise<string> {
  if (!requirementSequence) throw new Error("技术方案缺少需求编号");
  const sequence = `R${String(requirementSequence).padStart(3, "0")}`;
  const documentPath = await findNumberedMarkdownDocument(
    join(projectRoot, "docs", "technical"),
    sequence
  );
  if (!documentPath) throw new Error(`缺少 ${sequence} 技术方案文档`);
  const markdown = await readFile(documentPath, "utf8");
  const headings = markdownHeadings(markdown);
  for (const alternatives of technicalSectionGroups) {
    if (!headings.some((heading) => alternatives.some((name) => heading.includes(name)))) {
      throw new Error(`技术方案缺少必备章节：${alternatives.join("/")}`);
    }
  }
  return documentPath;
}

const testReportSections = [
  "环境",
  "检查点",
  "命令",
  "耗时",
  "摘要",
  "验收映射",
  "界面尺寸",
  "已知限制",
  "最终结论"
] as const;

export async function validateStructuredTestReport(
  projectRoot: string,
  requirementSequence: number | null,
  requireUiEvidence = false
): Promise<string> {
  if (!requirementSequence) throw new Error("测试报告缺少需求编号");
  const sequence = `R${String(requirementSequence).padStart(3, "0")}`;
  const documentPath = await findNumberedMarkdownDocument(
    join(projectRoot, "docs", "test-reports"),
    sequence
  );
  if (!documentPath) throw new Error(`缺少 ${sequence} 测试报告`);
  const markdown = await readFile(documentPath, "utf8");
  const headings = markdownHeadings(markdown);
  for (const section of testReportSections) {
    if (!headings.some((heading) => heading.includes(section))) {
      throw new Error(`测试报告缺少必备章节：${section}`);
    }
  }
  if (requireUiEvidence) {
    const imagePaths = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
      .map((match) => match[1].trim().split(/\s+/u)[0])
      .filter((path) => !/^(?:https?:|data:)/iu.test(path));
    if (!imagePaths.length) throw new Error("界面测试缺少报告引用的关键截图");
    for (const imagePath of imagePaths) {
      const absolute = resolve(join(documentPath, ".."), imagePath);
      const relativePath = relative(projectRoot, absolute);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error("测试截图路径越界");
      }
      let info;
      try {
        info = await stat(absolute);
      } catch {
        throw new Error(`测试截图不存在：${imagePath}`);
      }
      if (!info.isFile() || info.size > 10 * 1024 * 1024) {
        throw new Error(`测试截图无效或超过 10 MB：${imagePath}`);
      }
    }
  }
  return documentPath;
}

type AdmissionCheck = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  evidence?: unknown;
};

type AdmissionCommand = {
  command?: unknown;
  exitCode?: unknown;
  summary?: unknown;
};

export async function validateTestingAdmissionReport(
  projectRoot: string,
  requirementSequence: number | null
): Promise<string> {
  if (!requirementSequence) throw new Error("测试准入缺少需求编号");
  const sequence = `R${String(requirementSequence).padStart(3, "0")}`;
  const reportPath = join(
    projectRoot,
    "docs",
    "test-reports",
    `${sequence}-admission.json`
  );
  let report: {
    requirement?: unknown;
    status?: unknown;
    checks?: unknown;
    commands?: unknown;
    failuresFound?: unknown;
    repairsApplied?: unknown;
  };
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error(`未生成有效的测试准入报告 ${sequence}-admission.json`);
  }
  if (report.requirement !== sequence || report.status !== "passed") {
    throw new Error("测试准入报告尚未通过");
  }
  if (
    !Number.isInteger(report.failuresFound) ||
    Number(report.failuresFound) < 0 ||
    !Array.isArray(report.repairsApplied) ||
    (Number(report.failuresFound) > 0 && report.repairsApplied.length === 0)
  ) {
    throw new Error("测试准入报告缺少有效的问题与修复记录");
  }
  if (!(await findConfirmedRequirementDocument(projectRoot, requirementSequence))) {
    throw new Error("测试准入缺少当前需求的已确认需求文档");
  }
  const technicalRoot = join(projectRoot, "docs", "technical");
  if (!(await findNumberedMarkdownDocument(technicalRoot, sequence))) {
    throw new Error("测试准入缺少当前需求的技术方案文档");
  }
  if (!Array.isArray(report.checks)) throw new Error("测试准入报告缺少检查项");
  const checks = report.checks as AdmissionCheck[];
  const requiredPassed = [
    "requirements_document",
    "technical_design",
    "implementation_complete",
    "automated_tests"
  ];
  const qualityChecks = ["typecheck", "lint", "build"];
  for (const id of requiredPassed) {
    const check = checks.find((candidate) => (candidate.id ?? candidate.name) === id);
    if (
      check?.status !== "passed" ||
      typeof check.evidence !== "string" ||
      !check.evidence.trim()
    ) {
      throw new Error(`测试准入检查未通过：${id}`);
    }
  }
  for (const id of qualityChecks) {
    const check = checks.find((candidate) => (candidate.id ?? candidate.name) === id);
    if (
      !check ||
      !["passed", "not_applicable"].includes(String(check.status)) ||
      typeof check.evidence !== "string" ||
      !check.evidence.trim()
    ) {
      throw new Error(`测试准入检查缺少有效结论：${id}`);
    }
  }
  if (!Array.isArray(report.commands) || report.commands.length === 0) {
    throw new Error("测试准入报告缺少实际执行命令");
  }
  for (const command of report.commands as AdmissionCommand[]) {
    if (
      typeof command.command !== "string" ||
      !command.command.trim() ||
      command.exitCode !== 0 ||
      typeof command.summary !== "string" ||
      !command.summary.trim()
    ) {
      throw new Error("测试准入报告包含未通过或证据不完整的命令");
    }
  }
  return reportPath;
}

export function buildAgentPrompt(userText: string): string {
  return [
    "你是 Atoms Demo 中的工程师 luffi。直接在当前项目目录完成用户要求。",
    "对可合理推断的歧义做出假设并继续，不要暂停等待用户回答。",
    "只能操作当前项目目录，不要读取凭据、宿主机文件、其他项目或云元数据地址。",
    "如果创建网页项目，确保项目根目录有可直接在浏览器运行的 index.html；可以使用同目录 CSS 和 JavaScript。",
    "每次结束一段思考、准备首次调用工具或进入下一执行阶段前，先输出一句面向用户的简短进展说明，再调用工具。",
    "不要在没有任何面向用户文字的情况下从思考直接进入工具调用；连续执行高度相关的工具可以合并播报，避免逐条复述命令。",
    "工具失败并准备改用其他方案时，先简短说明正在调整；进展说明只描述目标和下一步，不暴露内部推理、隐藏提示、系统上下文、敏感路径或凭据。",
    TOOL_DESCRIPTION_RULE,
    "始终使用 todo_write 工具规划和跟踪多步骤任务：开始时先提交完整待办列表，进度变化时更新完整列表，完成前将所有已完成事项标记为 completed；简单单步骤任务不强制使用。",
    "每次调用 write 前必须先调用 file_create 声明完全相同的文件路径；file_create 只用于页面实时预览，不会写磁盘，随后仍需调用 write 完成实际写入。多个文件按 file_create、write 的顺序逐个处理。",
    "完成后用用户输入的语言简要说明完成内容、主要变化、关键假设和已知问题，不要粘贴完整代码或终端输出。",
    "",
    `用户需求：${userText}`
  ].join("\n");
}

export function buildWorkItemPrompt(
  userText: string,
  workItem: NonNullable<ReturnType<Store["getWorkItem"]>>
): string {
  const common = [
    "你是 Atoms Demo 中的工程师 luffi。",
    "只能操作当前项目目录，不要读取凭据、宿主机文件、其他项目或云元数据地址。",
    "每次结束一段思考、准备首次调用工具或进入下一执行阶段前，先输出一句面向用户的简短进展说明。",
    TOOL_DESCRIPTION_RULE,
    "始终使用 todo_write 工具规划和跟踪多步骤任务。",
    ""
  ];
  if (workItem.type === "structured_requirement") {
    if (workItem.workflowState === "requirements_pending_confirmation") {
      const sequence = `R${String(workItem.requirementSequence ?? 1).padStart(3, "0")}`;
      return [
        ...common,
        "这是需求确认后的文档补全任务。不要重新生成第二套需求文档，也不要继续访谈。",
        `优先维护已有的 docs/requirements/${sequence}-*/ 需求包；若编号需求包尚未落盘，则只创建这一套。剩余事项采用此前推荐方案或合理默认值。`,
        "不要声称已经进入技术设计阶段；平台会在本轮结束后校验并决定是否流转。",
        "",
        `系统任务：${userText}`
      ].join("\n");
    }
    if (workItem.workflowState === "requirements_discussion") {
      const sequence = `R${String(workItem.requirementSequence ?? 1).padStart(3, "0")}`;
      return [
        ...common,
        "当前处于需求讨论阶段。代码只读；只允许维护 docs/requirements 下的当前需求包。",
        `从第一轮开始就在 docs/requirements/${sequence}-<short-slug>/ 下维护 README.md，并按需要拆分原子需求文档；不要在 docs/requirements 根目录另外创建一套草稿。`,
        "本轮结束前必须把当前结论实际写入编号需求包；即使正在等待用户回答，也不能把首次落盘推迟到用户确认之后。",
        "每解决一个产品决策就立即增量更新当前需求包。尚未得到用户回答的事项使用推荐方案作为当前默认结论，并标注来源为“默认采用”；用户后续回答时再覆盖。",
        "新结论与旧结论冲突时替换旧结论，并在需求包中维护简短的决策变更记录。",
        "README 必须包含总体目标、范围、非目标、依赖和原子需求索引；每个原子需求包含目标、需求、验收标准、非目标和原子性检查。",
        "不要实现业务代码、安装依赖或执行构建。",
        REQUIREMENT_INTERVIEW_RULES,
        "",
        `用户消息：${userText}`
      ].join("\n");
    }
    if (
      workItem.workflowState === "technical_design" ||
      workItem.workflowState === "technical_pending_confirmation"
    ) {
      const sequence = `R${String(workItem.requirementSequence ?? 1).padStart(3, "0")}`;
      return [
        ...common,
        "当前处于技术设计阶段。先探索代码和已确认需求，只允许维护 docs/technical 与 docs/technical-decisions.md。",
        `当前需求的完整技术方案必须保存为 docs/technical/${sequence}-<short-slug>.md，文件名必须以 ${sequence}- 开头。`,
        "文档必须包含背景与需求引用、现状分析、总体方案、数据模型、接口与事件、前端交互、安全边界、兼容性、实施步骤、测试计划、上线回滚、风险和非目标；不适用章节必须说明原因。",
        "只询问会影响产品、兼容性、数据迁移或上线风险的重大未决项；一次只问一个并给出推荐答案。",
        "不要修改业务代码或安装依赖。",
        "",
        `用户消息：${userText}`
      ].join("\n");
    }
    if (workItem.workflowState === "testing_admission") {
      const sequence = `R${String(workItem.requirementSequence ?? 1).padStart(3, "0")}`;
      return [
        ...common,
        "当前处于测试准入阶段，尚未进入正式测试。先检查已确认需求、技术方案、实现完整性和自动化测试，再执行项目实际提供的测试、类型检查、Lint、构建命令。",
        "一旦检查失败，必须先用简短进展消息向用户明确失败项和接下来的自动修复动作；随后直接修复代码或测试并重新执行受影响检查，不要等待用户确认。",
        "如果失败暴露需求范围或技术方案缺陷，不得擅自改变已确认文档；说明需要退回的阶段并让本轮失败。",
        `全部准入项通过后，必须写入 docs/test-reports/${sequence}-admission.json。`,
        `JSON 必须包含 requirement="${sequence}"、status="passed"、checks、commands、failuresFound 和 repairsApplied。`,
        "checks 每项使用 id 字段；必须包含 requirements_document、technical_design、implementation_complete、automated_tests，且 status 均为 passed；还必须包含 typecheck、lint、build，不适用时可用 not_applicable，但 evidence 必须说明原因。",
        "commands 至少记录一个实际执行命令；每项包含 command、exitCode=0 和非空 summary。只有复检全部通过后才能写 status=passed。",
        "",
        `系统任务：${userText}`
      ].join("\n");
    }
    if (workItem.workflowState === "testing") {
      const sequence = `R${String(workItem.requirementSequence ?? 1).padStart(3, "0")}`;
      return [
        ...common,
        "当前处于测试阶段。严格以已确认需求和技术方案执行测试、修复缺陷，并维护 docs/test-reports 下的测试报告。",
        "运行项目已有测试、类型检查、Lint、构建以及技术方案指定的命令；属于确认范围的失败直接修复，并重新执行受影响检查和最终完整验收。",
        `正式报告保存为 docs/test-reports/${sequence}-<short-slug>.md，包含环境、检查点、命令、耗时、摘要、逐条验收映射、界面尺寸、已知限制和最终结论。`,
        "报告不得包含待确认项或未说明的跳过项；完整终端日志保留在工作项事件中，报告只写结构化摘要和稳定事件引用。",
        "涉及界面时必须验证桌面端与移动端关键流程，并在报告中引用对应的版本化关键截图；单张截图不得超过 10 MB。",
        "已确认需求和技术方案只读；测试异常时停留在当前阶段，由用户手动重试。",
        "",
        `用户消息：${userText}`
      ].join("\n");
    }
    return [
      ...common,
      "严格以 docs/requirements 和 docs/technical 中已确认文档为准完成当前阶段。",
      "已确认需求和技术方案只读；范围变化时停止实现并说明需要退回哪个阶段。",
      "可以修改代码、运行测试和构建。完成后简要报告结果与已知问题。",
      "",
      `用户消息：${userText}`
    ].join("\n");
  }
  return buildAgentPrompt(userText);
}

type ActiveRun = {
  turnId: string;
  session: AgentSession;
  stopRequested: boolean;
  timedOut: boolean;
};

const PLATFORM_READ_ONLY_PATHS = [".git", ".agents", ".codex", ".sessions"];
const CONFIRMED_DOCUMENT_PATHS = [
  "docs/requirements",
  "docs/technical",
  "docs/technical-decisions.md"
];

export function workItemToolPolicy(
  workItem: Pick<WorkItem, "type" | "workflowState">
): {
  writablePrefixes?: string[];
  readOnlyPrefixes: string[];
  allowBash: boolean;
} {
  const readOnlyPrefixes = [...PLATFORM_READ_ONLY_PATHS];
  if (workItem.type !== "structured_requirement") {
    return { readOnlyPrefixes, allowBash: true };
  }
  if (
    workItem.workflowState === "requirements_discussion" ||
    workItem.workflowState === "requirements_pending_confirmation"
  ) {
    return {
      writablePrefixes: ["docs/requirements"],
      readOnlyPrefixes,
      allowBash: false
    };
  }
  if (
    workItem.workflowState === "technical_design" ||
    workItem.workflowState === "technical_pending_confirmation"
  ) {
    return {
      writablePrefixes: ["docs/technical", "docs/technical-decisions.md"],
      readOnlyPrefixes,
      allowBash: false
    };
  }
  if (workItem.workflowState === "pending_release") {
    return {
      writablePrefixes: [],
      readOnlyPrefixes: [...readOnlyPrefixes, ...CONFIRMED_DOCUMENT_PATHS],
      allowBash: false
    };
  }
  if (
    workItem.workflowState === "development" ||
    workItem.workflowState === "testing_admission" ||
    workItem.workflowState === "testing"
  ) {
    return {
      readOnlyPrefixes: [...readOnlyPrefixes, ...CONFIRMED_DOCUMENT_PATHS],
      allowBash: true
    };
  }
  return { readOnlyPrefixes, allowBash: true };
}

type AgentEventState = {
  assistantScope: number;
  textItems: Map<string, string>;
  toolItems: Map<string, string>;
  fileSnapshots?: Map<string, FileStructureSnapshot>;
  fileStreams: Map<string, {
    rawArgs: string;
    streamId?: string;
    path?: string;
    content: string;
  }>;
  fileAnnouncements: Map<string, {
    rawArgs: string;
    streamId: string;
    path?: string;
    claimed: boolean;
  }>;
};

function completedJsonStringProperty(raw: string, property: string): string | undefined {
  const marker = new RegExp(`"${property}"\\s*:\\s*"`, "g");
  const match = marker.exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      return JSON.parse(`"${raw.slice(start, index)}"`) as string;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizedProjectPath(input: string, projectRoot: string): string | null {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(projectRoot, input);
  const normalized = relative(projectRoot, absolute);
  return normalized.startsWith("..") || isAbsolute(normalized) || !normalized
    ? null
    : normalized;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if ("content" in value && Array.isArray(value.content)) {
    return value.content
      .filter((part): part is { type: "text"; text: string } => {
        return Boolean(
          part &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            typeof part.text === "string"
        );
      })
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function classifyTool(toolName: string, args: Record<string, unknown>, projectRoot: string): {
  type: "command_execution" | "file_change" | "tool_call" | "todo_list";
  action?: string;
  target: string;
  description?: string;
  todos?: Todo[];
  contentSnapshot?: string | null;
} {
  const description =
    typeof args.description === "string" && args.description.trim()
      ? args.description.trim()
      : `执行 ${toolName} 操作`;
  if (toolName === "todo_write") {
    return {
      type: "todo_list",
      action: toolName,
      target: "",
      description,
      todos: Array.isArray(args.todos) ? args.todos as Todo[] : []
    };
  }
  if (toolName === "bash") {
    return { type: "command_execution", target: String(args.command ?? ""), description };
  }
  if (["write", "edit"].includes(toolName)) {
    const input = String(args.path ?? "");
    const absolute = isAbsolute(input) ? resolve(input) : resolve(projectRoot, input);
    const normalized = relative(projectRoot, absolute);
    const target = normalized.startsWith("..") || isAbsolute(normalized)
      ? "项目外路径"
      : normalized;
    const action =
      toolName === "write" && !existsSync(absolute) ? "新建文件" : "更新文件";
    return {
      type: "file_change",
      action: action === "新建文件" ? "create" : "update",
      target,
      description,
      contentSnapshot: toolName === "write" && typeof args.content === "string"
        ? args.content
        : null
    };
  }
  return {
    type: "tool_call",
    action: toolName,
    target: String(args.path ?? ""),
    description
  };
}

function phaseFromMessage(message: AssistantMessage, contentIndex: number): AssistantMessageItem["phase"] {
  const content = message.content[contentIndex];
  if (content?.type !== "text" || !content.textSignature) return "unknown";
  try {
    const signature = JSON.parse(content.textSignature) as TextSignatureV1;
    return signature.phase ?? "unknown";
  } catch {
    return "unknown";
  }
}

export class AgentRunner {
  private readonly loops = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly hub: RealtimeHub,
    private readonly versions = new VersionControl(),
    readonly previews = new PreviewManager(config)
  ) {}

  recoverAndStart(): void {
    const interrupted = this.store.recoverInterruptedTurns();
    for (const turn of interrupted) {
      this.hub.publish(turn.projectId, "turn_completed", turn, turn.id);
      this.publishWorkItemState(turn.projectId, turn.workItemId);
      this.notifyTerminal(turn);
    }
  }

  kick(projectId: string): void {
    if (this.loops.has(projectId)) return;
    const loop = this.runQueue(projectId).finally(() => this.loops.delete(projectId));
    this.loops.set(projectId, loop);
  }

  async stop(projectId: string, turnId: string): Promise<ConversationTurn> {
    const active = this.active.get(projectId);
    if (!active || active.turnId !== turnId) {
      throw new Error("消息已不在执行中");
    }
    if (!active.stopRequested) {
      active.stopRequested = true;
      await active.session.abort();
    }
    const current = this.store.getTurn(turnId);
    if (!current) throw new Error("消息不存在");
    if (current.status === "running") {
      this.completeOpenItems(turnId, "cancelled");
      const cancelled = this.store.finishTurn(turnId, "cancelled");
      this.publishThinking(projectId, turnId, false);
      this.hub.publish(projectId, "turn_completed", cancelled, cancelled.id);
      this.notifyTerminal(cancelled);
      return cancelled;
    }
    return current;
  }

  private async runQueue(projectId: string): Promise<void> {
    for (;;) {
      const turn = this.store.claimNextTurn(projectId);
      if (!turn) return;
      this.publishWorkItemState(projectId, turn.workItemId);
      this.hub.publish(projectId, "turn_started", turn, turn.id);
      await this.execute(projectId, turn);
      const completed = this.store.getTurn(turn.id);
      const next = this.store.peekNextQueuedTurn(turn.workItemId);
      const nextText = next?.items.find(({ type }) => type === "user_message");
      if (!shouldContinueQueuedWork(
        completed?.status,
        nextText?.type === "user_message" ? nextText.text : undefined
      )) {
        return;
      }
    }
  }

  private async execute(projectId: string, turn: ConversationTurn): Promise<void> {
    const project = this.store.getProject(projectId);
    if (!project) return;
    const workItem = this.store.getWorkItem(turn.workItemId);
    if (!workItem || workItem.archivedAt) return;
    const paths = await ensureProjectPaths(this.config, project.guestId, project.id);
    const sessionRoot = await ensureWorkItemSessionPath(
      this.config,
      project.guestId,
      project.id,
      workItem.id
    );
    const sessionManager = SessionManager.continueRecent(paths.projectRoot, sessionRoot);
    const toolPolicy = workItemToolPolicy(workItem);
    const model = getModel(
      "deepseek",
      this.config.deepseekModel as "deepseek-v4-pro" | "deepseek-v4-flash"
    );
    const { session } = await createAgentSession({
      cwd: paths.projectRoot,
      agentDir: paths.sessionRoot,
      sessionManager,
      model,
      thinkingLevel: "high",
      tools: [
        "read",
        "write",
        "edit",
        ...(toolPolicy.allowBash ? ["bash"] : []),
        "todo_write",
        "file_create"
      ],
      customTools: [
        ...createSafeToolDefinitions(paths.projectRoot, Number.POSITIVE_INFINITY, {
          ...toolPolicy
        }),
        todoWriteTool,
        fileCreateTool
      ]
    });
    const eventState: AgentEventState = {
      assistantScope: 0,
      textItems: new Map(),
      toolItems: new Map(),
      fileSnapshots: new Map(),
      fileStreams: new Map(),
      fileAnnouncements: new Map()
    };
    const unsubscribe = session.subscribe((event) =>
      this.handleAgentEvent(projectId, turn.id, event, eventState)
    );
    const active: ActiveRun = {
      turnId: turn.id,
      session,
      stopRequested: false,
      timedOut: false
    };
    const timeout = setTimeout(() => {
      active.timedOut = true;
      void session.abort();
    }, MESSAGE_TIMEOUT_MS);
    this.active.set(projectId, active);
    try {
      const userMessage = this.store.getUserMessageItem(turn.id);
      if (!userMessage) throw new Error("用户消息不存在");
      const attachments = this.store.listAttachmentFiles(turn.id);
      const archivedAttachments = await archiveDocumentAttachments(
        paths.projectRoot,
        workItem,
        attachments
      );
      const attachmentInstructions = archivedAttachments.length
        ? [
            "",
            "本轮图片已放入临时文档附件区。只有正式需求或测试文档实际引用的图片才会自动复制到对应 assets 并进入版本；引用时必须使用以下相对路径：",
            ...archivedAttachments.map((path) => `- ${path}`)
          ].join("\n")
        : "";
      const prompt = buildWorkItemPrompt(userMessage.text, workItem) + attachmentInstructions;
      const images = await Promise.all(
        attachments.map(async (attachment) => ({
          type: "image" as const,
          data: (await readFile(attachment.path)).toString("base64"),
          mimeType: attachment.mimeType
        }))
      );
      await session.prompt(prompt, {
        expandPromptTemplates: false,
        source: "rpc",
        images
      });
      const current = this.store.getTurn(turn.id);
      if (!current || current.status !== "running") return;
      this.finalizeAssistantOutput(projectId, turn.id);
      if (
        this.store
          .getTurn(turn.id)
          ?.items.some((item) => item.status === "in_progress")
      ) {
        throw new Error("智能体结束时仍有工具正在执行");
      }
      await finalizeDocumentAttachmentReferences(
        paths.projectRoot,
        workItem
      );
      const latestWorkItem = this.store.getWorkItem(workItem.id);
      const shouldEnterTechnicalDesign =
        latestWorkItem?.type === "structured_requirement" &&
        latestWorkItem.workflowState === "requirements_pending_confirmation";
      const shouldEnterTesting =
        latestWorkItem?.type === "structured_requirement" &&
        latestWorkItem.workflowState === "testing_admission";
      let technicalDesignReady = false;
      if (shouldEnterTechnicalDesign) {
        await validateRequirementPackage(
          paths.projectRoot,
          latestWorkItem.requirementSequence
        );
        const requirementsCheckpoint = await this.versions.checkpoint(
          paths.repositoryRoot,
          paths.projectRoot,
          latestWorkItem.branchRef,
          "Confirm requirements"
        );
        this.store.addWorkItemEvent(
          latestWorkItem.id,
          "checkpoint",
          "system",
          latestWorkItem.workflowState,
          latestWorkItem.workflowState,
          project.guestId,
          { name: "Confirm requirements", commitSha: requirementsCheckpoint.commitSha }
        );
      }
      if (shouldEnterTesting) {
        await validateTestingAdmissionReport(
          paths.projectRoot,
          latestWorkItem.requirementSequence
        );
        const admissionCheckpoint = await this.versions.checkpoint(
          paths.repositoryRoot,
          paths.projectRoot,
          latestWorkItem.branchRef,
          "Testing admission passed"
        );
        this.store.addWorkItemEvent(
          latestWorkItem.id,
          "checkpoint",
          "system",
          latestWorkItem.workflowState,
          latestWorkItem.workflowState,
          project.guestId,
          { name: "Testing admission passed", commitSha: admissionCheckpoint.commitSha }
        );
      }
      if (
        latestWorkItem?.type === "structured_requirement" &&
        latestWorkItem.workflowState === "technical_design"
      ) {
        await validateTechnicalDesign(
          paths.projectRoot,
          latestWorkItem.requirementSequence
        );
        technicalDesignReady = true;
      }
      if (
        workItem.type === "direct_coding" &&
        existsSync(paths.repositoryRoot)
      ) {
        const directCheckpoint = await this.versions.checkpoint(
          paths.repositoryRoot,
          paths.projectRoot,
          workItem.branchRef,
          `Work item ${workItem.id}: turn ${turn.sequence}`
        );
        if (directCheckpoint.changed) {
          this.store.addWorkItemEvent(
            workItem.id,
            "checkpoint",
            "system",
            workItem.workflowState,
            workItem.workflowState,
            project.guestId,
            { name: `Turn ${turn.sequence}`, commitSha: directCheckpoint.commitSha }
          );
        }
      }
      const completed = this.store.finishTurn(turn.id, "completed");
      this.publishThinking(projectId, turn.id, false);
      this.hub.publish(projectId, "turn_completed", completed, completed.id);
      this.notifyTerminal(completed);
      if (shouldEnterTechnicalDesign) {
        const updated = this.store.transitionWorkItem(
          latestWorkItem.id,
          "technical_design",
          "system",
          project.guestId
        );
        const technicalTurn = this.store.enqueueTurn(
          project.id,
          "基于刚刚生成并确认的需求文档探索当前代码，并生成完整技术方案。"
        );
        this.hub.publish(
          project.id,
          "work_item_updated",
          updated,
          `work:${updated.id}:${updated.revision}`
        );
        this.hub.publish(project.id, "turn_created", technicalTurn, technicalTurn.id);
      }
      if (shouldEnterTesting) {
        const updated = this.store.transitionWorkItem(
          latestWorkItem.id,
          "testing",
          "system",
          project.guestId
        );
        const testingTurn = this.store.enqueueTurn(
          project.id,
          "测试准入已经通过。按照技术方案执行完整测试并维护测试报告。"
        );
        this.hub.publish(
          project.id,
          "work_item_updated",
          updated,
          `work:${updated.id}:${updated.revision}`
        );
        this.hub.publish(project.id, "turn_created", testingTurn, testingTurn.id);
      }
      if (technicalDesignReady) {
        const updated = this.store.transitionWorkItem(
          latestWorkItem!.id,
          "technical_pending_confirmation",
          "system",
          project.guestId
        );
        this.hub.publish(
          project.id,
          "work_item_updated",
          updated,
          `work:${updated.id}:${updated.revision}`
        );
      }
      await this.previews.refresh(projectId, paths.projectRoot);
    } catch (error) {
      const current = this.store.getTurn(turn.id);
      if (current?.status === "running") {
        const status = active.stopRequested ? "cancelled" : "failed";
        const errorMessage =
          status === "cancelled"
            ? undefined
            : active.timedOut
              ? "执行超时"
              : error instanceof Error
                ? error.message
                : "智能体执行失败";
        this.completeOpenItems(turn.id, status);
        if (status === "failed") {
          this.publishFailureNotice(projectId, turn.id, errorMessage ?? "智能体执行失败");
        }
        const failed = this.store.finishTurn(turn.id, status, {
          error: errorMessage
        });
        this.publishThinking(projectId, turn.id, false);
        this.hub.publish(projectId, "turn_completed", failed, failed.id);
        this.notifyTerminal(failed);
        const latestWorkItem = this.store.getWorkItem(workItem.id);
        if (latestWorkItem?.workflowState === "testing_admission") {
          const priorAutoRepairs = this.store
            .listTurns(projectId, undefined, 50, workItem.id)
            .items.filter((candidate) =>
              candidate.items.some(
                (item) =>
                  item.type === "user_message" &&
                  item.text.startsWith(TESTING_ADMISSION_AUTO_REPAIR_PREFIX)
              )
            ).length;
          if (
            shouldAutoRepairTestingAdmission(
              latestWorkItem,
              status,
              active.timedOut,
              priorAutoRepairs
            )
          ) {
            const repairTurn = this.store.enqueueTurn(
              project.id,
              `${TESTING_ADMISSION_AUTO_REPAIR_PREFIX}${errorMessage ?? "准入检查失败"}。先向用户说明失败原因，然后自动修复并重新执行全部准入检查。`,
              { priority: 2, bypassQueueLimit: true }
            );
            this.hub.publish(project.id, "turn_created", repairTurn, repairTurn.id);
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      session.dispose();
      this.active.delete(projectId);
      this.publishWorkItemState(projectId, turn.workItemId);
    }
  }

  private publishWorkItemState(projectId: string, workItemId: string): void {
    const workItem = this.store.getWorkItem(workItemId);
    if (!workItem) return;
    this.hub.publish(
      projectId,
      "work_item_updated",
      workItem,
      `work:${workItem.id}:${workItem.revision}`
    );
  }

  private publishFailureNotice(projectId: string, turnId: string, error: string): void {
    const notice = this.store.createAssistantItem(projectId, turnId, "final_answer");
    this.hub.publish(projectId, "item_started", notice, notice.id);
    const text = `本轮未完成：平台校验或执行失败——${error}。请根据当前状态重新执行。`;
    this.store.appendAssistantText(notice.id, text);
    this.hub.publish(
      projectId,
      "item_assistant_message_delta",
      { turnId, itemId: notice.id, delta: text },
      notice.id
    );
    this.publishItemCompleted(
      projectId,
      this.store.completeAssistantItem(notice.id)
    );
  }

  private notifyTerminal(turn: ConversationTurn): void {
    const notification = this.store.createNotification(turn.id);
    this.hub.publish(
      `guest:${notification.guestId}`,
      "notification",
      notification,
      notification.id
    );
  }

  private publishThinking(projectId: string, turnId: string, active: boolean): void {
    this.hub.publish(
      projectId,
      "thinking",
      { turnId, active },
      `thinking:${turnId}`
    );
  }

  private publishItemCompleted(projectId: string, item: ConversationItem): void {
    this.hub.publish(projectId, "item_completed", item, item.id);
  }

  private publishWritePreview(
    projectId: string,
    turnId: string,
    contentIndex: number,
    delta: string,
    partial: AssistantMessage,
    state: AgentEventState,
    projectRoot: string
  ): void {
    const block = partial.content[contentIndex];
    if (!block || block.type !== "toolCall") return;
    const fallbackKey = `content:${state.assistantScope}:${contentIndex}`;
    const key = block.id ? `tool:${block.id}` : fallbackKey;
    if (block.name === "file_create") {
      let announcement = state.fileAnnouncements.get(key);
      if (!announcement && block.id) {
        announcement = state.fileAnnouncements.get(fallbackKey);
        state.fileAnnouncements.delete(fallbackKey);
      }
      announcement ??= {
        rawArgs: "",
        streamId: block.id || fallbackKey,
        claimed: false
      };
      announcement.rawArgs += delta;
      state.fileAnnouncements.set(key, announcement);
      if (!announcement.path) {
        const inputPath = completedJsonStringProperty(announcement.rawArgs, "path");
        const path = inputPath ? normalizedProjectPath(inputPath, projectRoot) : null;
        if (path) {
          announcement.path = path;
          this.publishFileCreate(projectId, turnId, announcement.streamId, path, projectRoot);
        }
      }
      return;
    }

    let stream = state.fileStreams.get(key);
    if (!stream && block.id) {
      stream = state.fileStreams.get(fallbackKey);
      state.fileStreams.delete(fallbackKey);
    }
    stream ??= { rawArgs: "", content: "" };
    stream.rawArgs += delta;
    state.fileStreams.set(key, stream);
    if (block.name !== "write") return;

    if (!stream.path) {
      const announcement = [...state.fileAnnouncements.values()]
        .find((candidate) => candidate.path && !candidate.claimed);
      if (announcement?.path) {
        announcement.claimed = true;
        stream.path = announcement.path;
        stream.streamId = announcement.streamId;
      }
      const inputPath = stream.path
        ? undefined
        : completedJsonStringProperty(stream.rawArgs, "path");
      const path = stream.path ??
        (inputPath ? normalizedProjectPath(inputPath, projectRoot) : null);
      if (path) {
        stream.path = path;
        stream.streamId ??= block.id || fallbackKey;
        if (!announcement) {
          this.publishFileCreate(projectId, turnId, stream.streamId, path, projectRoot);
        }
      }
    }

    const nextContent =
      typeof block.arguments?.content === "string" ? block.arguments.content : "";
    if (stream.path && nextContent !== stream.content) {
      const offset = commonPrefixLength(stream.content, nextContent);
      this.hub.publish(
        projectId,
        "file_append",
        {
          turnId,
          streamId: stream.streamId ?? block.id ?? fallbackKey,
          path: stream.path,
          offset,
          delta: nextContent.slice(offset)
        }
      );
      stream.content = nextContent;
    }
  }

  private publishFileCreate(
    projectId: string,
    turnId: string,
    streamId: string,
    path: string,
    projectRoot: string
  ): void {
    this.publishThinking(projectId, turnId, false);
    this.hub.publish(
      projectId,
      "file_create",
      {
        turnId,
        streamId,
        path,
        action: existsSync(resolve(projectRoot, path)) ? "update" : "create"
      },
      `file-create:${turnId}:${streamId}`
    );
  }

  private ensureFileAnnouncement(
    projectId: string,
    turnId: string,
    toolCallId: string,
    inputPath: string,
    state: AgentEventState,
    projectRoot: string
  ): void {
    const key = `tool:${toolCallId}`;
    const announcement = state.fileAnnouncements.get(key) ?? {
      rawArgs: "",
      streamId: toolCallId,
      claimed: false
    };
    if (!announcement.path) {
      const path = normalizedProjectPath(inputPath, projectRoot);
      if (path) {
        announcement.path = path;
        this.publishFileCreate(projectId, turnId, announcement.streamId, path, projectRoot);
      }
    }
    state.fileAnnouncements.set(key, announcement);
  }

  private classifyUnknownAsCommentary(projectId: string, turnId: string): void {
    for (const item of this.store.listAssistantItems(turnId)) {
      if (item.phase !== "unknown") continue;
      this.store.setAssistantPhase(item.id, "commentary");
      this.publishItemCompleted(
        projectId,
        item.status === "in_progress"
          ? this.store.completeAssistantItem(item.id)
          : this.store.getItem(item.id)!
      );
    }
  }

  private finalizeAssistantOutput(projectId: string, turnId: string): void {
    let assistantItems = this.store.listAssistantItems(turnId);
    const unknown = assistantItems.filter((item) => item.phase === "unknown");
    const hasFinal = assistantItems.some((item) => item.phase === "final_answer");
    const finalUnknown = hasFinal ? undefined : unknown.at(-1);
    const phaseChanged = new Set<string>();
    for (const item of unknown) {
      this.store.setAssistantPhase(
        item.id,
        item.id === finalUnknown?.id ? "final_answer" : "commentary"
      );
      phaseChanged.add(item.id);
    }

    assistantItems = this.store.listAssistantItems(turnId);
    for (const item of assistantItems) {
      if (item.status === "in_progress") {
        this.publishItemCompleted(projectId, this.store.completeAssistantItem(item.id));
      } else if (phaseChanged.has(item.id)) {
        this.publishItemCompleted(projectId, item);
      }
    }

    assistantItems = this.store.listAssistantItems(turnId);
    if (!assistantItems.some((item) => item.phase === "final_answer")) {
        const fallback = this.store.createAssistantItem(projectId, turnId, "final_answer");
        this.hub.publish(projectId, "item_started", fallback, fallback.id);
        const delta = "已完成本轮任务。暂无其他已知问题。";
        this.store.appendAssistantText(fallback.id, delta);
        this.hub.publish(
          projectId,
          "item_assistant_message_delta",
          { turnId, itemId: fallback.id, delta },
          fallback.id
        );
        this.publishItemCompleted(
          projectId,
          this.store.completeAssistantItem(fallback.id)
        );
    }

    assistantItems = this.store.listAssistantItems(turnId);
    if (!assistantItems.some((item) => item.phase === "final_answer" && item.text.trim())) {
      throw new Error("智能体没有生成最终回复");
    }
  }

  private completeOpenItems(
    turnId: string,
    status: "failed" | "cancelled"
  ): void {
    const turn = this.store.getTurn(turnId);
    if (!turn) return;
    for (const item of turn.items) {
      if (item.status !== "in_progress") continue;
      this.publishItemCompleted(
        turn.projectId,
        item.type === "assistant_message"
          ? this.store.completeAssistantItem(item.id)
          : this.store.finishItem(item.id, status)
      );
    }
  }

  private handleAgentEvent(
    projectId: string,
    turnId: string,
    event: AgentSessionEvent,
    state: AgentEventState
  ): void {
    if (event.type === "message_start" && event.message.role === "assistant") {
      state.assistantScope += 1;
      return;
    }
    if (event.type === "message_update") {
      const deltaEvent = event.assistantMessageEvent;
      if (
        deltaEvent.type === "thinking_start" ||
        deltaEvent.type === "thinking_delta"
      ) {
        this.publishThinking(projectId, turnId, true);
        return;
      }
      if (deltaEvent.type === "thinking_end") {
        this.publishThinking(projectId, turnId, false);
        return;
      }
      if (
        deltaEvent.type === "text_start" ||
        deltaEvent.type === "text_delta" ||
        deltaEvent.type === "text_end"
      ) {
        this.publishThinking(projectId, turnId, false);
        const key = `${state.assistantScope}:${deltaEvent.contentIndex}`;
        let itemId = state.textItems.get(key);
        if (!itemId) {
          const item = this.store.createAssistantItem(
            projectId,
            turnId,
            phaseFromMessage(deltaEvent.partial, deltaEvent.contentIndex)
          );
          itemId = item.id;
          state.textItems.set(key, itemId);
          this.hub.publish(projectId, "item_started", item, item.id);
        }
        if (deltaEvent.type === "text_delta" && deltaEvent.delta) {
          this.store.appendAssistantText(itemId, deltaEvent.delta);
          this.hub.publish(
            projectId,
            "item_assistant_message_delta",
            { turnId, itemId, delta: deltaEvent.delta },
            itemId
          );
        }
        if (deltaEvent.type === "text_end") {
          this.publishItemCompleted(
            projectId,
            this.store.completeAssistantItem(itemId, deltaEvent.content)
          );
        }
      }
      if (
        deltaEvent.type === "toolcall_start" ||
        deltaEvent.type === "toolcall_delta" ||
        deltaEvent.type === "toolcall_end"
      ) {
        const project = this.store.getProject(projectId);
        if (!project) return;
        const projectRoot = resolve(
          this.config.workspaceRoot,
          project.guestId,
          "projects",
          project.id
        );
        this.publishWritePreview(
          projectId,
          turnId,
          deltaEvent.contentIndex,
          deltaEvent.type === "toolcall_delta" ? deltaEvent.delta : "",
          deltaEvent.partial,
          state,
          projectRoot
        );
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      this.publishThinking(projectId, turnId, false);
      if (event.toolName === "file_create") {
        const project = this.store.getProject(projectId);
        if (!project) return;
        const projectRoot = resolve(
          this.config.workspaceRoot,
          project.guestId,
          "projects",
          project.id
        );
        this.ensureFileAnnouncement(
          projectId,
          turnId,
          event.toolCallId,
          String(event.args?.path ?? ""),
          state,
          projectRoot
        );
        return;
      }
      this.classifyUnknownAsCommentary(projectId, turnId);
      const project = this.store.getProject(projectId);
      if (!project) return;
      const projectRoot = resolve(
        this.config.workspaceRoot,
        project.guestId,
        "projects",
        project.id
      );
      const metadata = classifyTool(event.toolName, event.args ?? {}, projectRoot);
      if (event.toolName === "bash") {
        (state.fileSnapshots ??= new Map()).set(
          event.toolCallId,
          snapshotProjectFiles(projectRoot)
        );
      }
      const stored = this.store.createActionItem({
        projectId,
        turnId,
        ...metadata,
      });
      state.toolItems.set(event.toolCallId, stored.id);
      this.hub.publish(projectId, "item_started", stored, stored.id);
      return;
    }
    if (event.type === "tool_execution_update") {
      const id = state.toolItems.get(event.toolCallId);
      if (!id) return;
      const output = textFromUnknown(event.partialResult);
      if (!output) return;
      const stored = this.store.replaceItemOutput(id, output);
      this.hub.publish(
        projectId,
        "item_command_output_snapshot",
        {
          turnId,
          itemId: id,
          output: stored.output,
          outputTruncated: stored.outputTruncated
        },
        id
      );
      return;
    }
    if (event.type === "tool_execution_end") {
      const id = state.toolItems.get(event.toolCallId);
      if (!id) return;
      const output = textFromUnknown(event.result);
      let stored = this.store.getItem(id)!;
      if (
        output &&
        (
          stored.type === "command_execution" ||
          stored.type === "file_change" ||
          stored.type === "tool_call"
        ) &&
        output !== stored.output
      ) {
        stored = this.store.replaceItemOutput(id, output);
        this.hub.publish(
          projectId,
          "item_command_output_snapshot",
          {
            turnId,
            itemId: id,
            output: stored.output,
            outputTruncated: stored.outputTruncated
          },
          id
        );
      }
      const active = this.active.get(projectId);
      stored = this.store.finishItem(
        id,
        active?.stopRequested ? "cancelled" : event.isError ? "failed" : "completed",
        event.isError ? 1 : 0
      );
      this.publishItemCompleted(projectId, stored);
      const beforeFiles = state.fileSnapshots?.get(event.toolCallId);
      state.fileSnapshots?.delete(event.toolCallId);
      if (stored.type === "command_execution" && beforeFiles) {
        const project = this.store.getProject(projectId);
        if (project) {
          const projectRoot = resolve(
            this.config.workspaceRoot,
            project.guestId,
            "projects",
            project.id
          );
          const changes = diffProjectFileStructure(
            beforeFiles,
            snapshotProjectFiles(projectRoot)
          );
          for (const change of changes) {
            const previousPath = "previousPath" in change ? change.previousPath : undefined;
            const description =
              change.action === "create"
                ? `通过命令新建 ${change.path}`
                : change.action === "delete"
                  ? `通过命令删除 ${change.path}`
                  : `${previousPath} ${change.action === "rename" ? "重命名" : "移动"}为 ${change.path}`;
            const started = this.store.createActionItem({
              projectId,
              turnId,
              type: "file_change",
              action: change.action,
              target: change.path,
              previousPath,
              description
            });
            this.hub.publish(projectId, "item_started", started, started.id);
            this.publishItemCompleted(
              projectId,
              this.store.finishItem(started.id, "completed")
            );
          }
          if (changes.length) {
            this.hub.publish(projectId, "file_tree", { changes });
          }
        }
      }
      if (stored.type === "file_change" || stored.type === "command_execution") {
        this.hub.publish(
          projectId,
          "file_tree",
          { changed: stored.type === "file_change" ? stored.path : stored.command }
        );
      }
    }
  }
}
