import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeVersion, ConversationTurn, Guest, WorkItem } from "../types";

const apiMock = vi.hoisted(() => ({
  versions: vi.fn(),
  version: vi.fn(),
  workItems: vi.fn(),
  versionFiles: vi.fn(),
  versionDiff: vi.fn(),
  versionFile: vi.fn(),
  workItem: vi.fn(),
  workItemSnapshotFiles: vi.fn(),
  workItemSnapshotFile: vi.fn(),
  workItemSnapshotDiff: vi.fn(),
  attachmentUrl: vi.fn()
}));

vi.mock("../api", () => ({ api: apiMock }));

import { VersionViewer } from "./VersionViewer";

const guest: Guest = {
  id: "guest-1",
  name: "default",
  createdAt: "2026-07-20T00:00:00Z"
};

const workItem: WorkItem = {
  id: "work-1",
  projectId: "project-1",
  type: "direct_coding",
  requirementSequence: null,
  title: "历史版本功能",
  workflowState: "published",
  executionState: "idle",
  baseCommit: "a".repeat(40),
  branchRef: "refs/heads/work/work-1",
  revision: 2,
  error: null,
  createdAt: "2026-07-20T00:00:00Z",
  updatedAt: "2026-07-20T01:00:00Z",
  archivedAt: "2026-07-20T01:00:00Z",
  publishedVersionId: "version-1"
};

const version: CodeVersion = {
  id: "version-1",
  projectId: "project-1",
  sequence: 1,
  sourceType: "direct_coding",
  workItemId: workItem.id,
  requirementSequence: null,
  title: "历史版本功能",
  summary: "支持查看历史对话",
  commitSha: "b".repeat(40),
  tagRef: "refs/tags/code/v1",
  baseVersionId: null,
  publishedAt: "2026-07-20T01:00:00Z"
};

const turn: ConversationTurn = {
  id: "turn-1",
  projectId: "project-1",
  workItemId: workItem.id,
  sequence: 1,
  status: "completed",
  error: null,
  createdAt: "2026-07-20T00:00:00Z",
  startedAt: "2026-07-20T00:00:01Z",
  completedAt: "2026-07-20T00:01:00Z",
  items: [
    {
      id: "user-1",
      projectId: "project-1",
      turnId: "turn-1",
      ordinal: 1,
      type: "user_message",
      status: "completed",
      text: "请保留版本当时的对话",
      attachments: [],
      createdAt: "2026-07-20T00:00:00Z",
      completedAt: "2026-07-20T00:00:00Z"
    },
    {
      id: "assistant-1",
      projectId: "project-1",
      turnId: "turn-1",
      ordinal: 2,
      type: "assistant_message",
      phase: "final_answer",
      status: "completed",
      text: "已经完成。",
      createdAt: "2026-07-20T00:00:01Z",
      completedAt: "2026-07-20T00:01:00Z"
    }
  ]
};

