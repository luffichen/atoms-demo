import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bashTimeoutMs,
  commandCloseError,
  confineExistingPath,
  confineWritePath,
  createSafeToolDefinitions,
  linuxSandboxArgs,
  requiresInteractiveInput
} from "./safe-tools.js";

describe("safe agent tools", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-safe-root-"));
    outside = await mkdtemp(join(tmpdir(), "atoms-safe-outside-"));
    await writeFile(join(root, "inside.txt"), "inside");
    await writeFile(join(outside, "secret.txt"), "secret");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("拒绝绝对路径、相对路径和符号链接越界读取", async () => {
    await expect(confineExistingPath(root, join(outside, "secret.txt"))).rejects.toThrow("拒绝访问");
    await expect(confineExistingPath(root, "../secret.txt")).rejects.toThrow();
    await symlink(outside, join(root, "escape"));
    await expect(confineExistingPath(root, "escape/secret.txt")).rejects.toThrow("拒绝访问");
  });

  it("允许项目内新文件并拒绝越界写入", async () => {
    await mkdir(join(root, "src"));
    const canonical = await realpath(root);
    await expect(confineWritePath(root, root)).resolves.toBe(canonical);
    await expect(confineWritePath(root, "src/app.ts")).resolves.toBe(join(canonical, "src/app.ts"));
    await expect(confineWritePath(root, join(outside, "stolen.txt"))).rejects.toThrow("拒绝写入");
  });

  it("安全定义覆盖 read/write/edit/bash 四个内置工具", () => {
    const definitions = createSafeToolDefinitions(root);
    expect(definitions.map(({ name }) => name).sort()).toEqual([
      "bash",
      "edit",
      "read",
      "write"
    ]);
    for (const definition of definitions) {
      expect((definition.parameters as any).required).toContain("description");
      expect((definition.parameters as any).properties.description).toMatchObject({
        type: "string",
        minLength: 1
      });
    }
  });

  it("允许为精确白名单文件创建父目录但不放宽同目录写权限", async () => {
    const write = createSafeToolDefinitions(root, Number.POSITIVE_INFINITY, {
      writablePrefixes: ["docs/technical", "docs/technical-decisions.md"],
      allowBash: false
    }).find(({ name }) => name === "write");
    expect(write).toBeDefined();

    await (write!.execute as any)(
      "write-allowed",
      {
        path: "docs/technical-decisions.md",
        content: "# Technical decisions"
      },
      undefined,
      undefined,
      undefined
    );
    await expect(readFile(join(root, "docs", "technical-decisions.md"), "utf8")).resolves.toBe(
      "# Technical decisions"
    );

    await expect(
      (write!.execute as any)(
        "write-denied",
        {
          path: "docs/other.md",
          content: "must not be written"
        },
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow("当前阶段只能维护指定文档");
  });

  it("冻结只读前缀，同时允许修改同项目的业务代码", async () => {
    await mkdir(join(root, "docs", "requirements"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "docs", "requirements", "R001.md"), "confirmed");
    await writeFile(join(root, "src", "app.ts"), "old");
    const definitions = createSafeToolDefinitions(root, Number.POSITIVE_INFINITY, {
      readOnlyPrefixes: ["docs/requirements", "docs/technical-decisions.md"]
    });
    const edit = definitions.find(({ name }) => name === "edit");
    const write = definitions.find(({ name }) => name === "write");

    await expect(
      (edit!.execute as any)(
        "edit-frozen",
        {
          path: "docs/requirements/R001.md",
          edits: [{ oldText: "confirmed", newText: "changed" }]
        },
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow("只读");
    await expect(
      (write!.execute as any)(
        "create-frozen",
        {
          path: "docs/technical-decisions.md",
          content: "changed"
        },
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow("只读");
    await (write!.execute as any)(
      "write-code",
      { path: "src/app.ts", content: "new" },
      undefined,
      undefined,
      undefined
    );
    await expect(readFile(join(root, "src", "app.ts"), "utf8")).resolves.toBe("new");
  });

  it("空写入白名单冻结所有文件", async () => {
    const write = createSafeToolDefinitions(root, Number.POSITIVE_INFINITY, {
      writablePrefixes: [],
      allowBash: false
    }).find(({ name }) => name === "write");
    await expect(
      (write!.execute as any)(
        "write-frozen-candidate",
        { path: "inside.txt", content: "changed" },
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow("只能维护指定文档");
  });

  it("需要密码或人工输入的命令会快速拒绝", () => {
    expect(requiresInteractiveInput("sudo apt update")).toBe(true);
    expect(requiresInteractiveInput("echo ok; read answer")).toBe(true);
    expect(requiresInteractiveInput("npm run build")).toBe(false);
  });

  it("不会把超时、中止或信号终止误判为成功", () => {
    expect(bashTimeoutMs()).toBeUndefined();
    expect(bashTimeoutMs(120)).toBe(120_000);
    expect(
      commandCloseError({
        code: null,
        signal: "SIGKILL",
        aborted: false,
        timedOut: false
      })?.message
    ).toContain("SIGKILL");
    expect(
      commandCloseError({
        code: null,
        signal: "SIGTERM",
        aborted: false,
        timedOut: true,
        timeoutMs: 12_500
      })?.message
    ).toBe("timeout:13");
    expect(
      commandCloseError({
        code: null,
        signal: "SIGTERM",
        aborted: true,
        timedOut: false
      })?.message
    ).toBe("aborted");
    expect(
      commandCloseError({
        code: 0,
        signal: null,
        aborted: false,
        timedOut: false
      })
    ).toBeNull();
  });

  it("Linux 沙箱使用空 proc 目录且不暴露宿主 proc", () => {
    const args = linuxSandboxArgs("/workspace/project", "printf ok", [
      { source: "/workspace/project/.tmp/config.mjs", destination: "/project/next.config.mjs" }
    ], ["docs/requirements", "docs/technical"]);
    expect(args).toContain("--dir");
    expect(args).not.toContain("--proc");
    expect(args.slice(args.indexOf("--dir"), args.indexOf("--dir") + 2)).toEqual(["--dir", "/proc"]);
    expect(args).toContain("/workspace/project");
    expect(args).toContain("/project/next.config.mjs");
    expect(args).toContain("--ro-bind-try");
    expect(args).toContain("/etc/fonts");
    expect(args).toContain("/workspace/project/docs/requirements");
    expect(args).toContain("/project/docs/technical");
  });

  it("浏览器沙箱可只读绑定服务可见的 proc", () => {
    const args = linuxSandboxArgs(
      "/workspace/project",
      "chrome --headless",
      [],
      [],
      "bound"
    );
    expect(args).toContain("--ro-bind");
    expect(args).not.toContain("--dir");
    const procIndex = args.findIndex(
      (value, index) =>
        value === "--ro-bind" &&
        args[index + 1] === "/proc" &&
        args[index + 2] === "/proc"
    );
    expect(procIndex).toBeGreaterThanOrEqual(0);
    expect(args.slice(procIndex, procIndex + 3)).toEqual([
      "--ro-bind",
      "/proc",
      "/proc"
    ]);
  });
});
