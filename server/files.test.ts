import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileTree, readProjectFile } from "./files.js";

describe("project files", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("隐藏依赖和构建目录并阻止越界", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-files-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n");
    await writeFile(join(root, "node_modules", "hidden.js"), "");
    const tree = await buildFileTree(root);
    expect(tree.map(({ name }) => name)).toEqual(["src"]);
    await expect(readProjectFile(root, "../secret")).rejects.toThrow("项目目录之外");
  });

  it("文本带类型返回，超过 1MB 不截断展示", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-files-"));
    await writeFile(join(root, "app.ts"), "const value = 1;\n");
    expect(await readProjectFile(root, "app.ts")).toMatchObject({
      kind: "text",
      language: "typescript",
      content: "const value = 1;\n"
    });
    await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
    expect(await readProjectFile(root, "large.txt")).toMatchObject({
      kind: "large",
      message: "文件过大，无法预览"
    });
  });
});
