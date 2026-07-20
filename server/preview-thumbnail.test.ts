import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewThumbnailer } from "./preview-thumbnail.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d
]);

describe("PreviewThumbnailer", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("始终截取入口页并返回经过校验的 PNG", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-thumbnail-"));
    await mkdir(join(root, ".tmp"));
    const runner = vi.fn(async (projectRoot: string, command: string) => {
      expect(command).toContain("--window-size=1280,720");
      expect(command).toContain("'https://preview.example.test/'");
      await writeFile(join(projectRoot, ".tmp", "preview-thumbnail.png"), PNG);
    });

    const result = await new PreviewThumbnailer(runner).capture(
      root,
      "https://preview.example.test/"
    );

    expect(result).toEqual(PNG);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("拒绝空文件或伪造的截图结果", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-thumbnail-"));
    await mkdir(join(root, ".tmp"));
    const runner = async (projectRoot: string) => {
      await writeFile(join(projectRoot, ".tmp", "preview-thumbnail.png"), "not png");
    };

    await expect(
      new PreviewThumbnailer(runner).capture(root, "https://preview.example.test/")
    ).rejects.toThrow("有效的 PNG");
  });

  it("可按桌面与移动视口生成独立证据截图", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-thumbnail-"));
    await mkdir(join(root, ".tmp"));
    const runner = vi.fn(async (projectRoot: string, command: string) => {
      expect(command).toContain("--window-size=390,844");
      expect(command).toContain("--screenshot=/tmp/ui-mobile.png");
      await writeFile(join(projectRoot, ".tmp", "ui-mobile.png"), PNG);
    });
    await expect(
      new PreviewThumbnailer(runner).capture(root, "https://preview.example.test/", {
        width: 390,
        height: 844,
        outputName: "ui-mobile.png"
      })
    ).resolves.toEqual(PNG);
  });
});
