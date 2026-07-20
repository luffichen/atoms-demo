import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReleaseValidationError,
  validateReleaseCandidate
} from "./release-validation.js";

describe("发布前统一门禁", () => {
  let root = "";
  const projectId = "11111111-1111-1111-1111-111111111111";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("依次执行已有质量脚本并通过可用预览", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-release-validation-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc", build: "vite build" } })
    );
    const runCommand = vi.fn(async () => ({ exitCode: 0, output: "passed" }));

    const report = await validateReleaseCandidate({
      projectId,
      projectRoot: root,
      runCommand,
      refreshPreview: async () => ({
        projectId,
        previewCapable: true,
        previewStatus: "ready",
        previewUrl: `/preview/${projectId}/`,
        previewError: null
      })
    });

    expect(runCommand.mock.calls.map(([, command]) => command)).toEqual([
      "npm run test",
      "npm run typecheck",
      "npm run build"
    ]);
    expect(report.checks).toContainEqual({
      id: "lint",
      status: "not_applicable",
      evidence: expect.stringContaining("未提供")
    });
    expect(report.preview.previewStatus).toBe("ready");
  });

  it("质量脚本失败时立即阻止发布", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-release-validation-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "vite build" } })
    );
    const refreshPreview = vi.fn();

    await expect(validateReleaseCandidate({
      projectId,
      projectRoot: root,
      runCommand: async () => ({ exitCode: 1, output: "tests failed" }),
      refreshPreview
    })).rejects.toMatchObject({
      code: "quality_check_failed",
      evidence: "tests failed"
    } satisfies Partial<ReleaseValidationError>);
    expect(refreshPreview).not.toHaveBeenCalled();
  });

  it("非网页且无脚本的项目可发布，但明确记录不适用项", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-release-validation-"));
    await writeFile(join(root, "README.md"), "# CLI");
    const report = await validateReleaseCandidate({
      projectId,
      projectRoot: root,
      runCommand: vi.fn(),
      refreshPreview: async () => ({
        projectId,
        previewCapable: false,
        previewStatus: "none",
        previewUrl: null,
        previewError: null
      })
    });

    expect(report.commands).toEqual([]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "candidate_files", status: "passed" }),
        expect.objectContaining({ id: "configuration", status: "not_applicable" })
      ])
    );
    expect(report.checks.filter(({ status }) => status === "not_applicable")).toHaveLength(6);
  });

  it("预览失败或候选文件含密钥时阻止发布", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-release-validation-"));
    await writeFile(join(root, "index.html"), "<main>candidate</main>");
    await expect(validateReleaseCandidate({
      projectId,
      projectRoot: root,
      runCommand: vi.fn(),
      refreshPreview: async () => ({
        projectId,
        previewCapable: true,
        previewStatus: "failed",
        previewUrl: null,
        previewError: "boot failed"
      })
    })).rejects.toMatchObject({ code: "preview_unavailable" });

    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "secret.txt"), "-----BEGIN PRIVATE KEY-----");
    await expect(validateReleaseCandidate({
      projectId,
      projectRoot: root,
      runCommand: vi.fn(),
      refreshPreview: vi.fn()
    })).rejects.toMatchObject({ code: "sensitive_content" });
  });

  it("没有任何候选文件时不允许用发布记录伪造空版本", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-release-validation-"));
    await expect(validateReleaseCandidate({
      projectId,
      projectRoot: root,
      runCommand: vi.fn(),
      refreshPreview: vi.fn()
    })).rejects.toMatchObject({ code: "candidate_empty" });
  });
});
