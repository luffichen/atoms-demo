import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffProjectFileStructure, snapshotProjectFiles } from "./file-structure-diff.js";

describe("project file structure diff", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("区分新建、删除、同目录重命名和跨目录移动", () => {
    const root = mkdtempSync(join(tmpdir(), "atoms-structure-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "rename-me.ts"), "");
    writeFileSync(join(root, "src", "move-me.ts"), "");
    writeFileSync(join(root, "delete-me.ts"), "");
    const before = snapshotProjectFiles(root);

    renameSync(join(root, "rename-me.ts"), join(root, "renamed.ts"));
    renameSync(join(root, "src", "move-me.ts"), join(root, "docs", "move-me.ts"));
    rmSync(join(root, "delete-me.ts"));
    writeFileSync(join(root, "created.ts"), "");

    expect(diffProjectFileStructure(before, snapshotProjectFiles(root))).toEqual([
      { action: "create", path: "created.ts" },
      { action: "delete", path: "delete-me.ts" },
      { action: "move", path: "docs/move-me.ts", previousPath: "src/move-me.ts" },
      { action: "rename", path: "renamed.ts", previousPath: "rename-me.ts" }
    ]);
  });
});
