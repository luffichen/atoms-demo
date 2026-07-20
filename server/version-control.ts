import { execFile } from "node:child_process";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { FileTreeNode, FileView } from "./files.js";

const execFileAsync = promisify(execFile);
const MAX_BINARY_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const BINARY_EXTENSIONS = new Set([
  ".zip", ".gz", ".pdf", ".woff", ".woff2", ".ttf", ".ico", ".mp3", ".mp4", ".mov"
]);
const PLATFORM_EXCLUDES = [
  ".git",
  ".pi",
  ".agents",
  ".codex",
  ".tmp",
  ".npm-cache",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "*.log",
  ".env",
  ".env.*",
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.pid"
];
const SAFE_ADD_PATHS = [
  ":/",
  ...[
    "**/.git/**",
    "**/.pi/**",
    "**/.agents/**",
    "**/.codex/**",
    "**/.tmp/**",
    "**/.npm-cache/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/*.log",
    "**/.env",
    "**/.env.*",
    "**/*.sqlite",
    "**/*.sqlite3",
    "**/*.db",
    "**/*.pid"
  ].map((pattern) => `:(exclude,glob)${pattern}`)
];
const EXCLUDED_NAMES = new Set([
  ".pi",
  ".agents",
  ".codex",
  ".tmp",
  ".npm-cache",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage"
]);

export class VersionControlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VersionControlError";
  }
}

async function git(
  repositoryRoot: string,
  projectRoot: string,
  args: string[]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--git-dir", repositoryRoot, "--work-tree", projectRoot, ...args],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Atoms",
          GIT_AUTHOR_EMAIL: "versions@atoms.local",
          GIT_COMMITTER_NAME: "Atoms",
          GIT_COMMITTER_EMAIL: "versions@atoms.local"
        }
      }
    );
    return stdout.trim();
  } catch (error) {
    const message =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : error instanceof Error
          ? error.message
          : "Git 操作失败";
    throw new VersionControlError("git_failed", message || "Git 操作失败");
  }
}

async function gitRefExists(
  repositoryRoot: string,
  projectRoot: string,
  ref: string
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["--git-dir", repositoryRoot, "--work-tree", projectRoot, "show-ref", "--verify", "--quiet", ref],
      { cwd: projectRoot }
    );
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === 1 || error.code === 128)
    ) {
      return false;
    }
    throw error;
  }
}

function safeRef(ref: string): string {
  if (!/^refs\/(?:heads\/work\/[a-f0-9-]+|heads\/main|tags\/code\/v[1-9][0-9]*)$/u.test(ref)) {
    throw new VersionControlError("invalid_ref", "版本引用无效");
  }
  return ref;
}

function safeCommitOrRef(value: string): string {
  if (/^[a-f0-9]{40,64}$/u.test(value)) return value;
  return safeRef(value);
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new VersionControlError("invalid_path", "文件路径无效");
  }
  return normalized;
}

