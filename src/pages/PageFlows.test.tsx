import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Guest, Project } from "../types";

const pageApi = vi.hoisted(() => ({
  guests: vi.fn(),
  createGuest: vi.fn(),
  projects: vi.fn(),
  createProject: vi.fn()
}));

vi.mock("../api", () => ({ api: pageApi }));

import { GuestSelectPage } from "./GuestSelectPage";
import { HomePage } from "./HomePage";
import { ProjectsPage } from "./ProjectsPage";

const guest: Guest = { id: "guest-1", name: "default", createdAt: "2026-01-01T00:00:00Z" };
const project: Project = {
  id: "project-1",
  guestId: guest.id,
  name: "待办事项",
  previewCapable: true,
  previewStatus: "ready",
  previewUrl: "about:blank",
  previewError: null,
  thumbnailUrl: "/api/guests/guest-1/projects/project-1/thumbnail?v=1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z"
};

describe("页面核心流程", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    history.replaceState({}, "", "/home");
  });

  it("首页仅创建一个项目并导航，失败时保留草稿", async () => {
    pageApi.createProject
      .mockRejectedValueOnce(new Error("创建失败"))
      .mockResolvedValueOnce({ project, message: {} });
    render(<HomePage guest={guest} onGuestChange={() => undefined} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "创建待办事项" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("创建失败")).toBeInTheDocument();
    expect(input).toHaveValue("创建待办事项");

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(location.pathname).toBe("/projects/project-1"));
    expect(pageApi.createProject).toHaveBeenCalledTimes(2);
  });

  it("项目列表展示稳定缩略图而不是活动 iframe，并按稳定项目 ID 打开", async () => {
    pageApi.projects.mockResolvedValue({ items: [project], hasMore: false });
    render(<ProjectsPage guest={guest} onGuestChange={() => undefined} />);
    const card = await screen.findByRole("button", { name: /待办事项/ });
    expect(screen.getByRole("img", { name: "待办事项预览" })).toHaveAttribute(
      "src",
      project.thumbnailUrl
    );
    expect(screen.queryByTitle("待办事项 预览缩略图")).not.toBeInTheDocument();
    fireEvent.click(card);
    expect(location.pathname).toBe("/projects/project-1");
  });

  it("项目卡片区分生成中、首次失败、历史预览和非网页项目", async () => {
    pageApi.projects.mockResolvedValue({
      items: [
        {
          ...project,
          id: "starting",
          name: "生成中",
          previewStatus: "starting",
          thumbnailUrl: null
        },
        {
          ...project,
          id: "first-failed",
          name: "首次失败",
          previewStatus: "failed",
          thumbnailUrl: null
        },
        {
          ...project,
          id: "later-failed",
          name: "后续失败",
          previewStatus: "failed",
          thumbnailUrl: "/api/thumbnail/last-success.png"
        },
        {
          ...project,
          id: "code",
          name: "代码项目",
          previewCapable: false,
          previewStatus: "none",
          previewUrl: null,
          thumbnailUrl: null
        }
      ],
      hasMore: false
    });
    render(<ProjectsPage guest={guest} onGuestChange={() => undefined} />);

    expect(await screen.findByLabelText("生成中：正在生成预览")).toBeInTheDocument();
    expect(screen.getByLabelText("首次失败：暂无预览")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "后续失败预览" })).toHaveAttribute(
      "src",
      "/api/thumbnail/last-success.png"
    );
    expect(screen.getByLabelText("代码项目：代码项目")).toBeInTheDocument();
  });

  it("加载更多失败时保留已有项目并从正确偏移量重试", async () => {
    const projects = Array.from({ length: 21 }, (_, index): Project => ({
      ...project,
      id: `project-${index + 1}`,
      name: `项目 ${index + 1}`
    }));
    pageApi.projects
      .mockResolvedValueOnce({ items: projects.slice(0, 20), hasMore: true })
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce({ items: projects.slice(20), hasMore: false });
    render(<ProjectsPage guest={guest} onGuestChange={() => undefined} />);

    expect(await screen.findByRole("button", { name: /项目 20/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("网络中断");
    expect(screen.getByText("项目 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByRole("button", { name: /项目 21/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    expect(pageApi.projects.mock.calls).toEqual([
      [guest.id, 0],
      [guest.id, 20],
      [guest.id, 20]
    ]);
  });

  it("追加项目时去重且偏移量按服务端已读取数量推进", async () => {
    const first = Array.from({ length: 20 }, (_, index): Project => ({
      ...project,
      id: `project-${index + 1}`,
      name: `项目 ${index + 1}`
    }));
    pageApi.projects
      .mockResolvedValueOnce({ items: first, hasMore: true })
      .mockResolvedValueOnce({
        items: [first[19], { ...project, id: "project-21", name: "项目 21" }],
        hasMore: true
      })
      .mockResolvedValueOnce({
        items: [{ ...project, id: "project-22", name: "项目 22" }],
        hasMore: false
      });
    render(<ProjectsPage guest={guest} onGuestChange={() => undefined} />);

    await screen.findByText("项目 20");
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByRole("button", { name: /项目 21/ });
    expect(screen.getAllByText("项目 20")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByRole("button", { name: /项目 22/ });
    expect(pageApi.projects.mock.calls[2]).toEqual([guest.id, 22]);
  });

  it("游客选择页加载稳定列表并创建后直接进入", async () => {
    const alex: Guest = { id: "guest-2", name: "Alex", createdAt: "2026-01-02T00:00:00Z" };
    pageApi.guests.mockResolvedValue({ items: [guest] });
    pageApi.createGuest.mockResolvedValue(alex);
    const select = vi.fn();
    render(<GuestSelectPage onSelect={select} />);
    expect(await screen.findByRole("button", { name: /default/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建游客" }));
    fireEvent.change(screen.getByLabelText("新游客名称"), { target: { value: "Alex" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并进入" }));
    await waitFor(() => expect(select).toHaveBeenCalledWith(alex));
  });
});
