import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_PROJECT_LIMIT_BYTES = 1024 * 1024 * 1024;
const INTERACTIVE_COMMAND =
  /(^|[;&|]\s*)(sudo|su|passwd|read|select|ssh|telnet|ftp|mysql|psql)\b/u;

export function requiresInteractiveInput(command: string): boolean {
  return INTERACTIVE_COMMAND.test(command);
}

export function commandCloseError(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
  timeoutMs?: number;
}): Error | null {
  if (input.timedOut) {
    return new Error(`timeout:${Math.max(1, Math.ceil((input.timeoutMs ?? 0) / 1_000))}`);
  }
  if (input.aborted) return new Error("aborted");
  if (input.code === null || input.signal !== null) {
    return new Error(`命令被信号终止（${input.signal ?? "未知信号"}）`);
  }
  return null;
}

export function bashTimeoutMs(timeoutSeconds?: number): number | undefined {
  return timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000;
}

export function requireUserDescription(
  definition: ToolDefinition<any, any, any>
): ToolDefinition<any, any, any> {
  const parameters = definition.parameters as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  return {
    ...definition,
    parameters: {
      ...parameters,
      required: [...new Set([...(parameters.required ?? []), "description"])],
      properties: {
        ...(parameters.properties ?? {}),
        description: {
          type: "string",
          minLength: 1,
          description: "面向用户简短说明本次工具调用的作用，例如“检查项目依赖是否完整”"
        }
      }
    } as any
  };
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

async function canonicalRoot(projectRoot: string): Promise<string> {
  return realpath(projectRoot);
}

export async function confineExistingPath(projectRoot: string, input: string): Promise<string> {
  const root = await canonicalRoot(projectRoot);
  const unresolved = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const target = await realpath(unresolved);
  if (!isInside(root, target)) throw new Error("拒绝访问项目目录之外的路径");
  return target;
}

export async function confineWritePath(projectRoot: string, input: string): Promise<string> {
  const root = await canonicalRoot(projectRoot);
  const rawRoot = resolve(projectRoot);
  const rawTarget = isAbsolute(input) ? resolve(input) : resolve(rawRoot, input);
  if (!isInside(rawRoot, rawTarget) && !isInside(root, rawTarget)) {
    throw new Error("拒绝写入项目目录之外的路径");
  }
  const unresolved = isInside(rawRoot, rawTarget)
    ? resolve(root, relative(rawRoot, rawTarget))
    : rawTarget;
  if (unresolved === root) return root;
  let parent = dirname(unresolved);
  while (parent !== dirname(parent)) {
    try {
      const canonicalParent = await realpath(parent);
      if (!isInside(root, canonicalParent)) throw new Error("拒绝通过符号链接写出项目目录");
      return unresolved;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("拒绝")) throw error;
      parent = dirname(parent);
    }
  }
  throw new Error("无法确认写入路径边界");
}

async function directorySize(path: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

async function writeWithinQuota(
  projectRoot: string,
  absolutePath: string,
  content: string,
  limitBytes: number
): Promise<void> {
  let oldSize = 0;
  try {
    oldSize = (await stat(absolutePath)).size;
  } catch {
    // New file.
  }
  if (Number.isFinite(limitBytes)) {
    const nextTotal = (await directorySize(projectRoot)) - oldSize + Buffer.byteLength(content);
    if (nextTotal > limitBytes) throw new Error("项目空间已满");
  }
  await writeFile(absolutePath, content);
}

function shellInvocation(projectRoot: string, command: string): {
  executable: string;
  args: string[];
  cwd: string;
} {
  if (process.platform === "linux") {
    const bubblewrap = process.env.BWRAP_PATH ?? "/usr/bin/bwrap";
    return {
      executable: bubblewrap,
      args: linuxSandboxArgs(projectRoot, command),
      cwd: projectRoot
    };
  }
  if (process.platform === "darwin") {
    const escaped = projectRoot.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow network*)",
      `(allow file-read* (subpath "${escaped}") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/opt/homebrew") (subpath "/Library") (subpath "/dev"))`,
      `(allow file-write* (subpath "${escaped}") (subpath "/private/tmp"))`
    ].join("");
    return {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", profile, "/bin/zsh", "-lc", command],
      cwd: projectRoot
    };
  }
  throw new Error("当前系统没有可用的项目命令沙箱");
}

export async function runSandboxedProjectCommand(input: {
  projectRoot: string;
  command: string;
  timeoutSeconds?: number;
  readOnlyPrefixes?: string[];
  onData?: (data: Buffer) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number }> {
  if (requiresInteractiveInput(input.command)) {
    throw new Error("命令需要交互输入");
  }
  if (process.platform === "darwin") {
    throw new Error("当前开发环境的终端沙箱不可用；请使用文件工具继续");
  }
  await mkdir(join(input.projectRoot, ".tmp"), { recursive: true });
  const invocation =
    process.platform === "linux"
      ? {
          executable: process.env.BWRAP_PATH ?? "/usr/bin/bwrap",
          args: linuxSandboxArgs(
            input.projectRoot,
            input.command,
            [],
            input.readOnlyPrefixes ?? []
          ),
          cwd: input.projectRoot
        }
      : shellInvocation(input.projectRoot, input.command);
  return new Promise<{ exitCode: number }>((resolvePromise, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: {
        PATH: input.env?.PATH ?? process.env.PATH,
        LANG: "C.UTF-8"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (data: Buffer) => input.onData?.(data));
    child.stderr.on("data", (data: Buffer) => input.onData?.(data));
    child.once("error", reject);
    let timedOut = false;
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = bashTimeoutMs(input.timeoutSeconds);
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          abort();
        }, timeoutMs)
      : undefined;
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const error = commandCloseError({
        code,
        signal,
        aborted: input.signal?.aborted ?? false,
        timedOut,
        timeoutMs
      });
      if (error) {
        reject(error);
        return;
      }
      resolvePromise({ exitCode: code ?? 1 });
    });
  });
}