async function writePlatformExcludes(repositoryRoot: string): Promise<void> {
  const excludePath = join(repositoryRoot, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${PLATFORM_EXCLUDES.join("\n")}\n`, "utf8");
}

function isPlatformExcluded(name: string): boolean {
  return (
    EXCLUDED_NAMES.has(name) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(?:log|sqlite|sqlite3|db|pid)$/iu.test(name)
  );
}

function isPlatformExcludedPath(path: string): boolean {
  return path.split("/").some(isPlatformExcluded);
}

async function isBinaryFile(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
    } catch {
      return true;
    }
    let controlBytes = 0;
    for (const byte of sample) {
      if (byte < 9 || (byte > 13 && byte < 32)) controlBytes += 1;
    }
    return sample.length > 0 && controlBytes / sample.length > 0.1;
  } finally {
    await handle.close();
  }
}

export class VersionControl {
  async initialize(repositoryRoot: string, projectRoot: string): Promise<string> {
    await mkdir(projectRoot, { recursive: true });
    await this.assertVersionable(projectRoot);
    await mkdir(dirname(repositoryRoot), { recursive: true });
    await execFileAsync("git", ["init", "--bare", repositoryRoot], { encoding: "utf8" });
    await git(repositoryRoot, projectRoot, ["config", "core.bare", "false"]);
    await git(repositoryRoot, projectRoot, ["config", "core.worktree", projectRoot]);
    await git(repositoryRoot, projectRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await writePlatformExcludes(repositoryRoot);
    await git(repositoryRoot, projectRoot, ["add", "--all", "--", ...SAFE_ADD_PATHS]);
    await this.assertNoExcludedIndexFiles(repositoryRoot, projectRoot);
    await git(repositoryRoot, projectRoot, ["commit", "--allow-empty", "-m", "Initialize project"]);
    return git(repositoryRoot, projectRoot, ["rev-parse", "HEAD"]);
  }

  async createWorkBranch(
    repositoryRoot: string,
    projectRoot: string,
    branchRef: string,
    baseCommit?: string
  ): Promise<string> {
    safeRef(branchRef);
    const base = baseCommit || (await git(repositoryRoot, projectRoot, ["rev-parse", "refs/heads/main"]));
    await git(repositoryRoot, projectRoot, ["update-ref", branchRef, base]);
    await git(repositoryRoot, projectRoot, ["symbolic-ref", "HEAD", branchRef]);
    await git(repositoryRoot, projectRoot, ["read-tree", "--reset", "-u", branchRef]);
    return base;
  }

  async checkpoint(
    repositoryRoot: string,
    projectRoot: string,
    branchRef: string,
    message: string
  ): Promise<{ commitSha: string; changed: boolean }> {
    safeRef(branchRef);
    await writePlatformExcludes(repositoryRoot);
    await this.assertVersionable(projectRoot);
    await this.assertNoGitlinks(repositoryRoot, projectRoot, branchRef);
    await git(repositoryRoot, projectRoot, ["symbolic-ref", "HEAD", branchRef]);
    await git(repositoryRoot, projectRoot, ["add", "--all", "--", ...SAFE_ADD_PATHS]);
    await this.assertNoExcludedTrackedFiles(repositoryRoot, projectRoot, branchRef);
    const staged = await git(repositoryRoot, projectRoot, ["diff", "--cached", "--name-only"]);
    if (!staged) {
      return {
        commitSha: await git(repositoryRoot, projectRoot, ["rev-parse", branchRef]),
        changed: false
      };
    }
    await git(repositoryRoot, projectRoot, ["commit", "-m", message]);
    return {
      commitSha: await git(repositoryRoot, projectRoot, ["rev-parse", "HEAD"]),
      changed: true
    };
  }

  async publish(
    repositoryRoot: string,
    projectRoot: string,
    branchRef: string,
    sequence: number,
    title: string
  ): Promise<{
    commitSha: string;
    tagRef: string;
    previousMain: string;
    branchCommit: string;
  }> {
    safeRef(branchRef);
    await writePlatformExcludes(repositoryRoot);
    await this.assertVersionable(projectRoot);
    await this.assertNoGitlinks(repositoryRoot, projectRoot, branchRef);
    await this.assertNoExcludedTrackedFiles(repositoryRoot, projectRoot, branchRef);
    const tagRef = safeRef(`refs/tags/code/v${sequence}`);
    if (await gitRefExists(repositoryRoot, projectRoot, tagRef)) {
      throw new VersionControlError("tag_exists", `正式版本标签已存在：code/v${sequence}`);
    }
    const previousMain = await git(repositoryRoot, projectRoot, ["rev-parse", "refs/heads/main"]);
    const branchCommit = await git(repositoryRoot, projectRoot, ["rev-parse", branchRef]);
    let tagCreated = false;
    try {
      await git(repositoryRoot, projectRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      await git(repositoryRoot, projectRoot, ["read-tree", "--reset", "-u", "refs/heads/main"]);
      await git(repositoryRoot, projectRoot, [
        "merge",
        "--no-ff",
        branchRef,
        "-m",
        `Publish V${sequence}: ${title}`
      ]);
      const commitSha = await git(repositoryRoot, projectRoot, ["rev-parse", "HEAD"]);
      await git(repositoryRoot, projectRoot, [
        "tag",
        "-a",
        `code/v${sequence}`,
        "-m",
        `V${sequence}: ${title}`,
        commitSha
      ]);
      tagCreated = true;
      await git(repositoryRoot, projectRoot, ["update-ref", "-d", branchRef]);
      return { commitSha, tagRef, previousMain, branchCommit };
    } catch (error) {
      try {
        if (tagCreated) await git(repositoryRoot, projectRoot, ["update-ref", "-d", tagRef]);
        await git(repositoryRoot, projectRoot, ["update-ref", "refs/heads/main", previousMain]);
        await git(repositoryRoot, projectRoot, ["update-ref", branchRef, branchCommit]);
        await git(repositoryRoot, projectRoot, ["symbolic-ref", "HEAD", branchRef]);
        await git(repositoryRoot, projectRoot, ["read-tree", "--reset", "-u", branchRef]);
      } catch (rollbackError) {
        throw new VersionControlError(
          "publish_rollback_failed",
          `发布失败且回滚未完成：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
      throw error;
    }
  }

  async rollbackPublish(
    repositoryRoot: string,
    projectRoot: string,
    branchRef: string,
    tagRef: string,
    previousMain: string,
    branchCommit: string
  ): Promise<void> {
    safeRef(branchRef);
    safeRef(tagRef);
    await git(repositoryRoot, projectRoot, ["update-ref", "-d", tagRef]);
    await git(repositoryRoot, projectRoot, ["update-ref", "refs/heads/main", previousMain]);
    await git(repositoryRoot, projectRoot, ["update-ref", branchRef, branchCommit]);
    await git(repositoryRoot, projectRoot, ["symbolic-ref", "HEAD", branchRef]);
    await git(repositoryRoot, projectRoot, ["read-tree", "--reset", "-u", branchRef]);
  }

  async abandon(
    repositoryRoot: string,
    projectRoot: string,
    branchRef: string,
    preserveBranch: boolean
  ): Promise<void> {
    safeRef(branchRef);
    await git(repositoryRoot, projectRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(repositoryRoot, projectRoot, ["read-tree", "--reset", "-u", "refs/heads/main"]);
    await git(repositoryRoot, projectRoot, ["clean", "-fd"]);
    if (!preserveBranch) await git(repositoryRoot, projectRoot, ["update-ref", "-d", branchRef]);
  }

  async currentMain(repositoryRoot: string, projectRoot: string): Promise<string> {
    return git(repositoryRoot, projectRoot, ["rev-parse", "refs/heads/main"]);
  }

  async resolveRef(
    repositoryRoot: string,
    projectRoot: string,
    ref: string
  ): Promise<string> {
    safeRef(ref);
    return git(repositoryRoot, projectRoot, ["rev-parse", ref]);
  }

  async listTree(
    repositoryRoot: string,
    projectRoot: string,
    commitSha: string
  ): Promise<FileTreeNode[]> {
    if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) {
      throw new VersionControlError("invalid_commit", "代码版本无效");
    }
    const output = await git(repositoryRoot, projectRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      commitSha
    ]);
    const root: FileTreeNode[] = [];
    for (const rawPath of output.split("\n").filter(Boolean)) {
      const path = safeRelativePath(rawPath);
      const parts = path.split("/");
      let nodes = root;
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index];
        const currentPath = parts.slice(0, index + 1).join("/");
        const file = index === parts.length - 1;
        let node = nodes.find((candidate) => candidate.name === name);
        if (!node) {
          node = file
            ? { name, path: currentPath, type: "file" }
            : { name, path: currentPath, type: "directory", children: [] };
          nodes.push(node);
        }
        if (!file) nodes = node.children ?? (node.children = []);
      }
    }
    return root;
  }

  async readFileAt(
    repositoryRoot: string,
    projectRoot: string,
    commitSha: string,
    requestedPath: string
  ): Promise<FileView> {
    if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) {
      throw new VersionControlError("invalid_commit", "代码版本无效");
    }
    const path = safeRelativePath(requestedPath);
    const buffer = Buffer.from(
      await execFileAsync(
        "git",
        ["--git-dir", repositoryRoot, "show", `${commitSha}:${path}`],
        { encoding: null, maxBuffer: 12 * 1024 * 1024 }
      ).then(({ stdout }) => stdout)
    );
    const common = { name: path.split("/").at(-1) ?? path, path, size: buffer.byteLength };
    const extension = extname(path).toLowerCase();
    if (extension === ".png" || extension === ".jpg" || extension === ".jpeg") {
      return {
        kind: "image",
        ...common,
        mimeType: extension === ".png" ? "image/png" : "image/jpeg",
        data: buffer.toString("base64")
      };
    }
    if (BINARY_EXTENSIONS.has(extension) || buffer.includes(0)) {
      return { kind: "binary", ...common, mimeType: "application/octet-stream", message: "无法预览" };
    }
    if (buffer.byteLength > 1024 * 1024) {
      return { kind: "large", ...common, message: "文件过大，无法预览" };
    }
    return { kind: "text", ...common, content: buffer.toString("utf8"), language: "text" };
  }

  async diff(
    repositoryRoot: string,
    projectRoot: string,
    baseCommit: string,
    commitSha: string,
    path?: string
  ): Promise<string> {
    const args = ["diff", "--find-renames", "--stat", "--patch", baseCommit, commitSha];
    if (path) args.push("--", safeRelativePath(path));
    const output = await git(repositoryRoot, projectRoot, args);
    if (Buffer.byteLength(output) > 1024 * 1024 || output.split("\n").length > 5000) {
      return `${output.split("\n").slice(0, 5000).join("\n")}\n\n[Diff 已截断]`;
    }
    return output;
  }

  async changedFiles(
    repositoryRoot: string,
    projectRoot: string,
    baseCommit: string,
    commitSha: string
  ): Promise<Array<{
    status: "added" | "modified" | "deleted" | "renamed";
    path: string;
    previousPath?: string;
  }>> {
    safeCommitOrRef(baseCommit);
    safeCommitOrRef(commitSha);
    const output = await git(repositoryRoot, projectRoot, [
      "diff",
      "--name-status",
      "--find-renames",
      baseCommit,
      commitSha
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [rawStatus, first, second] = line.split("\t");
        if (rawStatus.startsWith("R")) {
          return {
            status: "renamed" as const,
            previousPath: safeRelativePath(first),
            path: safeRelativePath(second)
          };
        }
        const status = rawStatus === "A"
          ? "added"
          : rawStatus === "D"
            ? "deleted"
            : "modified";
        return { status, path: safeRelativePath(first) };
      });
  }

  async workingChanges(
    repositoryRoot: string,
    projectRoot: string,
    baseCommit: string
  ): Promise<Array<{
    status: "added" | "modified" | "deleted" | "renamed";
    path: string;
    previousPath?: string;
  }>> {
    safeCommitOrRef(baseCommit);
    const [trackedOutput, untrackedOutput] = await Promise.all([
      git(repositoryRoot, projectRoot, [
        "diff",
        "--name-status",
        "--find-renames",
        baseCommit
      ]),
      git(repositoryRoot, projectRoot, [
        "ls-files",
        "--others",
        "--exclude-standard"
      ])
    ]);
    const changes = trackedOutput
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [rawStatus, first, second] = line.split("\t");
        if (rawStatus.startsWith("R")) {
          return {
            status: "renamed" as const,
            previousPath: safeRelativePath(first),
            path: safeRelativePath(second)
          };
        }
        return {
          status:
            rawStatus === "A"
              ? "added" as const
              : rawStatus === "D"
                ? "deleted" as const
                : "modified" as const,
          path: safeRelativePath(first)
        };
      });
    const knownPaths = new Set(changes.map(({ path }) => path));
    for (const path of untrackedOutput.split("\n").filter(Boolean)) {
      const safePath = safeRelativePath(path);
      if (!knownPaths.has(safePath)) changes.push({ status: "added", path: safePath });
    }
    return changes;
  }

  async listPaths(
    repositoryRoot: string,
    projectRoot: string,
    commitSha: string
  ): Promise<string[]> {
    safeRef(commitSha);
    const output = await git(repositoryRoot, projectRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      commitSha
    ]);
    return output.split("\n").filter(Boolean).map(safeRelativePath);
  }

  private async assertVersionable(projectRoot: string): Promise<void> {
    const root = await realpath(projectRoot);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const path = relative(projectRoot, absolute);
        if (entry.name === ".gitmodules") {
          throw new VersionControlError("gitmodules_forbidden", `不允许 Git 子模块配置：${path}`);
        }
        if (entry.name === ".git") {
          throw new VersionControlError("nested_git_forbidden", `不允许嵌套 Git 元数据：${path}`);
        }
        if (isPlatformExcluded(entry.name)) continue;
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) {
          let target: string;
          try {
            target = await realpath(absolute);
          } catch {
            throw new VersionControlError("unsafe_symlink", `符号链接目标无效：${path}`);
          }
          if (target !== root && !target.startsWith(root + sep)) {
            throw new VersionControlError("unsafe_symlink", `符号链接超出项目：${path}`);
          }
          continue;
        }
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) {
          throw new VersionControlError("special_file_forbidden", `不允许设备、Socket 或其他特殊文件：${path}`);
        }
        if (
          metadata.size > MAX_BINARY_BYTES &&
          (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase()) ||
            await isBinaryFile(absolute))
        ) {
          throw new VersionControlError("binary_too_large", `二进制文件超过 10 MB：${path}`);
        }
      }
    };
    await walk(projectRoot);
  }

  private async assertNoExcludedTrackedFiles(
    repositoryRoot: string,
    projectRoot: string,
    ref: string
  ): Promise<void> {
    const output = await git(repositoryRoot, projectRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      ref
    ]);
    const unsafe = output.split("\n").find((path) => path && isPlatformExcludedPath(path));
    if (unsafe) {
      throw new VersionControlError(
        "platform_file_tracked",
        `版本中包含平台强制排除文件：${unsafe}`
      );
    }
  }

  private async assertNoExcludedIndexFiles(
    repositoryRoot: string,
    projectRoot: string
  ): Promise<void> {
    const output = await git(repositoryRoot, projectRoot, ["ls-files"]);
    const unsafe = output.split("\n").find((path) => path && isPlatformExcludedPath(path));
    if (unsafe) {
      throw new VersionControlError(
        "platform_file_tracked",
        `版本中包含平台强制排除文件：${unsafe}`
      );
    }
  }

  private async assertNoGitlinks(
    repositoryRoot: string,
    projectRoot: string,
    ref: string
  ): Promise<void> {
    const output = await git(repositoryRoot, projectRoot, ["ls-tree", "-r", safeRef(ref)]);
    const gitlink = output.split("\n").find((line) => line.startsWith("160000 "));
    if (gitlink) {
      const path = gitlink.split("\t", 2)[1] ?? "unknown";
      throw new VersionControlError("submodule_forbidden", `不允许 Git submodule：${path}`);
    }
  }
}
