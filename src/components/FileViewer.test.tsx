import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileViewer } from "./FileViewer";

describe("FileViewer", () => {
  it("renders a highlighted text file with path, language, and line numbers", () => {
    const { container } = render(
      <FileViewer
        file={{
          kind: "text",
          name: "app.ts",
          path: "src/app.ts",
          size: 20,
          content: "const answer = 42;\n",
          language: "typescript"
        }}
        path="src/app.ts"
        state="ready"
      />
    );
    expect(screen.getByTitle("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(container.querySelector(".token.keyword")).toHaveTextContent("const");
    expect(container.querySelectorAll(".code-line")).toHaveLength(1);
    expect(container.querySelector(".code-line > span")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("renders file loading and failure states without stale content", () => {
    const { rerender } = render(
      <FileViewer file={null} path="src/next.ts" state="loading" />
    );
    expect(screen.getByText("正在加载文件…")).toBeInTheDocument();
    rerender(
      <FileViewer
        error="文件已删除"
        file={null}
        path="src/next.ts"
        state="error"
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("文件已删除");
  });

  it("renders unknown text as text rather than injected markup", () => {
    const content = '<img src="bad" onerror="alert(1)">';
    const { container } = render(
      <FileViewer
        file={{
          kind: "text",
          name: "payload.unknown",
          path: "payload.unknown",
          size: content.length,
          content,
          language: "text"
        }}
        path="payload.unknown"
        state="ready"
      />
    );
    expect(screen.getByText("纯文本")).toBeInTheDocument();
    expect(screen.getByText(content)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
