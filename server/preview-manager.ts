import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import ts from "typescript";
import {
  spawn,
  type ChildProcessByStdio
} from "node:child_process";
import type { Readable } from "node:stream";
import type { AppConfig } from "./config.js";
import type { PreviewStatus } from "./domain/types.js";
import { linuxSandboxArgs } from "./safe-tools.js";

const DEPENDENCY_INSTALL_TIMEOUT_MS = 10 * 60_000;
const RUNTIME_START_TIMEOUT_MS = 60_000;
const MAX_LOG_BYTES = 24 * 1024;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const DEPENDENCY_MARKER = ".tmp/preview-dependencies.sha256";
const NEXT_CONFIG_OVERLAY = ".tmp/preview-next.config.mjs";
const NODE_PORT_HOOK = ".tmp/preview-port-hook.cjs";
const SANDBOX_NODE_PORT_HOOK = "/tmp/preview-port-hook.cjs";

export interface PreviewState {
  projectId: string;
  previewCapable: boolean;
  previewStatus: PreviewStatus;
  previewUrl: string | null;
  previewError: string | null;
}

export type PreviewFramework = "static" | "next" | "vite" | "node";

export interface PreviewSpec {
  framework: PreviewFramework;
  script: "dev" | "preview" | "start" | null;
}

type PreviewRuntime = {
  projectId: string;
  projectRoot: string;
  port: number;
  process: PreviewChild;
  logs: string;
  stopping: boolean;
};
type PreviewChild = ChildProcessByStdio<null, Readable, Readable>;

type StateListener = (state: PreviewState) => void;
type SandboxBind = { source: string; destination: string };

function appendLog(current: string, chunk: Buffer | string): string {
  const next = (current + chunk.toString()).replace(ANSI_ESCAPE, "");
  return Buffer.from(next).subarray(-MAX_LOG_BYTES).toString();
}

function lastMeaningfulLog(logs: string): string {
  const lines = logs
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-8).join("\n") || "预览进程未提供错误信息";
}

async function dependencyFingerprint(projectRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock"
  ]) {
    try {
      hash.update(name);
      hash.update(await readFile(join(projectRoot, name)));
    } catch {
      // Optional lock file.
    }
  }
  return hash.digest("hex");
}

async function dependenciesReady(projectRoot: string, fingerprint: string): Promise<boolean> {
  if (!existsSync(join(projectRoot, "node_modules"))) return false;
  try {
    return (await readFile(join(projectRoot, DEPENDENCY_MARKER), "utf8")).trim() === fingerprint;
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForHttp(port: number, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() >= deadline) {
        reject(new Error("预览启动超时（60 秒）"));
        return;
      }
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/",
          method: "GET",
          timeout: 1_000,
          headers: { connection: "close" }
        },
        (response) => {
          response.resume();
          resolve();
        }
      );
      request.once("timeout", () => request.destroy());
      request.once("error", () => {
        setTimeout(attempt, 250).unref();
      });
      request.end();
    };
    attempt();
  });
}

function exitResult(child: PreviewChild): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function terminate(child: PreviewChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    exitResult(child).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000).unref();
    })
  ]);
}

