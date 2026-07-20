import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("图片上传完整性", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("任意图片上传失败时不创建项目，并指出失败图片", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "upload-1" }))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "upload_failed", message: "网络中断" }
      }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const files = [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" })
    ];

    await expect(api.createProject("guest-1", "完整需求", files)).rejects.toMatchObject({
      code: "image_upload_failed",
      failedImageIndex: 1,
      failedImageName: "second.png"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/uploads"))).toBe(true);
  });

  it("全部图片上传成功后才提交消息及所有上传 ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "upload-1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "upload-2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "turn-1", items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const files = [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" })
    ];

    await api.sendMessage("guest-1", "project-1", "完整需求", files);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, options] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe("/api/guests/guest-1/projects/project-1/turns");
    expect(JSON.parse(String(options.body))).toEqual({
      text: "完整需求",
      uploadIds: ["upload-1", "upload-2"]
    });
  });

  it("保留服务端结构化流转错误详情供界面解释下一步", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "invalid_transition",
        message: "无法开始测试：当前处于「需求讨论」。",
        details: {
          kind: "workflow_transition",
          actionLabel: "开始测试",
          currentStateLabel: "需求讨论",
          allowedStateLabels: ["开发"],
          guidance: "请先完成需求讨论。"
        }
      }
    }, 409)));

    await expect(
      api.workItemAction("guest-1", "project-1", "work-1", {
        action: "start_testing",
        revision: 1,
        idempotencyKey: "structured-error-1"
      })
    ).rejects.toMatchObject({
      code: "invalid_transition",
      details: {
        kind: "workflow_transition",
        actionLabel: "开始测试",
        currentStateLabel: "需求讨论",
        allowedStateLabels: ["开发"],
        guidance: "请先完成需求讨论。"
      }
    });
  });
});
