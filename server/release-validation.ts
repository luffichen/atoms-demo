import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PreviewState } from "./preview-manager.js";
import { runSandboxedProjectCommand } from "./safe-tools.js";

const QUALITY_SCRIPTS = ["test", "typecheck", "lint", "build"] as const;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".tmp",
  ".npm-cache",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage"
]);
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u;
const CLOUD_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u;

export interface ReleaseValidationCheck {
  id: string;
  status: "passed" | "not_applicable";
  evidence: string;
}

export interface ReleaseValidationReport {
  status: "passed";
  checks: ReleaseValidationCheck[];
  commands: Array<{
    command: string;
    exitCode: number;
    summary: string;
  }>;
  preview: PreviewState;
  validatedAt: string;
}

export class ReleaseValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly evidence = ""
  ) {
    super(message);
    this.name = "ReleaseValidationError";
  }
}

export type ReleaseCommandRunner = (
  projectRoot: string,
  command: string
) => Promise<{ exitCode: number; output: string }>;

async function defaultCommandRunner(
  projectRoot: string,
  command: string
): Promise<{ exitCode: number; output: string }> {
  let output = "";
  const result = await runSandboxedProjectCommand({
    projectRoot,
    command,
    timeoutSeconds: 10 * 60,
    onData: (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-64 * 1024);
    }
  });
  return {
    exitCode: result.exitCode,
    output: output.slice(-64 * 1024)
  };
}

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts?: unknown;
    };
    if (!value.scripts || typeof value.scripts !== "object") return {};
    return Object.fromEntries(
      Object.entries(value.scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new ReleaseValidationError("package_invalid", "package.json 无法解析");
  }
}

async function assertNoSensitiveContent(projectRoot: string): Promise<number> {
  let checked = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      checked += 1;
      const lower = entry.name.toLowerCase();
      if (
        lower === ".env" ||
        lower.startsWith(".env.") ||
        lower === "id_rsa" ||
        lower === "credentials.json"
      ) {
        throw new ReleaseValidationError(
          "sensitive_file",
          `检测到敏感文件：${relative(projectRoot, absolute)}`
        );
      }
      let content: string;
      try {
        const buffer = await readFile(absolute);
        if (buffer.byteLength > 1024 * 1024 || buffer.includes(0)) continue;
        content = buffer.toString("utf8");
      } catch {
        continue;
      }
      if (PRIVATE_KEY_PATTERN.test(content) || CLOUD_KEY_PATTERN.test(content)) {
        throw new ReleaseValidationError(
          "sensitive_content",
          `检测到疑似密钥内容：${relative(projectRoot, absolute)}`
        );
      }
    }
  };
  await walk(projectRoot);
  return checked;
}

export async function validateReleaseCandidate(input: {
  projectId: string;
  projectRoot: string;
  refreshPreview: (projectId: string, projectRoot: string) => Promise<PreviewState>;
  runCommand?: ReleaseCommandRunner;
}): Promise<ReleaseValidationReport> {
  const checks: ReleaseValidationCheck[] = [];
  const commands: ReleaseValidationReport["commands"] = [];
  const scripts = await readPackageScripts(input.projectRoot);
  const runCommand = input.runCommand ?? defaultCommandRunner;

  for (const script of QUALITY_SCRIPTS) {
    if (!scripts[script]) {
      checks.push({
        id: script,
        status: "not_applicable",
        evidence: `项目未提供 npm run ${script}，按无自动化脚本项目处理`
      });
      continue;
    }
    const command = `npm run ${script}`;
    let result: Awaited<ReturnType<ReleaseCommandRunner>>;
    try {
      result = await runCommand(input.projectRoot, command);
    } catch (error) {
      throw new ReleaseValidationError(
        "quality_check_failed",
        `发布前检查无法完成：${command}`,
        error instanceof Error ? error.message : String(error)
      );
    }
    commands.push({
      command,
      exitCode: result.exitCode,
      summary: result.output.trim().slice(-2_000) || "命令执行完成"
    });
    if (result.exitCode !== 0) {
      throw new ReleaseValidationError(
        "quality_check_failed",
        `发布前检查失败：${command}`,
        result.output.trim().slice(-4_000)
      );
    }
    checks.push({ id: script, status: "passed", evidence: `${command} 退出码 0` });
  }

  const configurationFiles = (
    await readdir(input.projectRoot, { withFileTypes: true })
  )
    .filter(
      (entry) =>
        entry.isFile() &&
        (
          entry.name === "package.json" ||
          /^(?:tsconfig|vite\.config|next\.config|eslint\.config|Dockerfile|docker-compose)/u.test(
            entry.name
          )
        )
    )
    .map(({ name }) => name);
  checks.push({
    id: "configuration",
    status: configurationFiles.length ? "passed" : "not_applicable",
    evidence: configurationFiles.length
      ? `已解析或识别项目配置：${configurationFiles.join("、")}`
      : "未发现适用的项目配置文件，按无配置项目处理"
  });

  const checkedFiles = await assertNoSensitiveContent(input.projectRoot);
  if (checkedFiles === 0) {
    throw new ReleaseValidationError(
      "candidate_empty",
      "候选版本没有可发布文件，已阻止发布"
    );
  }
  checks.push({
    id: "candidate_files",
    status: "passed",
    evidence: `候选版本最低文件检查通过，共 ${checkedFiles} 个文件`
  });
  checks.push({
    id: "sensitive_content",
    status: "passed",
    evidence: `已检查 ${checkedFiles} 个候选文件，未发现敏感文件或密钥内容`
  });

  const preview = await input.refreshPreview(input.projectId, input.projectRoot);
  if (preview.previewCapable && preview.previewStatus !== "ready") {
    throw new ReleaseValidationError(
      "preview_unavailable",
      "候选预览启动失败，已阻止发布",
      preview.previewError ?? "预览未就绪"
    );
  }
  checks.push({
    id: "preview",
    status: preview.previewCapable ? "passed" : "not_applicable",
    evidence: preview.previewCapable
      ? `候选预览已就绪：${preview.previewUrl ?? "内部预览"}`
      : "非网页项目，无需预览门禁"
  });

  return {
    status: "passed",
    checks,
    commands,
    preview,
    validatedAt: new Date().toISOString()
  };
}