export function linuxSandboxArgs(
  projectRoot: string,
  command: string,
  readOnlyBinds: Array<{ source: string; destination: string }> = [],
  readOnlyProjectPaths: string[] = [],
  procMode: "empty" | "mounted" | "bound" = "empty"
): string[] {
  const procArgs =
    procMode === "bound"
      ? ["--ro-bind", "/proc", "/proc"]
      : [procMode === "mounted" ? "--proc" : "--dir", "/proc"];
  return [
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        // An empty proc directory avoids exposing host process data and remains
        // compatible with systemd ProtectKernelLogs/ProtectKernelTunables.
        ...procArgs,
        "--dev",
        "/dev",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind-try",
        "/bin",
        "/bin",
        "--ro-bind-try",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind-try",
        "/etc/ssl",
        "/etc/ssl",
        "--ro-bind-try",
        "/etc/resolv.conf",
        "/etc/resolv.conf",
        "--ro-bind-try",
        "/etc/hosts",
        "/etc/hosts",
        // Chromium relies on fontconfig to discover fallback fonts. Without
        // this bind, CJK text is rendered as tofu even when Noto CJK is
        // installed under /usr/share/fonts.
        "--ro-bind-try",
        "/etc/fonts",
        "/etc/fonts",
        "--bind",
        projectRoot,
        "/project",
        "--bind",
        join(projectRoot, ".tmp"),
        "/tmp",
        ...readOnlyBinds.flatMap(({ source, destination }) => [
          "--ro-bind",
          source,
          destination
        ]),
        ...readOnlyProjectPaths.flatMap((path) => [
          "--ro-bind-try",
          join(projectRoot, path),
          join("/project", path)
        ]),
        "--chdir",
        "/project",
        "--setenv",
        "HOME",
        "/project",
        "--setenv",
        "npm_config_cache",
        "/project/.npm-cache",
        "/bin/sh",
        "-lc",
        command
      ];
}

export function createSafeToolDefinitions(
  projectRoot: string,
  limitBytes = Number.POSITIVE_INFINITY,
  policy: {
    writablePrefixes?: string[];
    readOnlyPrefixes?: string[];
    allowBash?: boolean;
  } = {}
): ToolDefinition<any, any, any>[] {
  const policyRoot = realpathSync(projectRoot);
  const assertWritable = (path: string, allowAncestor = false) => {
    const relativePath = relative(policyRoot, resolve(path)).replaceAll("\\", "/");
    if (
      policy.readOnlyPrefixes?.some(
        (prefix) =>
          relativePath === prefix ||
          relativePath.startsWith(`${prefix}/`) ||
          (allowAncestor && prefix.startsWith(`${relativePath}/`))
      )
    ) {
      throw new Error("当前阶段该路径只读");
    }
    if (policy.writablePrefixes === undefined) return;
    if (
      !policy.writablePrefixes.some(
        (prefix) =>
          relativePath === prefix ||
          relativePath.startsWith(`${prefix}/`) ||
          (allowAncestor &&
            (relativePath === "" || prefix.startsWith(`${relativePath}/`)))
      )
    ) {
      throw new Error("当前阶段只能维护指定文档");
    }
  };
  const readOperations = {
    readFile: async (path: string) => readFile(await confineExistingPath(projectRoot, path)),
    access: async (path: string) => access(await confineExistingPath(projectRoot, path)),
    detectImageMimeType: async (path: string) => {
      const safe = await confineExistingPath(projectRoot, path);
      const lower = safe.toLowerCase();
      if (lower.endsWith(".png")) return "image/png";
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
      return null;
    }
  };
  const writeOperations = {
    mkdir: async (path: string) => {
      const safe = await confineWritePath(projectRoot, path);
      assertWritable(safe, true);
      await mkdir(safe, { recursive: true });
    },
    writeFile: async (path: string, content: string) => {
      const safe = await confineWritePath(projectRoot, path);
      assertWritable(safe);
      await writeWithinQuota(projectRoot, safe, content, limitBytes);
    }
  };
  const editOperations = {
    readFile: readOperations.readFile,
    access: readOperations.access,
    writeFile: writeOperations.writeFile
  };
  const bashOperations = {
    exec: async (
      command: string,
      _cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      }
    ) => {
      return runSandboxedProjectCommand({
        projectRoot,
        command,
        timeoutSeconds: options.timeout,
        readOnlyPrefixes: policy.readOnlyPrefixes,
        onData: options.onData,
        signal: options.signal,
        env: options.env
      });
    }
  };
  const definitions = [
    createReadToolDefinition(projectRoot, { operations: readOperations }),
    createWriteToolDefinition(projectRoot, { operations: writeOperations }),
    createEditToolDefinition(projectRoot, { operations: editOperations }),
    ...(policy.allowBash === false
      ? []
      : [createBashToolDefinition(projectRoot, { operations: bashOperations })])
  ];
  return definitions.map(requireUserDescription);
}
