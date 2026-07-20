import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Guest } from "../types";
import { Shell } from "./Shell";

const guest: Guest = { id: "guest-1", name: "default", createdAt: "2026-01-01T00:00:00Z" };

describe("Shell", () => {
  beforeEach(() => localStorage.clear());

  it("移动导航可由同一按钮开关，打开时主内容不可聚焦", () => {
    render(
      <Shell guest={guest} active="home" onGuestChange={() => undefined}>
        <button>页面操作</button>
      </Shell>
    );
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    expect(screen.getByRole("button", { name: "关闭导航" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByRole("main")).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "关闭导航" }));
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("桌面侧边栏折叠状态持久保存", async () => {
    render(
      <Shell guest={guest} active="projects" onGuestChange={() => undefined}>
        <span>内容</span>
      </Shell>
    );
    fireEvent.click(screen.getByRole("button", { name: "折叠侧边栏" }));
    await waitFor(() => expect(localStorage.getItem("atoms.sidebar")).toBe("collapsed"));
    expect(screen.getByRole("button", { name: "展开侧边栏" })).toBeInTheDocument();
  });
});
