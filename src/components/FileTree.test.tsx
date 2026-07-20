import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree";

describe("FileTree", () => {
  it("首次进入时顶层目录保持收起，选中深层文件时自动展开路径", () => {
    const onSelect = vi.fn();
    const items = [{
      name: "src",
      path: "src",
      type: "directory" as const,
      children: [{ name: "main.ts", path: "src/main.ts", type: "file" as const }]
    }];
    const { rerender } = render(
      <FileTree items={items} selected={null} onSelect={onSelect} />
    );
    expect(screen.queryByRole("button", { name: /main\.ts/ })).not.toBeInTheDocument();

    rerender(<FileTree items={items} selected="src/main.ts" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /main\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith("src/main.ts");
  });
});
