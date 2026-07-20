import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateRequirementPackage,
  validateTechnicalDesign,
  validateTestReport
} from "./workflow-documents.js";

describe("结构化工作流文档门禁", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-workflow-documents-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("正式需求包校验 README、原子需求结构和待确认项", async () => {
    const directory = join(root, "docs", "requirements", "R007-feature");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "README.md"),
      "# 功能\n## 总体目标\n目标\n## 范围\n范围\n## 非目标\n无\n## 依赖\n无\n## 原子需求索引\n- [原子需求](./atomic.md)"
    );
    await writeFile(
      join(directory, "atomic.md"),
      "# 原子需求\n## 目标\n目标\n## 需求\n需求\n## 验收标准\n通过\n## 非目标\n无\n## 原子性检查\n可独立验收"
    );

    await expect(validateRequirementPackage(root, 7)).resolves.toMatchObject({
      root: directory,
      documents: [join(directory, "atomic.md")]
    });
    await writeFile(join(directory, "atomic.md"), "# 目标\n待确认");
    await expect(validateRequirementPackage(root, 7)).rejects.toMatchObject({
      code: "document_sections_missing"
    });
  });

  it("技术方案必须覆盖全部强制章节且没有待确认项", async () => {
    const directory = join(root, "docs", "technical");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "R007-feature.md");
    await writeFile(
      path,
      [
        "# 技术方案",
        "## 背景与需求引用",
        "## 现状分析",
        "## 总体方案",
        "## 数据模型",
        "## 接口与事件",
        "## 前端交互",
        "## 安全边界",
        "## 兼容性",
        "## 实施步骤",
        "## 测试计划",
        "## 上线回滚",
        "## 风险",
        "## 非目标"
      ].join("\n内容\n") + "\n内容"
    );
    await expect(validateTechnicalDesign(root, 7)).resolves.toBe(path);
  });

  it("界面项目的测试报告必须引用两张有效截图", async () => {
    const directory = join(root, "docs", "test-reports", "R007-assets");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "desktop.png"), "desktop");
    await writeFile(join(directory, "mobile.png"), "mobile");
    const report = join(root, "docs", "test-reports", "R007-feature.md");
    await writeFile(
      report,
      [
        "# 测试报告",
        "## 环境",
        "## 检查点",
        "## 命令",
        "## 耗时",
        "## 摘要",
        "## 验收映射\nAC1 → 通过",
        "## 界面尺寸",
        "桌面 1440x900，移动 390x844",
        "![桌面](./R007-assets/desktop.png)",
        "![移动](./R007-assets/mobile.png)",
        "## 已知限制",
        "无",
        "## 最终结论",
        "通过"
      ].join("\n内容\n")
    );
    await expect(validateTestReport(root, 7, true)).resolves.toEqual({
      reportPath: report,
      screenshotPaths: [
        join(directory, "desktop.png"),
        join(directory, "mobile.png")
      ]
    });
  });
});