export function detectPreviewSpec(input: {
  hasIndexHtml: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): PreviewSpec | null {
  if (input.hasIndexHtml) return { framework: "static", script: null };
  const packages = { ...input.dependencies, ...input.devDependencies };
  const script = input.scripts?.preview
    ? "preview"
    : input.scripts?.dev
      ? "dev"
      : input.scripts?.start
        ? "start"
        : null;
  if (!script) return null;
  if (packages.next) return { framework: "next", script };
  if (packages.vite) return { framework: "vite", script };
  return { framework: "node", script };
}

export function previewStartCommand(spec: PreviewSpec, port: number): string {
  if (!spec.script) throw new Error("静态预览不需要启动命令");
  if (spec.framework === "next" && spec.script === "dev") {
    return `npm run dev -- --hostname 127.0.0.1 --port ${port}`;
  }
  if (spec.framework === "vite") {
    return `npm run ${spec.script} -- --host 127.0.0.1 --port ${port}`;
  }
  return `env ATOMS_PREVIEW_PORT=${port} HOST=127.0.0.1 HOSTNAME=127.0.0.1 PORT=${port} npm run ${spec.script}`;
}

export async function createNodePortHook(projectRoot: string): Promise<string> {
  const hook = join(projectRoot, NODE_PORT_HOOK);
  await writeFile(
    hook,
    [
      '"use strict";',
      'const net = require("node:net");',
      "const originalListen = net.Server.prototype.listen;",
      "net.Server.prototype.listen = function (...args) {",
      "  const forcedPort = Number(process.env.ATOMS_PREVIEW_PORT);",
      "  if (!Number.isInteger(forcedPort) || forcedPort <= 0) {",
      "    return originalListen.apply(this, args);",
      "  }",
      '  if (typeof args[0] === "number") {',
      "    args[0] = forcedPort;",
      '    if (typeof args[1] === "string") args[1] = "127.0.0.1";',
      '  } else if (args[0] && typeof args[0] === "object" && "port" in args[0]) {',
      '    args[0] = { ...args[0], port: forcedPort, host: "127.0.0.1" };',
      "  }",
      "  return originalListen.apply(this, args);",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );
  return hook;
}

export async function createNextConfigOverlay(projectRoot: string): Promise<SandboxBind[]> {
  if (
    !existsSync(join(projectRoot, "next.config.ts")) ||
    existsSync(join(projectRoot, "next.config.js")) ||
    existsSync(join(projectRoot, "next.config.mjs"))
  ) {
    return [];
  }
  const source = await readFile(join(projectRoot, "next.config.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: "next.config.ts",
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const overlay = join(projectRoot, NEXT_CONFIG_OVERLAY);
  await writeFile(overlay, compiled, "utf8");
  return [{ source: overlay, destination: "/project/next.config.mjs" }];
}

export class PreviewManager {
  private readonly runtimes = new Map<string, PreviewRuntime>();
  private readonly listeners = new Set<StateListener>();
  private readonly operations = new Map<string, Promise<PreviewState>>();

  constructor(private readonly config: AppConfig) {}

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(state: PreviewState): PreviewState {
    for (const listener of this.listeners) listener(state);
    return state;
  }

  private dynamicUrl(projectId: string): string {
    const protocol = this.config.isProduction ? "https" : "http";
    const port = this.config.isProduction || this.config.port === 80 || this.config.port === 443
      ? ""
      : `:${this.config.port}`;
    return `${protocol}://p-${projectId}.${this.config.publicDomain}${port}/`;
  }

  projectIdFromHostname(hostname: string): string | null {
    const normalized = hostname.toLowerCase().replace(/\.$/u, "");
    const suffix = `.${this.config.publicDomain.toLowerCase()}`;
    if (!normalized.endsWith(suffix)) return null;
    const label = normalized.slice(0, -suffix.length);
    const match = /^p-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(
      label
    );
    return match?.[1] ?? null;
  }

  target(projectId: string): { hostname: "127.0.0.1"; port: number } | null {
    const runtime = this.runtimes.get(projectId);
    return runtime && !runtime.stopping
      ? { hostname: "127.0.0.1", port: runtime.port }
      : null;
  }

  hasRuntime(projectId: string): boolean {
    return Boolean(this.target(projectId));
  }

  async inspect(projectRoot: string): Promise<PreviewSpec | null> {
    const hasIndexHtml = existsSync(join(projectRoot, "index.html"));
    if (hasIndexHtml) return detectPreviewSpec({ hasIndexHtml });
    try {
      const parsed = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return detectPreviewSpec({ hasIndexHtml, ...parsed });
    } catch {
      return null;
    }
  }

  refresh(projectId: string, projectRoot: string): Promise<PreviewState> {
    const current = this.operations.get(projectId);
    if (current) return current;
    const operation = this.refreshUnlocked(projectId, projectRoot).finally(() => {
      if (this.operations.get(projectId) === operation) this.operations.delete(projectId);
    });
    this.operations.set(projectId, operation);
    return operation;
  }

  private async refreshUnlocked(projectId: string, projectRoot: string): Promise<PreviewState> {
    const spec = await this.inspect(projectRoot);
    if (!spec) {
      await this.stopRuntime(projectId);
      return this.publish({
        projectId,
        previewCapable: false,
        previewStatus: "none",
        previewUrl: null,
        previewError: null
      });
    }
    if (spec.framework === "static") {
      await this.stopRuntime(projectId);
      return this.publish({
        projectId,
        previewCapable: true,
        previewStatus: "ready",
        previewUrl: `/preview/${projectId}/`,
        previewError: null
      });
    }

    await this.stopRuntime(projectId);
    this.publish({
      projectId,
      previewCapable: true,
      previewStatus: "starting",
      previewUrl: null,
      previewError: null
    });
    try {
      if (process.platform !== "linux") {
        throw new Error("当前开发环境不支持隔离的框架预览");
      }
      await mkdir(join(projectRoot, ".tmp"), { recursive: true });
      const fingerprint = await dependencyFingerprint(projectRoot);
      if (!(await dependenciesReady(projectRoot, fingerprint))) {
        await this.installDependencies(
          projectRoot,
          Date.now() + DEPENDENCY_INSTALL_TIMEOUT_MS
        );
        await writeFile(join(projectRoot, DEPENDENCY_MARKER), `${fingerprint}\n`, "utf8");
      }
      const port = await availablePort();
      if (spec.framework === "node") await createNodePortHook(projectRoot);
      const binds = spec.framework === "next"
        ? await createNextConfigOverlay(projectRoot)
        : [];
      const runtime = this.spawnRuntime(
        projectId,
        projectRoot,
        port,
        previewStartCommand(spec, port),
        binds,
        spec.framework === "node"
      );
      this.runtimes.set(projectId, runtime);
      const earlyExit = exitResult(runtime.process).then((code) => {
        throw new Error(`预览进程提前退出（退出码 ${code ?? "未知"}）\n${lastMeaningfulLog(runtime.logs)}`);
      });
      await Promise.race([
        waitForHttp(port, Date.now() + RUNTIME_START_TIMEOUT_MS),
        earlyExit
      ]);
      if (this.runtimes.get(projectId) !== runtime) throw new Error("预览启动已取消");
      runtime.process.once("exit", (code, signal) => {
        if (runtime.stopping || this.runtimes.get(projectId) !== runtime) return;
        this.runtimes.delete(projectId);
        this.publish({
          projectId,
          previewCapable: true,
          previewStatus: "failed",
          previewUrl: null,
          previewError: `预览进程已退出（${signal ?? code ?? "未知原因"}）\n${lastMeaningfulLog(runtime.logs)}`
        });
      });
      return this.publish({
        projectId,
        previewCapable: true,
        previewStatus: "ready",
        previewUrl: this.dynamicUrl(projectId),
        previewError: null
      });
    } catch (error) {
      await this.stopRuntime(projectId);
      return this.publish({
        projectId,
        previewCapable: true,
        previewStatus: "failed",
        previewUrl: null,
        previewError: error instanceof Error ? error.message : "预览启动失败"
      });
    }
  }

  private spawnSandboxed(
    projectRoot: string,
    command: string,
    readOnlyBinds: SandboxBind[] = [],
    forceNodePort = false
  ): PreviewChild {
    const bubblewrap = process.env.BWRAP_PATH ?? "/usr/bin/bwrap";
    // V8 reserves a large virtual address range, so RLIMIT_AS causes false OOMs
    // even when physical memory is available. Bound the JavaScript heap instead.
    const nodeOptions = forceNodePort
      ? `--max-old-space-size=768 --require=${SANDBOX_NODE_PORT_HOOK}`
      : "--max-old-space-size=768";
    const limitedCommand =
      `ulimit -n 1024; export NODE_OPTIONS='${nodeOptions}'; exec ${command}`;
    return spawn(bubblewrap, linuxSandboxArgs(projectRoot, limitedCommand, readOnlyBinds), {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  private async installDependencies(projectRoot: string, deadline: number): Promise<void> {
    const child = this.spawnSandboxed(
      projectRoot,
      "npm install --no-audit --no-fund --no-package-lock"
    );
    let logs = "";
    child.stdout.on("data", (chunk) => {
      logs = appendLog(logs, chunk);
    });
    child.stderr.on("data", (chunk) => {
      logs = appendLog(logs, chunk);
    });
    const remaining = Math.max(1, deadline - Date.now());
    let timer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        exitResult(child),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`依赖安装超时\n${lastMeaningfulLog(logs)}`)),
            remaining
          );
          timer.unref();
        })
      ]);
      if (code !== 0) {
        throw new Error(`依赖安装失败（退出码 ${code ?? "未知"}）\n${lastMeaningfulLog(logs)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      await terminate(child);
    }
  }

  private spawnRuntime(
    projectId: string,
    projectRoot: string,
    port: number,
    command: string,
    readOnlyBinds: SandboxBind[],
    forceNodePort: boolean
  ): PreviewRuntime {
    const process = this.spawnSandboxed(
      projectRoot,
      command,
      readOnlyBinds,
      forceNodePort
    );
    const runtime: PreviewRuntime = {
      projectId,
      projectRoot,
      port,
      process,
      logs: "",
      stopping: false
    };
    process.stdout.on("data", (chunk) => {
      runtime.logs = appendLog(runtime.logs, chunk);
    });
    process.stderr.on("data", (chunk) => {
      runtime.logs = appendLog(runtime.logs, chunk);
    });
    return runtime;
  }

  async stop(projectId: string, capable = true): Promise<PreviewState> {
    await this.stopRuntime(projectId);
    return this.publish({
      projectId,
      previewCapable: capable,
      previewStatus: capable ? "stopped" : "none",
      previewUrl: null,
      previewError: null
    });
  }

  private async stopRuntime(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(projectId);
    await terminate(runtime.process);
  }

  async close(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((projectId) => this.stopRuntime(projectId)));
    this.listeners.clear();
  }
}
