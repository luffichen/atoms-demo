import type {
  FileTreeNode,
  FileView,
  Guest,
  ConversationTurn,
  CodeVersionDetails,
  CodeVersion,
  Notification,
  Project,
  WorkItem,
  WorkItemEvent,
  WorkItemType,
  WorkflowState
} from "./types";
import { ImageUploadError } from "./image-upload";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (typeof options?.body === "string") headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...options,
    headers
  });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    throw new ApiError(
      data?.error?.message ?? "请求失败",
      data?.error?.code ?? "request_failed",
      response.status,
      data?.error?.details
    );
  }
  return data as T;
}

async function uploadImages(guestId: string, files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, file] of files.entries()) {
    const body = new FormData();
    body.append("file", file, file.name);
    try {
      const uploaded = await request<{ id: string }>(
        `/api/guests/${guestId}/uploads`,
        { method: "POST", body }
      );
      ids.push(uploaded.id);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "请检查网络后重试";
      throw new ImageUploadError(index, file.name, `图片“${file.name}”上传失败：${detail}`);
    }
  }
  return ids;
}

function uploadImage(
  guestId: string,
  file: File,
  onProgress: (progress: number) => void = () => undefined
): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/guests/${guestId}/uploads`);
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    xhr.addEventListener("load", () => {
      const data = xhr.response ?? {};
      if (xhr.status >= 200 && xhr.status < 300 && typeof data.id === "string") {
        onProgress(100);
        resolve({ id: data.id });
        return;
      }
      reject(
        new ApiError(
          data.error?.message ?? "图片上传失败",
          data.error?.code ?? "upload_failed",
          xhr.status
        )
      );
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError("网络中断，请重试", "upload_network_error", 0))
    );
    xhr.addEventListener("abort", () =>
      reject(new ApiError("图片上传已取消", "upload_cancelled", 0))
    );
    xhr.send(body);
  });
}

async function resolvedUploadIds(
  guestId: string,
  images: File[],
  uploadIds: string[]
): Promise<string[]> {
  return uploadIds.length ? uploadIds : uploadImages(guestId, images);
}

export const api = {
  guests: () => request<{ items: Guest[] }>("/api/guests"),
  createGuest: (name: string) =>
    request<Guest>("/api/guests", { method: "POST", body: JSON.stringify({ name }) }),
  notifications: (guestId: string) =>
    request<{ items: Notification[] }>(`/api/guests/${guestId}/notifications`),
  projects: (guestId: string, offset = 0) =>
    request<{ items: Project[]; hasMore: boolean }>(
      `/api/guests/${guestId}/projects?offset=${offset}`
    ),
  createProject: async (
    guestId: string,
    text: string,
    images: File[] = [],
    mode: WorkItemType = "direct_coding",
    uploadIds: string[] = [],
    confirmed = false
  ) =>
    request<{ project: Project; workItem: WorkItem; turn: ConversationTurn }>(
      `/api/guests/${guestId}/projects`,
      {
        method: "POST",
        body: JSON.stringify({
          text,
          mode,
          confirmed,
          uploadIds: await resolvedUploadIds(guestId, images, uploadIds)
        })
      }
    ),
  project: (guestId: string, projectId: string) =>
    request<{
      project: Project;
      activeWorkItem: WorkItem | null;
      workItemEvents: WorkItemEvent[];
      currentCodeVersion: CodeVersion | null;
      turns: { items: ConversationTurn[]; hasMore: boolean; nextCursor: string | null };
    }>(`/api/guests/${guestId}/projects/${projectId}`),
  olderMessages: (guestId: string, projectId: string, before: string) =>
    request<{ items: ConversationTurn[]; hasMore: boolean; nextCursor: string | null }>(
      `/api/guests/${guestId}/projects/${projectId}/turns?before=${encodeURIComponent(before)}`
    ),
  sendMessage: async (
    guestId: string,
    projectId: string,
    text: string,
    images: File[] = [],
    uploadIds: string[] = []
  ) =>
    request<ConversationTurn>(`/api/guests/${guestId}/projects/${projectId}/turns`, {
      method: "POST",
      body: JSON.stringify({
        text,
        uploadIds: await resolvedUploadIds(guestId, images, uploadIds)
      })
    }),
  workItems: (guestId: string, projectId: string, offset = 0) =>
    request<{ items: WorkItem[]; hasMore: boolean }>(
      `/api/guests/${guestId}/projects/${projectId}/work-items?offset=${offset}`
    ),
  workItem: (
    guestId: string,
    projectId: string,
    workItemId: string,
    before?: number
  ) =>
    request<{
      workItem: WorkItem;
      events: WorkItemEvent[];
      turns: { items: ConversationTurn[]; hasMore: boolean };
    }>(
      `/api/guests/${guestId}/projects/${projectId}/work-items/${workItemId}${
        before === undefined ? "" : `?before=${before}`
      }`
    ),
  workItemEvents: (guestId: string, projectId: string, workItemId: string) =>
    request<{ items: WorkItemEvent[] }>(
      `/api/guests/${guestId}/projects/${projectId}/work-items/${workItemId}/events`
    ),
  createWorkItem: async (
    guestId: string,
    projectId: string,
    text: string,
    type: WorkItemType,
    images: File[] = [],
    uploadIds: string[] = [],
    source: "button" | "natural_language" = "button",
    confirmed = false
  ) =>
    request<{ workItem: WorkItem; turn: ConversationTurn }>(
      `/api/guests/${guestId}/projects/${projectId}/work-items`,
      {
        method: "POST",
        body: JSON.stringify({
          text,
          type,
          source,
          confirmed,
          uploadIds: await resolvedUploadIds(guestId, images, uploadIds)
        })
      }
    ),
  workItemAction: (
    guestId: string,
    projectId: string,
    workItemId: string,
    input: {
      action: string;
      targetState?: WorkflowState;
      title?: string;
      summary?: string;
      reason?: string;
      confirmed?: boolean;
      source?: "button" | "natural_language";
      revision: number;
      idempotencyKey: string;
    }
  ) =>
    request<{
      confirmationRequired?: boolean;
      message?: string;
      targetState?: WorkflowState;
      suggestedTitle?: string;
      suggestedSummary?: string;
      workItem?: WorkItem;
      turn?: ConversationTurn;
      version?: CodeVersion;
    }>(
      `/api/guests/${guestId}/projects/${projectId}/work-items/${workItemId}/actions`,
      { method: "POST", body: JSON.stringify(input) }
    ),
  updateWorkItemTitle: (
    guestId: string,
    projectId: string,
    workItemId: string,
    title: string,
    revision: number
  ) =>
    request<WorkItem>(
      `/api/guests/${guestId}/projects/${projectId}/work-items/${workItemId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title, revision })
      }
    ),
  uploadImage,
  deleteUpload: (guestId: string, uploadId: string) =>
    request<void>(`/api/guests/${guestId}/uploads/${uploadId}`, {
      method: "DELETE"
    }),
  versions: (guestId: string, projectId: string, offset = 0) =>
    request<{ items: CodeVersion[]; hasMore: boolean }>(
      `/api/guests/${guestId}/projects/${projectId}/versions?offset=${offset}`
    ),
  version: (guestId: string, projectId: string, versionId: string) =>
    request<CodeVersionDetails>(
      `/api/guests/${guestId}/projects/${projectId}/versions/${versionId}`
    ),
  workItemSnapshotFiles: (guestId: string, projectId: string, workItemId: string) =>
    request<{ items: FileTreeNode[] }>(
      `/api/guests/${guestId}/projects/${projectId}/work-items/${workItemId}/snapshot/files`
    ),
  workItemSnapshotFile: (
    guestId: string,
    projectId: string,
    workItemId: string,
    path: string
  ) =>
    request<FileView>(
      `/api/guests/${guestId}/projects/${projectId}/work-items/${workItemId}/snapshot/file?path=${encodeURIComponent(path)}`
    ),
  workItemSnapshotDiff: (guestId: string, projectId: string, workItemId: string) =>
    request<{ diff: string; changes: import("./types").VersionFileChange[] }>(
      `/api/guests/${guestId}/projects/${projectId}/work-items/${workItemId}/snapshot/diff`
    ),
  versionFiles: (guestId: string, projectId: string, versionId: string) =>
    request<{ items: FileTreeNode[] }>(
      `/api/guests/${guestId}/projects/${projectId}/versions/${versionId}/files`
    ),
  versionFile: (
    guestId: string,
    projectId: string,
    versionId: string,
    path: string
  ) =>
    request<FileView>(
      `/api/guests/${guestId}/projects/${projectId}/versions/${versionId}/file?path=${encodeURIComponent(path)}`
    ),
  versionDiff: (
    guestId: string,
    projectId: string,
    versionId: string,
    path?: string
  ) =>
    request<{ diff: string }>(
      `/api/guests/${guestId}/projects/${projectId}/versions/${versionId}/diff${
        path ? `?path=${encodeURIComponent(path)}` : ""
      }`
    ),
  cancelTurn: (guestId: string, projectId: string, turnId: string) =>
    request<ConversationTurn>(
      `/api/guests/${guestId}/projects/${projectId}/turns/${turnId}/queue`,
      { method: "DELETE" }
    ),
  stopTurn: (
    guestId: string,
    projectId: string,
    turnId: string,
    input: {
      confirmed: true;
      revision: number;
      idempotencyKey: string;
      source: "button" | "natural_language";
    }
  ) =>
    request<ConversationTurn>(
      `/api/guests/${guestId}/projects/${projectId}/turns/${turnId}/stop`,
      { method: "POST", body: JSON.stringify(input) }
    ),
  retryPreview: (guestId: string, projectId: string) =>
    request<Project>(
      `/api/guests/${guestId}/projects/${projectId}/preview/retry`,
      { method: "POST" }
    ),
  files: (guestId: string, projectId: string) =>
    request<{ items: FileTreeNode[] }>(`/api/guests/${guestId}/projects/${projectId}/files`),
  file: (guestId: string, projectId: string, path: string) =>
    request<FileView>(
      `/api/guests/${guestId}/projects/${projectId}/file?path=${encodeURIComponent(path)}`
    ),
  attachmentUrl: (
    guestId: string,
    projectId: string,
    turnId: string,
    itemId: string,
    attachmentId: string
  ) =>
    `/api/guests/${guestId}/projects/${projectId}/turns/${turnId}/items/${itemId}/attachments/${attachmentId}`
};