describe("VersionViewer", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/projects/project-1");
    apiMock.versions.mockResolvedValue({ items: [version], hasMore: false });
    apiMock.workItems.mockResolvedValue({ items: [workItem], hasMore: false });
    apiMock.versionFiles.mockResolvedValue({ items: [] });
    apiMock.versionDiff.mockResolvedValue({ diff: "版本差异" });
    apiMock.version.mockResolvedValue({
      version,
      workItem,
      baseVersion: null,
      initiatedGuest: guest,
      confirmedGuest: guest,
      changes: [{ status: "added", path: "index.html" }],
      fileStats: { added: 1, modified: 0, deleted: 0, renamed: 0 },
      documents: { requirements: [], technical: [], tests: [], release: [] }
    });
    apiMock.workItem.mockResolvedValue({
      workItem,
      events: [],
      turns: { items: [turn], hasMore: false }
    });
    apiMock.workItemSnapshotFiles.mockResolvedValue({ items: [] });
    apiMock.workItemSnapshotDiff.mockResolvedValue({ diff: "放弃快照差异", changes: [] });
  });

  it("从正式版本打开对应工作项的只读对话并写入深链接", async () => {
    render(<VersionViewer guest={guest} projectId="project-1" />);

    expect(await screen.findByText("版本差异")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "工作对话" }));

    expect(await screen.findByText("请保留版本当时的对话")).toBeInTheDocument();
    expect(screen.getByText("已经完成。")).toBeInTheDocument();
    expect(apiMock.workItem).toHaveBeenCalledWith(
      guest.id,
      "project-1",
      workItem.id
    );
    expect(location.search).toContain("version=version-1");
    expect(location.search).toContain("detail=conversation");
  });

  it("从深链接恢复工作记录，并按工作项分页加载更早对话", async () => {
    history.replaceState(
      {},
      "",
      "/projects/project-1?viewer=versions&section=work&workItem=work-1&detail=conversation"
    );
    apiMock.workItem
      .mockResolvedValueOnce({
        workItem,
        events: [],
        turns: { items: [turn], hasMore: true }
      })
      .mockResolvedValueOnce({
        workItem,
        events: [],
        turns: {
          items: [{ ...turn, id: "turn-0", sequence: 0 }],
          hasMore: false
        }
      });

    render(<VersionViewer guest={guest} projectId="project-1" />);

    expect(await screen.findByText("请保留版本当时的对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    await waitFor(() =>
      expect(apiMock.workItem).toHaveBeenLastCalledWith(
        guest.id,
        "project-1",
        workItem.id,
        1
      )
    );
  });

  it("版本详情展示确认与文件元数据，并在深链接保留快照文件路径", async () => {
    apiMock.versionFiles.mockResolvedValue({
      items: [{ name: "index.html", path: "index.html", type: "file" }]
    });
    apiMock.versionFile.mockResolvedValue({
      kind: "text",
      name: "index.html",
      path: "index.html",
      size: 8,
      content: "<main />",
      language: "html"
    });
    render(
      <VersionViewer
        guest={guest}
        projectId="project-1"
        currentVersionId={version.id}
      />
    );

    expect(await screen.findByText("当前正式版本")).toBeInTheDocument();
    expect(await screen.findAllByText(guest.name)).toHaveLength(2);
    fireEvent.click((await screen.findAllByRole("button", { name: "index.html" }))
      .find((button) => button.classList.contains("file-row"))!);
    await waitFor(() => expect(location.search).toContain("path=index.html"));
    expect(screen.getByText("正在查看 V1 的只读代码快照")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回当前代码" })).toBeInTheDocument();
  });

  it("结构化活动工作默认进入当前工作，并以只读方式展示版本化需求文档", async () => {
    const activeWorkItem: WorkItem = {
      ...workItem,
      id: "work-current",
      type: "structured_requirement",
      requirementSequence: 8,
      workflowState: "requirements_discussion",
      archivedAt: null,
      publishedVersionId: null
    };
    apiMock.workItemSnapshotFiles.mockResolvedValue({
      items: [{
        name: "docs",
        path: "docs",
        type: "directory",
        children: [{
          name: "requirements",
          path: "docs/requirements",
          type: "directory",
          children: [{
            name: "R008",
            path: "docs/requirements/R008",
            type: "directory",
            children: [{
              name: "README.md",
              path: "docs/requirements/R008/README.md",
              type: "file"
            }]
          }]
        }]
      }]
    });
    apiMock.workItemSnapshotFile.mockResolvedValue({
      kind: "text",
      name: "README.md",
      path: "docs/requirements/R008/README.md",
      size: 18,
      content: "# R008\n\n验收范围",
      language: "markdown"
    });

    render(
      <VersionViewer
        guest={guest}
        projectId="project-1"
        activeWorkItem={activeWorkItem}
      />
    );

    expect(await screen.findByRole("heading", { name: "需求 8 · 历史版本功能" }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "需求" }));
    expect(await screen.findByText("验收范围")).toBeInTheDocument();
    expect(apiMock.workItemSnapshotFile).toHaveBeenCalledWith(
      guest.id,
      "project-1",
      activeWorkItem.id,
      "docs/requirements/R008/README.md"
    );
    expect(location.search).toContain("section=current");
    expect(location.search).toContain("tab=requirements");
  });

  it("没有活动工作时可从当前工作区域选择按需求研发", async () => {
    const onSelectNewWorkMode = vi.fn();
    render(
      <VersionViewer
        guest={guest}
        projectId="project-1"
        onSelectNewWorkMode={onSelectNewWorkMode}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "当前工作" }));
    fireEvent.click(screen.getByRole("button", { name: "按需求研发" }));
    expect(onSelectNewWorkMode).toHaveBeenCalledWith("structured_requirement");
  });
});
