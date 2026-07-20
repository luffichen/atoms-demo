import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("渲染常用 Markdown 且不执行 HTML 和脚本", () => {
    const { container } = render(
      <Markdown content={"## 标题\n\n[外链](https://example.com)\n\n<script>alert(1)</script>"} />
    );
    expect(screen.getByRole("heading", { name: "标题" })).toBeVisible();
    expect(screen.getByRole("link", { name: "外链" })).toHaveAttribute("target", "_blank");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
