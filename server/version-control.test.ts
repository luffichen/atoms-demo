import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VersionControl, VersionControlError } from "./version-control.js";

describe("VersionControl", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("按项目初始化、隔离工作分支并发布不可变的 V1/V2", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-control-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    const versions = new VersionControl();
    const initial = await versions.initialize(repositoryRoot, projectRoot);

    const firstBranch = "refs/heads/work/11111111-1111-1111-1111-111111111111";
    await versions.createWorkBranch(repositoryRoot, projectRoot, firstBranch, initial);
    await writeFile(join(projectRoot, "app.txt"), "V1\n");
    expect(await versions.checkpoint(repositoryRoot, projectRoot, firstBranch, "Build V1"))
      .toMatchObject({ changed: true });
    const v1 = await versions.publish(repositoryRoot, projectRoot, firstBranch, 1, "首版");
    expect(v1.tagRef).toBe("refs/tags/code/v1");
    expect(await versions.readFileAt(repositoryRoot, projectRoot, v1.commitSha, "app.txt"))
      .toMatchObject({ kind: "text", content: "V1\n" });

    const secondBranch = "refs/heads/work/22222222-2222-2222-2222-222222222222";
    await versions.createWorkBranch(repositoryRoot, projectRoot, secondBranch, v1.commitSha);
    await writeFile(join(projectRoot, "app.txt"), "V2\n");
    await versions.checkpoint(repositoryRoot, projectRoot, secondBranch, "Build V2");
    const v2 = await versions.publish(repositoryRoot, projectRoot, secondBranch, 2, "第二版");

    expect(await versions.readFileAt(repositoryRoot, projectRoot, v1.commitSha, "app.txt"))
      .toMatchObject({ kind: "text", content: "V1\n" });
    expect(await versions.readFileAt(repositoryRoot, projectRoot, v2.commitSha, "app.txt"))
      .toMatchObject({ kind: "text", content: "V2\n" });
    expect(await readFile(join(projectRoot, "app.txt"), "utf8")).toBe("V2\n");
    expect(await versions.diff(repositoryRoot, projectRoot, v1.commitSha, v2.commitSha))
      .toContain("+V2");
  });

  it("直接编码放弃时删除临时分支并恢复主线文件", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-abandon-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    const versions = new VersionControl();
    const initial = await versions.initialize(repositoryRoot, projectRoot);
    const branch = "refs/heads/work/33333333-3333-3333-3333-333333333333";
    await versions.createWorkBranch(repositoryRoot, projectRoot, branch, initial);
    await writeFile(join(projectRoot, "temporary.txt"), "discard me");

    await versions.abandon(repositoryRoot, projectRoot, branch, false);

    await expect(readFile(join(projectRoot, "temporary.txt"), "utf8")).rejects.toThrow();
    expect(await versions.currentMain(repositoryRoot, projectRoot)).toBe(initial);
  });

  it("相对工作项正式基线累计计算多轮和未提交文件变化", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-working-changes-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "existing.txt"), "baseline\n");
    const versions = new VersionControl();
    const initial = await versions.initialize(repositoryRoot, projectRoot);
    const branch = "refs/heads/work/77777777-7777-7777-7777-777777777777";
    await versions.createWorkBranch(repositoryRoot, projectRoot, branch, initial);
    await writeFile(join(projectRoot, "first.txt"), "first round\n");
    await versions.checkpoint(repositoryRoot, projectRoot, branch, "first round");
    await writeFile(join(projectRoot, "second.txt"), "second round\n");
    await writeFile(join(projectRoot, "existing.txt"), "updated\n");

    await expect(
      versions.workingChanges(repositoryRoot, projectRoot, initial)
    ).resolves.toEqual(
      expect.arrayContaining([
        { status: "modified", path: "existing.txt" },
        { status: "added", path: "first.txt" },
        { status: "added", path: "second.txt" }
      ])
    );
  });

  it("平台排除规则不能被项目 .gitignore 反向包含", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-excludes-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, ".gitignore"), "!.env\n!debug.log\n");
    await writeFile(join(projectRoot, ".env"), "SECRET=value\n");
    await writeFile(join(projectRoot, "debug.log"), "runtime\n");
    await writeFile(join(projectRoot, "app.txt"), "safe\n");
    const versions = new VersionControl();

    const commit = await versions.initialize(repositoryRoot, projectRoot);
    expect(await versions.listTree(repositoryRoot, projectRoot, commit)).toEqual([
      { name: ".gitignore", path: ".gitignore", type: "file" },
      { name: "app.txt", path: "app.txt", type: "file" }
    ]);
  });

  it("拒绝 .gitmodules 和嵌套 Git 元数据", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-git-boundary-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, ".gitmodules"), "[submodule \"unsafe\"]\n");
    const versions = new VersionControl();

    await expect(versions.initialize(repositoryRoot, projectRoot)).rejects.toMatchObject({
      code: "gitmodules_forbidden"
    } satisfies Partial<VersionControlError>);

    await rm(join(projectRoot, ".gitmodules"));
    await mkdir(join(projectRoot, "vendor", ".git"), { recursive: true });
    await expect(versions.initialize(repositoryRoot, projectRoot)).rejects.toMatchObject({
      code: "nested_git_forbidden"
    } satisfies Partial<VersionControlError>);
  });

  it("发布前拒绝分支中已有的 submodule gitlink", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-gitlink-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    const versions = new VersionControl();
    const initial = await versions.initialize(repositoryRoot, projectRoot);
    const branch = "refs/heads/work/55555555-5555-5555-5555-555555555555";
    await versions.createWorkBranch(repositoryRoot, projectRoot, branch, initial);
    const gitArgs = ["--git-dir", repositoryRoot, "--work-tree", projectRoot];
    execFileSync("git", [
      ...gitArgs,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${initial},vendor/module`
    ]);
    execFileSync("git", [...gitArgs, "commit", "-m", "inject gitlink"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com"
      }
    });

    await expect(
      versions.publish(repositoryRoot, projectRoot, branch, 1, "unsafe")
    ).rejects.toMatchObject({ code: "submodule_forbidden" } satisfies Partial<VersionControlError>);
  });

  it("正式 tag 冲突在合并前失败且不改变 main 或工作分支", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-tag-conflict-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    const versions = new VersionControl();
    const initial = await versions.initialize(repositoryRoot, projectRoot);
    const branch = "refs/heads/work/66666666-6666-6666-6666-666666666666";
    await versions.createWorkBranch(repositoryRoot, projectRoot, branch, initial);
    await writeFile(join(projectRoot, "candidate.txt"), "candidate\n");
    const candidate = await versions.checkpoint(
      repositoryRoot,
      projectRoot,
      branch,
      "candidate"
    );
    execFileSync(
      "git",
      [
        "--git-dir",
        repositoryRoot,
        "--work-tree",
        projectRoot,
        "tag",
        "-a",
        "code/v1",
        "-m",
        "occupied",
        initial
      ],
      {
        env: {
          ...process.env,
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com"
        }
      }
    );

    await expect(
      versions.publish(repositoryRoot, projectRoot, branch, 1, "conflict")
    ).rejects.toMatchObject({ code: "tag_exists" } satisfies Partial<VersionControlError>);
    expect(await versions.currentMain(repositoryRoot, projectRoot)).toBe(initial);
    expect(
      await versions.readFileAt(
        repositoryRoot,
        projectRoot,
        candidate.commitSha,
        "candidate.txt"
      )
    ).toMatchObject({ kind: "text", content: "candidate\n" });
  });

  it("拒绝任意扩展名的超限二进制文件", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-binary-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    await mkdir(projectRoot);
    await writeFile(
      join(projectRoot, "payload.data"),
      Buffer.alloc(10 * 1024 * 1024 + 1)
    );

    await expect(
      new VersionControl().initialize(repositoryRoot, projectRoot)
    ).rejects.toMatchObject({ code: "binary_too_large" } satisfies Partial<VersionControlError>);
  });

  it("允许项目内符号链接，拒绝逃逸链接和特殊文件", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-version-special-"));
    const projectRoot = join(root, "project");
    const repositoryRoot = join(root, "repository.git");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "target.txt"), "safe\n");
    await symlink("target.txt", join(projectRoot, "inside-link"));
    const versions = new VersionControl();
    const initial = await versions.initialize(repositoryRoot, projectRoot);
    const branch = "refs/heads/work/44444444-4444-4444-4444-444444444444";
    await versions.createWorkBranch(repositoryRoot, projectRoot, branch, initial);

    await symlink(root, join(projectRoot, "outside-link"));
    await expect(
      versions.checkpoint(repositoryRoot, projectRoot, branch, "unsafe link")
    ).rejects.toMatchObject({ code: "unsafe_symlink" } satisfies Partial<VersionControlError>);
    await rm(join(projectRoot, "outside-link"));

    execFileSync("mkfifo", [join(projectRoot, "runtime.pipe")]);
    await expect(
      versions.checkpoint(repositoryRoot, projectRoot, branch, "unsafe special file")
    ).rejects.toMatchObject({
      code: "special_file_forbidden"
    } satisfies Partial<VersionControlError>);
  });
});
