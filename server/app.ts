import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as proxyRequest } from "node:http";
import { join, resolve } from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import type { AppConfig } from "./config.js";
import { AgentRunner } from "./agent-runner.js";
import { validateImage, validateMessageText } from "./domain/validation.js";
import { buildFileTree, readProjectFile } from "./files.js";
import type { FileTreeNode } from "./files.js";
import { ensureProjectPaths } from "./paths.js";
import { assertInsideProject } from "./paths.js";
import { RealtimeHub } from "./realtime.js";
import { Store, StoreError } from "./store.js";
import { fallbackProjectName } from "./domain/project-name.js";
import { VersionControl, VersionControlError } from "./version-control.js";
import type { WorkItemType, WorkflowState } from "./domain/types.js";
import { PreviewManager } from "./preview-manager.js";
import { PreviewThumbnailer } from "./preview-thumbnail.js";
import {
  ReleaseValidationError,
  validateReleaseCandidate,
  type ReleaseValidationReport
} from "./release-validation.js";
import {
  recordUiEvidence,
  validateRequirementPackage,
  validateTechnicalDesign,
  validateTestReport,
  WorkflowDocumentError
} from "./workflow-documents.js";
import {
  createReleaseMetadataGenerator,
  type ReleaseMetadataGenerator
} from "./release-metadata.js";

type GuestParams = { guestId: string };
type ProjectParams = GuestParams & { projectId: string };
type TurnParams = ProjectParams & { turnId: string };
type AttachmentParams = TurnParams & { itemId: string; attachmentId: string };
type IncomingImage = { name: string; type: string; size: number; data: string };
type MessageBody = { text?: string; images?: IncomingImage[]; uploadIds?: string[] };
type WorkItemParams = ProjectParams & { workItemId: string };
type VersionParams = ProjectParams & { versionId: string };
const PREVIEW_IDLE_MS = 10 * 60 * 1000;
const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const THUMBNAIL_RENDER_VERSION = "3";
const THUMBNAIL_FILENAME = `preview-thumbnail-v${THUMBNAIL_RENDER_VERSION}.png`;

export async function cleanupExpiredPendingUploads(
  store: Store,
  currentTime = Date.now()
): Promise<number> {
  const expired = store.deleteExpiredPendingUploads(
    new Date(currentTime - PENDING_UPLOAD_TTL_MS).toISOString()
  );
  await Promise.all(expired.map(({ storagePath }) => rm(storagePath, { force: true })));
  return expired.length;
}

function injectPreviewBridge(html: string): string {
  const bridge = `<script>
(() => {
  const report = () => parent.postMessage({
    source: "atoms-preview",
    path: location.href
  }, "*");
  addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("a[href]").forEach((link) => {
      try {
        const target = new URL(link.href, location.href);
        if (target.origin !== location.origin) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
      } catch {}
    });
    report();
  });
  addEventListener("hashchange", report);
  addEventListener("popstate", report);
})();
</script>`;
  return /<\/body\s*>/i.test(html)
    ? html.replace(/<\/body\s*>/i, `${bridge}</body>`)
    : `${html}${bridge}`;
}

export function rewritePreviewLocation(
  location: string | undefined,
  target: { hostname: string; port: number },
  publicOrigin: string
): string | undefined {
  if (!location) return location;
  try {
    const parsed = new URL(location, publicOrigin);
    const targetsRuntime =
      parsed.port === String(target.port) &&
      (parsed.hostname === target.hostname ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1");
    if (!targetsRuntime) return location;
    const origin = new URL(publicOrigin);
    parsed.protocol = origin.protocol;
    parsed.hostname = origin.hostname;
    parsed.port = origin.port;
    return parsed.toString();
  } catch {
    return location;
  }
}

function proxyPreviewRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  target: { hostname: string; port: number },
  publicDomain: string
): void {
  reply.hijack();
  const headers = {
    ...request.headers,
    host: request.hostname,
    "accept-encoding": "identity",
    "x-forwarded-host": request.hostname,
    "x-forwarded-proto": "https"
  };
  delete headers.connection;
  const upstream = proxyRequest(
    {
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.raw.url,
      headers
    },
    (response) => {
      const contentType = String(response.headers["content-type"] ?? "");
      const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
        .split(",")[0]
        .trim();
      const protocol = forwardedProto === "https" ? "https" : request.protocol;
      const publicOrigin = `${protocol}://${request.hostname}`;
      const responseHeaders = { ...response.headers };
      const rewrittenLocation = rewritePreviewLocation(
        responseHeaders.location,
        target,
        publicOrigin
      );
      if (rewrittenLocation) responseHeaders.location = rewrittenLocation;
      else delete responseHeaders.location;
      if (contentType.includes("text/html")) {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const html = injectPreviewBridge(Buffer.concat(chunks).toString("utf8"));
          delete responseHeaders["content-length"];
          delete responseHeaders["content-encoding"];
          responseHeaders["content-type"] = "text/html; charset=utf-8";
          responseHeaders["content-security-policy"] = [
            "default-src 'self' data: blob: https:",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
            "style-src 'self' 'unsafe-inline' https:",
            "connect-src 'self' ws: wss: https:",
            `frame-ancestors https://${publicDomain}`,
            "base-uri 'self'"
          ].join("; ");
          responseHeaders["cross-origin-resource-policy"] = "cross-origin";
          reply.raw.writeHead(response.statusCode ?? 200, responseHeaders);
          reply.raw.end(html);
        });
        return;
      }
      reply.raw.writeHead(response.statusCode ?? 200, responseHeaders);
      response.pipe(reply.raw);
    }
  );
  upstream.once("error", (error) => {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    reply.raw.end(`Preview unavailable: ${error.message}`);
  });
  request.raw.pipe(upstream);
}

function requireProject(store: Store, guestId: string, projectId: string) {
  const project = store.getProjectForGuest(projectId, guestId);
  if (!project) throw new StoreError("project_unavailable", "项目不可用", 404);
  return project;
}

function markChangedFiles(
  nodes: FileTreeNode[],
  changes: Map<string, "new" | "updated">
): FileTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    change: node.type === "file" ? changes.get(node.path) : undefined,
    children: node.children ? markChangedFiles(node.children, changes) : undefined
  }));
}

function decodeImages(images: IncomingImage[] = []): Array<IncomingImage & { id: string; buffer: Buffer }> {
  return images.map((image, index) => {
    const validation = validateImage(image, index);
    if (!validation.valid) throw new StoreError(validation.code, validation.message);
    const buffer = Buffer.from(image.data, "base64");
    if (buffer.byteLength !== image.size) {
      throw new StoreError("image_corrupt", `${image.name || "图片"} 处理失败`);
    }
    return { ...image, id: crypto.randomUUID(), buffer };
  });
}

async function persistAttachments(
  config: AppConfig,
  store: Store,
  guestId: string,
  projectId: string,
  turnId: string,
  images: Array<IncomingImage & { id: string; buffer: Buffer }>
) {
  if (!images.length) return store.getTurn(turnId)!;
  const paths = await ensureProjectPaths(config, guestId, projectId);
  const turnRoot = join(paths.attachmentRoot, turnId);
  await mkdir(turnRoot, { recursive: true });
  try {
    const records = [];
    for (const image of images) {
      const extension = image.type === "image/png" ? ".png" : ".jpg";
      const storagePath = join(turnRoot, `${image.id}${extension}`);
      await writeFile(storagePath, image.buffer, { flag: "wx" });
      records.push({
        id: image.id,
        originalName: image.name || `image${extension}`,
        mimeType: image.type,
        size: image.size,
        storagePath
      });
    }
    return store.addAttachments(turnId, records);
  } catch (error) {
    await rm(turnRoot, { recursive: true, force: true });
    throw error;
  }
}

async function persistUploadedAttachments(
  config: AppConfig,
  store: Store,
  guestId: string,
  projectId: string,
  turnId: string,
  uploadIds: string[] = []
) {
  const uniqueIds = [...new Set(uploadIds)];
  if (uniqueIds.length !== uploadIds.length) {
    throw new StoreError("upload_invalid", "上传引用重复");
  }
  if (!uniqueIds.length) return store.getTurn(turnId)!;
  const uploads = store.getPendingUploads(guestId, uniqueIds);
  if (uploads.length !== uniqueIds.length) {
    throw new StoreError("upload_unavailable", "部分图片已失效，请重新添加");
  }
  const paths = await ensureProjectPaths(config, guestId, projectId);
  const turnRoot = join(paths.attachmentRoot, turnId);
  await mkdir(turnRoot, { recursive: true });
  try {
    const records = [];
    for (const upload of uploads) {
      const extension = upload.mimeType === "image/png" ? ".png" : ".jpg";
      const storagePath = join(turnRoot, `${upload.id}${extension}`);
      await copyFile(upload.storagePath, storagePath);
      records.push({
        id: upload.id,
        originalName: upload.originalName,
        mimeType: upload.mimeType,
        size: upload.size,
        storagePath
      });
    }
    const turn = store.addAttachments(turnId, records);
    store.consumePendingUploads(uniqueIds);
    await Promise.all(uploads.map((upload) => rm(upload.storagePath, { force: true })));
    return turn;
  } catch (error) {
    await rm(turnRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function buildApp(options: {
  config: AppConfig;
  store: Store;
  hub?: RealtimeHub;
  runner?: AgentRunner;
  versions?: VersionControl;
  previews?: PreviewManager;
  thumbnailer?: PreviewThumbnailer;
  releaseValidator?: typeof validateReleaseCandidate;
  releaseMetadataGenerator?: ReleaseMetadataGenerator;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const { config, store } = options;
  const hub = options.hub ?? new RealtimeHub();
  const versions = options.versions ?? new VersionControl();
  const previews =
    options.previews ??
    (options.runner as (AgentRunner & { previews?: PreviewManager }) | undefined)?.previews ??
    new PreviewManager(config);
  const runner = options.runner ?? new AgentRunner(config, store, hub, versions, previews);
  const releaseValidator = options.releaseValidator ?? validateReleaseCandidate;
  const releaseMetadataGenerator =
    options.releaseMetadataGenerator ??
    createReleaseMetadataGenerator(config.releaseMetadataModel);
  const thumbnailer = options.thumbnailer ?? new PreviewThumbnailer();
  const thumbnailCaptures = new Map<string, Promise<void>>();
  const previewStopTimers = new Map<string, NodeJS.Timeout>();
  await cleanupExpiredPendingUploads(store);
  const pendingUploadCleanupTimer = setInterval(() => {
    void cleanupExpiredPendingUploads(store).catch((error) => app.log.error(error));
  }, PENDING_UPLOAD_CLEANUP_INTERVAL_MS);
  pendingUploadCleanupTimer.unref();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 55 * 1024 * 1024 });
  const unsubscribeWorkflowNotifications = store.onNotification((notification) => {
    hub.publish(
      `guest:${notification.guestId}`,
      "notification",
      notification,
      notification.id
    );
  });
  await app.register(websocket);
  await app.register(fastifyMultipart, {
    limits: { files: 1, fileSize: 10 * 1024 * 1024 }
  });
  const previewEntryUrl = (previewUrl: string) => {
    const protocol = config.isProduction ? "https" : "http";
    const port = config.isProduction || config.port === 80 || config.port === 443
      ? ""
      : `:${config.port}`;
    return new URL(
      previewUrl,
      `${protocol}://${config.publicDomain}${port}/`
    ).toString();
  };
  const asWorkflowConflict = (error: unknown): never => {
    if (error instanceof WorkflowDocumentError) {
      throw new StoreError(error.code, error.message, 409);
    }
    throw error;
  };
  const captureThumbnail = async (projectId: string, previewUrl: string) => {
    const activeCapture = thumbnailCaptures.get(projectId);
    if (activeCapture) return activeCapture;
    const project = store.getProject(projectId);
    if (!project) return;
    const capture = (async () => {
      try {
        const paths = await ensureProjectPaths(config, project.guestId, project.id);
        const entryUrl = previewEntryUrl(previewUrl);
        const image = await thumbnailer.capture(paths.projectRoot, entryUrl);
        const thumbnailPath = join(paths.attachmentRoot, THUMBNAIL_FILENAME);
        await writeFile(thumbnailPath, image);
        const capturedAt = Date.now();
        const thumbnailUrl =
          `/api/guests/${project.guestId}/projects/${project.id}/thumbnail?v=${THUMBNAIL_RENDER_VERSION}-${capturedAt}`;
        const updated = store.updateThumbnail(project.id, thumbnailUrl);
        hub.publish(
          project.id,
          "preview",
          updated,
          `preview:${project.id}:thumbnail:${capturedAt}`
        );
      } catch (error) {
        app.log.warn({ err: error, projectId }, "preview thumbnail capture failed");
        // A failed capture must never remove the last successful thumbnail.
      }
    })().finally(() => {
      if (thumbnailCaptures.get(projectId) === capture) {
        thumbnailCaptures.delete(projectId);
      }
    });
    thumbnailCaptures.set(projectId, capture);
    return capture;
  };
  const unsubscribePreview = previews.onState((state) => {
    if (!store.getProject(state.projectId)) return;
    const updated = store.updatePreview(state.projectId, state);
    hub.publish(
      state.projectId,
      "preview",
      updated,
      `preview:${state.projectId}:${state.previewStatus}`
    );
    if (state.previewStatus === "ready" && state.previewUrl) {
      void captureThumbnail(state.projectId, state.previewUrl);
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    const projectId = previews.projectIdFromHostname(request.hostname);
    if (!projectId) return;
    const project = store.getProject(projectId);
    const target = previews.target(projectId);
    if (
      !project ||
      project.previewStatus !== "ready" ||
      project.previewUrl === null ||
      !target
    ) {
      return reply.status(503).type("text/plain").send("Preview unavailable");
    }
    proxyPreviewRequest(request, reply, target, config.publicDomain);
    return reply;
  });
  app.addHook("onClose", async () => {
    for (const timer of previewStopTimers.values()) clearTimeout(timer);
    previewStopTimers.clear();
    clearInterval(pendingUploadCleanupTimer);
    unsubscribeWorkflowNotifications();
    unsubscribePreview();
    await previews.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StoreError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        }
      });
    }
    if (error instanceof VersionControlError) {
      return reply.status(409).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ReleaseValidationError) {
      return reply.status(409).send({
        error: { code: error.code, message: error.message, evidence: error.evidence }
      });
    }
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    ) {
      const code = "code" in error && typeof error.code === "string" ? error.code : "bad_request";
      const message = "message" in error && typeof error.message === "string" ? error.message : "请求无效";
      return reply.status(error.statusCode).send({
        error: { code, message }
      });
    }
    app.log.error(error);
    return reply.status(500).send({
      error: { code: "internal_error", message: error instanceof Error ? error.message : "服务异常" }
    });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get<{ Querystring: { domain?: string } }>(
    "/api/preview-domain-check",
    async (request, reply) => {
      const projectId = previews.projectIdFromHostname(request.query.domain ?? "");
      const project = projectId ? store.getProject(projectId) : null;
      if (!project?.previewCapable) return reply.status(404).send("Not found");
      return reply.send("Allowed");
    }
  );

  app.post<{ Params: GuestParams }>(
    "/api/guests/:guestId/uploads",
    async (request, reply) => {
      if (!store.getGuest(request.params.guestId)) {
        throw new StoreError("guest_not_found", "游客不存在", 404);
      }
      const part = await request.file();
      if (!part) throw new StoreError("image_required", "请选择图片");
      const buffer = await part.toBuffer();
      const validation = validateImage({ type: part.mimetype, size: buffer.byteLength });
      if (!validation.valid) throw new StoreError(validation.code, validation.message);
      const id = crypto.randomUUID();
      const uploadRoot = join(config.workspaceRoot, "_uploads", request.params.guestId);
      await mkdir(uploadRoot, { recursive: true });
      const extension = part.mimetype === "image/png" ? ".png" : ".jpg";
      const storagePath = join(uploadRoot, `${id}${extension}`);
      await writeFile(storagePath, buffer, { flag: "wx" });
      const upload = store.createPendingUpload({
        id,
        guestId: request.params.guestId,
        originalName: part.filename || `image${extension}`,
        mimeType: part.mimetype,
        size: buffer.byteLength,
        storagePath
      });
      return reply.status(201).send({
        id: upload.id,
        originalName: upload.originalName,
        mimeType: upload.mimeType,
        size: upload.size
      });
    }
  );

  app.delete<{ Params: GuestParams & { uploadId: string } }>(
    "/api/guests/:guestId/uploads/:uploadId",
    async (request, reply) => {
      if (!store.getGuest(request.params.guestId)) {
        throw new StoreError("guest_not_found", "游客不存在", 404);
      }
      const upload = store.deletePendingUpload(
        request.params.guestId,
        request.params.uploadId
      );
      await rm(upload.storagePath, { force: true });
      return reply.status(204).send();
    }
  );

  app.get("/api/guests", async () => ({ items: store.listGuests() }));
  app.post<{ Body: { name?: string } }>("/api/guests", async (request, reply) => {
    const guest = store.createGuest(request.body?.name ?? "");
    return reply.status(201).send(guest);
  });

  app.get<{ Params: GuestParams }>("/api/guests/:guestId/notifications", async (request) => {
    if (!store.getGuest(request.params.guestId)) {
      throw new StoreError("guest_not_found", "游客不存在", 404);
    }
    return { items: store.listNotifications(request.params.guestId) };
  });

  app.get<{ Params: GuestParams; Querystring: { offset?: string } }>(
    "/api/guests/:guestId/projects",
    async (request) => {
      if (!store.getGuest(request.params.guestId)) {
        throw new StoreError("guest_not_found", "游客不存在", 404);
      }
      const offset = Math.max(0, Number(request.query.offset ?? 0) || 0);
      const result = store.listProjects(request.params.guestId, offset);
      return {
        ...result,
        items: result.items.map((project) => ({
          ...project,
          thumbnailUrl:
            project.thumbnailUrl?.includes(`?v=${THUMBNAIL_RENDER_VERSION}-`)
              ? project.thumbnailUrl
              : (
                  project.previewCapable &&
                  (
                    (project.previewStatus === "ready" && project.previewUrl) ||
                    project.previewStatus === "stopped"
                  )
                    ? `/api/guests/${project.guestId}/projects/${project.id}/thumbnail?v=${THUMBNAIL_RENDER_VERSION}-backfill-${encodeURIComponent(project.updatedAt)}`
                    : null
                ),
          activeWorkItem: store.getActiveWorkItem(project.id),
          currentCodeVersion: project.currentCodeVersionId
            ? store.getCodeVersion(project.currentCodeVersionId)
            : null
        }))
      };
    }
  );

  app.post<{
    Params: GuestParams;
    Body: MessageBody & { mode?: WorkItemType; confirmed?: boolean };
  }>(
    "/api/guests/:guestId/projects",
    async (request, reply) => {
      const text = request.body?.text ?? "";
      const validation = validateMessageText(text);
      if (!validation.valid) throw new StoreError(validation.code, validation.message);
      if (
        request.body?.mode === "structured_requirement" &&
        request.body?.confirmed !== true
      ) {
        throw new StoreError(
          "work_item_confirmation_required",
          "创建结构化需求前必须二次确认",
          409
        );
      }
      const images = decodeImages(request.body?.images);
      const created = store.createProjectWithTurn(
        request.params.guestId,
        fallbackProjectName(text),
        text,
        request.body?.mode === "structured_requirement"
          ? "structured_requirement"
          : "direct_coding"
      );
      try {
        const paths = await ensureProjectPaths(config, request.params.guestId, created.project.id);
        const baseCommit = await versions.initialize(paths.repositoryRoot, paths.projectRoot);
        await versions.createWorkBranch(
          paths.repositoryRoot,
          paths.projectRoot,
          created.workItem.branchRef,
          baseCommit
        );
        created.workItem = store.setWorkItemBase(created.workItem.id, baseCommit);
        created.turn = await persistAttachments(
          config,
          store,
          request.params.guestId,
          created.project.id,
          created.turn.id,
          images
        );
        created.turn = await persistUploadedAttachments(
          config,
          store,
          request.params.guestId,
          created.project.id,
          created.turn.id,
          request.body?.uploadIds
        );
      } catch (error) {
        store.deleteProject(created.project.id);
        const paths = await ensureProjectPaths(config, request.params.guestId, created.project.id);
        await Promise.all([
          rm(paths.projectRoot, { recursive: true, force: true }),
          rm(paths.sessionRoot, { recursive: true, force: true }),
          rm(paths.attachmentRoot, { recursive: true, force: true }),
          rm(paths.repositoryRoot, { recursive: true, force: true })
        ]);
        throw error;
      }
      runner.kick(created.project.id);
      return reply.status(201).send(created);
    }
  );

  app.get<{ Params: ProjectParams }>("/api/guests/:guestId/projects/:projectId", async (request) => {
    const project = requireProject(store, request.params.guestId, request.params.projectId);
    const activeWorkItem = store.getActiveWorkItem(project.id);
    return {
      project,
      activeWorkItem,
      workItemEvents: activeWorkItem ? store.listWorkItemEvents(activeWorkItem.id) : [],
      currentCodeVersion: project.currentCodeVersionId
        ? store.getCodeVersion(project.currentCodeVersionId)
        : null,
      turns: store.listTimelineTurns(project.id)
    };
  });

  app.get<{ Params: ProjectParams }>(
    "/api/guests/:guestId/projects/:projectId/thumbnail",
    async (request, reply) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      try {
        let image: Buffer;
        try {
          image = await readFile(join(paths.attachmentRoot, THUMBNAIL_FILENAME));
        } catch {
          let previewUrl = project.previewUrl;
          let stopAfterCapture = false;
          if (
            project.previewCapable &&
            project.previewStatus === "stopped"
          ) {
            const refreshed = await previews.refresh(project.id, paths.projectRoot);
            previewUrl = refreshed.previewUrl;
            stopAfterCapture = refreshed.previewStatus === "ready";
          }
          if (!previewUrl) {
            throw new Error("thumbnail unavailable");
          }
          try {
            await captureThumbnail(project.id, previewUrl);
            image = await readFile(join(paths.attachmentRoot, THUMBNAIL_FILENAME));
          } finally {
            if (stopAfterCapture) await previews.stop(project.id);
          }
        }
        return reply
          .header("cache-control", "private, max-age=31536000, immutable")
          .type("image/png")
          .send(image);
      } catch {
        return reply.status(404).send({
          error: { code: "thumbnail_not_found", message: "暂无预览缩略图" }
        });
      }
    }
  );

  app.get<{ Params: WorkItemParams }>(
    "/api/guests/:guestId/projects/:projectId/work-items/:workItemId/events",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const item = store.getWorkItem(request.params.workItemId);
      if (!item || item.projectId !== project.id) {
        throw new StoreError("work_item_not_found", "工作记录不存在", 404);
      }
      return { items: store.listWorkItemEvents(item.id) };
    }
  );

  app.get<{ Params: ProjectParams; Querystring: { offset?: string } }>(
    "/api/guests/:guestId/projects/:projectId/work-items",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      return store.listWorkItems(project.id, Math.max(0, Number(request.query.offset ?? 0) || 0));
    }
  );

  app.get<{ Params: WorkItemParams; Querystring: { before?: string } }>(
    "/api/guests/:guestId/projects/:projectId/work-items/:workItemId",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const workItem = store.getWorkItem(request.params.workItemId);
      if (!workItem || workItem.projectId !== project.id) {
        throw new StoreError("work_item_not_found", "工作记录不存在", 404);
      }
      return {
        workItem,
        events: store.listWorkItemEvents(workItem.id),
        turns: store.listTurns(
          project.id,
          request.query.before === undefined
            ? undefined
            : Math.max(1, Number(request.query.before) || 1),
          50,
          workItem.id
        )
      };
    }
  );

  app.patch<{
    Params: WorkItemParams;
    Body: { title?: string; revision?: number };
  }>(
    "/api/guests/:guestId/projects/:projectId/work-items/:workItemId",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const item = store.getWorkItem(request.params.workItemId);
      if (!item || item.projectId !== project.id || item.archivedAt) {
        throw new StoreError("work_item_not_found", "工作项不存在或已归档", 404);
      }
      if (!Number.isInteger(request.body?.revision)) {
        throw new StoreError("revision_required", "缺少有效的工作项修订号");
      }
      const updated = store.updateWorkItemTitle(
        item.id,
        request.body?.title ?? "",
        request.body.revision!
      );
      hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
      return updated;
    }
  );

  app.post<{
    Params: ProjectParams;
    Body: {
      text?: string;
      type?: WorkItemType;
      uploadIds?: string[];
      source?: "button" | "natural_language";
      confirmed?: boolean;
    };
  }>(
    "/api/guests/:guestId/projects/:projectId/work-items",
    async (request, reply) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const text = request.body?.text ?? "";
      const validation = validateMessageText(text);
      if (!validation.valid) throw new StoreError(validation.code, validation.message);
      const type =
        request.body?.type === "structured_requirement"
          ? "structured_requirement"
          : "direct_coding";
      if (type === "structured_requirement" && request.body?.confirmed !== true) {
        throw new StoreError(
          "work_item_confirmation_required",
          "创建结构化需求前必须二次确认",
          409
        );
      }
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const baseCommit = await versions.currentMain(paths.repositoryRoot, paths.projectRoot);
      if (
        type === "structured_requirement" &&
        (
          await versions.workingChanges(
            paths.repositoryRoot,
            paths.projectRoot,
            baseCommit
          )
        ).length > 0
      ) {
        throw new StoreError(
          "workspace_not_at_formal_version",
          "开始结构化需求前必须先发布或放弃未发布改动",
          409
        );
      }
      const workItem = store.createWorkItem(
        project.id,
        type,
        fallbackProjectName(text),
        baseCommit,
        request.body?.source ?? "button"
      );
      try {
        await versions.createWorkBranch(
          paths.repositoryRoot,
          paths.projectRoot,
          workItem.branchRef,
          baseCommit
        );
      } catch (error) {
        store.archiveWorkItem(workItem.id, "abandoned");
        throw error;
      }
      let turn = store.enqueueTurn(project.id, text);
      try {
        turn = await persistUploadedAttachments(
          config,
          store,
          project.guestId,
          project.id,
          turn.id,
          request.body?.uploadIds
        );
      } catch (error) {
        store.deleteQueuedTurn(turn.id);
        store.archiveWorkItem(workItem.id, "abandoned");
        await versions.abandon(
          paths.repositoryRoot,
          paths.projectRoot,
          workItem.branchRef,
          false
        );
        throw error;
      }
      hub.publish(project.id, "work_item_updated", workItem, `work:${workItem.id}`);
      hub.publish(project.id, "turn_created", turn, turn.id);
      runner.kick(project.id);
      return reply.status(201).send({ workItem, turn });
    }
  );

  app.post<{
    Params: WorkItemParams;
    Body: {
      action?: string;
      targetState?: WorkflowState;
      title?: string;
      summary?: string;
      reason?: string;
      confirmed?: boolean;
      source?: "button" | "natural_language";
      revision?: number;
      idempotencyKey?: string;
    };
  }>(
    "/api/guests/:guestId/projects/:projectId/work-items/:workItemId/actions",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const item = store.getWorkItem(request.params.workItemId);
      if (!item || item.projectId !== project.id || item.archivedAt) {
        throw new StoreError("work_item_not_found", "工作项不存在", 404);
      }
      const action = request.body?.action ?? "";
      const dangerous = new Set([
        "confirm_requirements",
        "confirm_technical",
        "publish",
        "return_to_stage",
        "abandon",
        "discard"
      ]);
      const mutating = new Set([
        ...dangerous,
        "start_testing",
        "ready_release",
        "continue_execution"
      ]);
      const stageLabels: Partial<Record<WorkflowState, string>> = {
        requirements_discussion: "需求讨论",
        requirements_pending_confirmation: "需求待确认",
        technical_design: "技术方案",
        technical_pending_confirmation: "技术方案待确认",
        development: "开发",
        testing_admission: "测试准入",
        testing: "测试",
        pending_release: "待上线",
        direct_coding: "直接编码",
        published: "已发布",
        abandoned: "已放弃"
      };
      const actionLabels: Record<string, string> = {
        confirm_requirements: "确认需求",
        confirm_technical: "确认方案并开始开发",
        start_testing: "开始测试",
        ready_release: "完成测试并进入待上线",
        publish: item.type === "structured_requirement" ? "确认上线" : "发布代码版本",
        return_to_stage: "退回阶段",
        abandon: "放弃当前工作",
        discard: "放弃未发布改动",
        continue_execution: "继续执行"
      };
      const exactActionStages: Partial<Record<string, WorkflowState[]>> = {
        confirm_requirements: ["requirements_discussion"],
        confirm_technical: ["technical_pending_confirmation"],
        start_testing: ["development"],
        ready_release: ["testing"],
        publish:
          item.type === "structured_requirement"
            ? ["pending_release"]
            : ["direct_coding"]
      };
      const invalidActionStageError = (requestedAction: string) => {
        const allowedStates = exactActionStages[requestedAction] ?? [];
        const actionLabel = actionLabels[requestedAction] ?? "执行该操作";
        const currentStateLabel =
          stageLabels[item.workflowState] ?? item.workflowState;
        const allowedStateLabels = allowedStates.map(
          (state) => stageLabels[state] ?? state
        );
        const allowedCopy = allowedStateLabels.map((label) => `「${label}」`).join("、");
        const guidance = allowedStateLabels.length
          ? `请先完成当前「${currentStateLabel}」阶段，并在进入${allowedCopy}后重试。`
          : "请使用当前工作流栏中提供的操作继续。";
        return new StoreError(
          "invalid_transition",
          `无法${actionLabel}：当前处于「${currentStateLabel}」，该操作仅可在${allowedCopy || "指定阶段"}执行。`,
          409,
          {
            kind: "workflow_transition",
            action: requestedAction,
            actionLabel,
            currentState: item.workflowState,
            currentStateLabel,
            allowedStates,
            allowedStateLabels,
            guidance
          }
        );
      };
      if (
        action === "continue_execution" &&
        !["stopped", "failed"].includes(item.executionState)
      ) {
        const executionStateLabel = {
          running: "执行中",
          stopped: "已停止",
          failed: "执行失败",
          idle: "空闲"
        }[item.executionState];
        throw new StoreError(
          "invalid_transition",
          `无法继续执行：当前执行状态为「${executionStateLabel}」，没有可恢复的中断任务。`,
          409,
          {
            kind: "workflow_transition",
            action,
            actionLabel: "继续执行",
            currentState: item.workflowState,
            currentStateLabel: stageLabels[item.workflowState] ?? item.workflowState,
            executionState: item.executionState,
            executionStateLabel,
            guidance:
              item.executionState === "running"
                ? "当前任务仍在运行，请等待完成或先停止任务。"
                : "请使用当前工作流栏显示的主操作继续。"
          }
        );
      }
      if (
        request.body?.confirmed !== true &&
        exactActionStages[action] &&
        !exactActionStages[action]!.includes(item.workflowState)
      ) {
        throw invalidActionStageError(action);
      }
      if (mutating.has(action)) {
        if (
          !Number.isInteger(request.body?.revision) ||
          typeof request.body?.idempotencyKey !== "string" ||
          request.body.idempotencyKey.length < 8 ||
          request.body.idempotencyKey.length > 200
        ) {
          throw new StoreError(
            "action_context_required",
            "工作流操作缺少有效的 revision 或幂等键",
            400
          );
        }
        if (
          dangerous.has(action) &&
          request.body?.confirmed !== true &&
          request.body.revision !== item.revision
        ) {
          throw new StoreError("revision_conflict", "工作项已更新，请基于最新状态重试", 409);
        }
      }
      if (dangerous.has(action) && request.body?.confirmed !== true) {
        let releaseMetadata: Awaited<ReturnType<ReleaseMetadataGenerator>> | null = null;
        if (action === "publish") {
          const paths = await ensureProjectPaths(config, project.guestId, project.id);
          const cumulativeChanges = await versions.workingChanges(
            paths.repositoryRoot,
            paths.projectRoot,
            item.baseCommit
          );
          releaseMetadata = await releaseMetadataGenerator(
            item,
            store.listTimelineTurns(project.id, undefined, 50, item.id).items,
            cumulativeChanges
              .map(({ status, path, previousPath }) =>
                `${status}: ${previousPath ? `${previousPath} -> ` : ""}${path}`
              )
              .join("\n")
          );
        }
        const returnTarget = request.body?.targetState;
        return {
          confirmationRequired: true,
          action,
          targetState: returnTarget,
          ...(action === "publish"
            ? {
                suggestedTitle: releaseMetadata!.title,
                suggestedSummary: releaseMetadata!.summary
              }
            : {}),
          message:
            action === "publish"
              ? "将创建不可变正式代码版本"
              : action === "abandon" || action === "discard"
                ? "当前工作将结束"
                : action === "return_to_stage" && returnTarget
                  ? `将从「${stageLabels[item.workflowState] ?? item.workflowState}」退回到「${stageLabels[returnTarget] ?? returnTarget}」阶段`
                : "工作项阶段和文档权限将发生变化"
        };
      }
      if (
        (action === "return_to_stage" || action === "abandon" || action === "discard") &&
        !request.body?.reason?.trim()
      ) {
        throw new StoreError(
          action === "return_to_stage"
            ? "transition_reason_required"
            : "abandon_reason_required",
          action === "return_to_stage" ? "请填写退回原因" : "请填写放弃原因"
        );
      }
      if (
        mutating.has(action) &&
        store.hasWorkflowActionKey(request.body.idempotencyKey!)
      ) {
        throw new StoreError(
          "action_already_processed",
          "该确认操作已经处理，请勿重复提交",
          409
        );
      }
      if (mutating.has(action) && request.body.revision !== item.revision) {
        throw new StoreError("revision_conflict", "工作项已更新，请基于最新状态重试", 409);
      }
      if (
        exactActionStages[action] &&
        !exactActionStages[action]!.includes(item.workflowState)
      ) {
        throw invalidActionStageError(action);
      }
      if (action !== "continue_execution" && store.hasOpenTurns(item.id)) {
        const actionLabel = actionLabels[action] ?? "流转";
        throw new StoreError(
          "work_item_busy",
          `无法${actionLabel}：当前仍有运行中或排队消息。`,
          409,
          {
            kind: "workflow_transition",
            action,
            actionLabel,
            currentState: item.workflowState,
            currentStateLabel: stageLabels[item.workflowState] ?? item.workflowState,
            guidance: "请等待消息处理完成；如需中断运行任务，请先停止，再处理剩余队列。"
          }
        );
      }
      if (
        mutating.has(action) &&
        action !== "continue_execution" &&
        item.executionState !== "idle"
      ) {
        const actionLabel = actionLabels[action] ?? "流转";
        const executionLabel = {
          running: "执行中",
          stopped: "已停止",
          failed: "执行失败",
          idle: "空闲"
        }[item.executionState];
        throw new StoreError(
          "work_item_execution_paused",
          `无法${actionLabel}：当前执行状态为「${executionLabel}」。`,
          409,
          {
            kind: "workflow_transition",
            action,
            actionLabel,
            currentState: item.workflowState,
            currentStateLabel: stageLabels[item.workflowState] ?? item.workflowState,
            executionState: item.executionState,
            executionStateLabel: executionLabel,
            guidance:
              item.executionState === "running"
                ? "请等待当前执行结束；如需中断，请先停止任务。"
                : "请先点击“重新执行”完成当前阶段，再尝试流转。"
          }
        );
      }
      if (mutating.has(action)) {
        store.reserveWorkflowAction({
          workItemId: item.id,
          action,
          revision: request.body.revision!,
          idempotencyKey: request.body.idempotencyKey!,
          source: request.body?.source ?? "button",
          actorGuestId: project.guestId
        });
        store.addWorkItemEvent(
          item.id,
          action === "publish" ? "publish_attempt" : "confirmed_action",
          request.body?.source ?? "button",
          item.workflowState,
          item.workflowState,
          project.guestId,
          {
            action,
            reason: request.body?.reason?.trim(),
            targetState: request.body?.targetState
          },
          `audit:${request.body.idempotencyKey}`
        );
      }
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const source = request.body?.source ?? "button";
      const finalizeRequirements = async () => {
        const current = store.getWorkItem(item.id);
        if (!current || current.archivedAt) {
          throw new StoreError("work_item_not_found", "工作项不存在", 404);
        }
        try {
          await validateRequirementPackage(paths.projectRoot, current.requirementSequence);
        } catch (error) {
          if (!(error instanceof WorkflowDocumentError)) throw error;
          const pending = store.transitionWorkItem(
            current.id,
            "requirements_pending_confirmation",
            source,
            project.guestId
          );
          const completionTurn = store.enqueueTurn(
            project.id,
            "当前编号需求包尚未完整落盘。只补全这一套需求文档，将未单独回答的事项采用此前推荐方案或合理默认值；不要重新访谈，也不要创建重复目录。"
          );
          hub.publish(project.id, "work_item_updated", pending, `work:${pending.id}:${pending.revision}`);
          hub.publish(project.id, "turn_created", completionTurn, completionTurn.id);
          runner.kick(project.id);
          return { workItem: pending, turn: completionTurn };
        }
        const requirementsCheckpoint = await versions.checkpoint(
          paths.repositoryRoot,
          paths.projectRoot,
          current.branchRef,
          "Confirm requirements"
        );
        store.addWorkItemEvent(
          current.id,
          "checkpoint",
          "system",
          current.workflowState,
          current.workflowState,
          project.guestId,
          { name: "Confirm requirements", commitSha: requirementsCheckpoint.commitSha }
        );
        const updated = store.transitionWorkItem(
          current.id,
          "technical_design",
          source,
          project.guestId
        );
        const turn = store.enqueueTurn(
          project.id,
          "需求已经确认；未单独回答的事项采用需求文档中的推荐默认方案。探索当前代码并生成完整技术方案。"
        );
        hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
        hub.publish(project.id, "turn_created", turn, turn.id);
        runner.kick(project.id);
        return { workItem: updated, turn };
      };
      if (action === "continue_execution") {
        if (!["stopped", "failed"].includes(item.executionState)) {
          throw new StoreError("invalid_transition", "当前工作无需重试", 409);
        }
        if (item.workflowState === "requirements_pending_confirmation") {
          return finalizeRequirements();
        }
        const updated = store.setWorkItemExecution(item.id, "idle");
        const turn = store.enqueueTurn(
          project.id,
          "人工恢复执行：先检查当前工作区、相对基线 Diff、待办状态和最近检查点，再从中断处完成当前阶段；不要清除已有代码。若无法安全判断，只询问一个具体问题。",
          { priority: 2, bypassQueueLimit: true }
        );
        hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
        hub.publish(project.id, "turn_created", turn, turn.id);
        runner.kick(project.id);
        return { workItem: updated, turn };
      }
      if (action === "confirm_requirements") {
        if (item.workflowState !== "requirements_discussion") {
          throw new StoreError("invalid_transition", "当前阶段不能确认需求", 409);
        }
        return finalizeRequirements();
      }
      if (action === "confirm_technical") {
        if (item.workflowState !== "technical_pending_confirmation") {
          throw new StoreError("invalid_transition", "当前阶段不能开始开发", 409);
        }
        try {
          await validateTechnicalDesign(paths.projectRoot, item.requirementSequence);
        } catch (error) {
          asWorkflowConflict(error);
        }
        const technicalCheckpoint = await versions.checkpoint(
          paths.repositoryRoot,
          paths.projectRoot,
          item.branchRef,
          "Confirm technical design"
        );
        store.addWorkItemEvent(item.id, "checkpoint", "system", item.workflowState, item.workflowState, project.guestId, {
          name: "Confirm technical design",
          commitSha: technicalCheckpoint.commitSha
        });
        const updated = store.transitionWorkItem(
          item.id,
          "development",
          source,
          project.guestId
        );
        const turn = store.enqueueTurn(project.id, "按照已确认的需求和技术方案开始开发。");
        hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
        hub.publish(project.id, "turn_created", turn, turn.id);
        runner.kick(project.id);
        return { workItem: updated, turn };
      }
      if (action === "start_testing") {
        if (item.workflowState !== "development") {
          throw new StoreError("invalid_transition", "当前阶段不能开始测试", 409);
        }
        const implementationCheckpoint = await versions.checkpoint(
          paths.repositoryRoot,
          paths.projectRoot,
          item.branchRef,
          "Implementation complete"
        );
        store.addWorkItemEvent(item.id, "checkpoint", "system", item.workflowState, item.workflowState, project.guestId, {
          name: "Implementation complete",
          commitSha: implementationCheckpoint.commitSha
        });
        const updated = store.transitionWorkItem(
          item.id,
          "testing_admission",
          source,
          project.guestId
        );
        const turn = store.enqueueTurn(
          project.id,
          "执行测试阶段准入检查；发现问题时先向用户说明，再自动修复并重新检查。"
        );
        hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
        hub.publish(project.id, "turn_created", turn, turn.id);
        runner.kick(project.id);
        return { workItem: updated, turn };
      }
      if (action === "ready_release") {
        if (item.workflowState !== "testing") {
          throw new StoreError("invalid_transition", "当前阶段不能进入待上线", 409);
        }
        if (project.previewCapable) {
          if (project.previewStatus !== "ready" || !project.previewUrl) {
            throw new StoreError(
              "ui_preview_not_ready",
              "界面项目必须先通过候选预览，才能生成桌面与移动测试证据",
              409
            );
          }
          const sequence = `R${String(item.requirementSequence ?? 0).padStart(3, "0")}`;
          const evidenceRoot = join(
            paths.projectRoot,
            "docs",
            "test-reports",
            `${sequence}-assets`
          );
          await mkdir(evidenceRoot, { recursive: true });
          const entryUrl = previewEntryUrl(project.previewUrl);
          const desktop = await thumbnailer.capture(paths.projectRoot, entryUrl, {
            width: 1440,
            height: 900,
            outputName: "ui-desktop.png"
          });
          const mobile = await thumbnailer.capture(paths.projectRoot, entryUrl, {
            width: 390,
            height: 844,
            outputName: "ui-mobile.png"
          });
          await Promise.all([
            writeFile(join(evidenceRoot, "ui-desktop.png"), desktop),
            writeFile(join(evidenceRoot, "ui-mobile.png"), mobile)
          ]);
          try {
            await recordUiEvidence(paths.projectRoot, item.requirementSequence, {
              desktop: `./${sequence}-assets/ui-desktop.png`,
              mobile: `./${sequence}-assets/ui-mobile.png`
            });
          } catch (error) {
            asWorkflowConflict(error);
          }
        }
        try {
          await validateTestReport(
            paths.projectRoot,
            item.requirementSequence,
            project.previewCapable
          );
        } catch (error) {
          asWorkflowConflict(error);
        }
        const testsCheckpoint = await versions.checkpoint(
          paths.repositoryRoot,
          paths.projectRoot,
          item.branchRef,
          "Tests passed"
        );
        store.addWorkItemEvent(item.id, "checkpoint", "system", item.workflowState, item.workflowState, project.guestId, {
          name: "Tests passed",
          commitSha: testsCheckpoint.commitSha
        });
        const updated = store.transitionWorkItem(
          item.id,
          "pending_release",
          source,
          project.guestId
        );
        hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
        return { workItem: updated };
      }
      if (action === "return_to_stage") {
        const target = request.body?.targetState;
        const reason = request.body?.reason?.trim();
        const allowed: Record<string, WorkflowState[]> = {
          technical_design: ["requirements_discussion"],
          technical_pending_confirmation: ["requirements_discussion"],
          development: ["technical_design", "requirements_discussion"],
          testing_admission: [
            "development",
            "requirements_discussion",
            "technical_design"
          ],
          testing: [
            "development",
            "requirements_discussion",
            "technical_design"
          ],
          pending_release: ["testing", "development", "technical_design"]
        };
        if (!target || !allowed[item.workflowState]?.includes(target)) {
          const currentStateLabel =
            stageLabels[item.workflowState] ?? item.workflowState;
          const targetStateLabel = target
            ? stageLabels[target] ?? target
            : "未指定阶段";
          const allowedStateLabels = (allowed[item.workflowState] ?? []).map(
            (state) => stageLabels[state] ?? state
          );
          throw new StoreError(
            "invalid_transition",
            `无法退回：当前「${currentStateLabel}」不能退回到「${targetStateLabel}」。`,
            409,
            {
              kind: "workflow_transition",
              action: "return_to_stage",
              actionLabel: "退回阶段",
              currentState: item.workflowState,
              currentStateLabel,
              targetState: target,
              targetStateLabel,
              allowedStates: allowed[item.workflowState] ?? [],
              allowedStateLabels,
              guidance: allowedStateLabels.length
                ? `当前阶段仅可退回到：${allowedStateLabels.map((label) => `「${label}」`).join("、")}。`
                : "当前阶段不能退回，请继续完成或放弃当前工作。"
            }
          );
        }
        const updated = store.transitionWorkItem(
          item.id,
          target,
          source,
          project.guestId,
          { reason }
        );
        hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
        return { workItem: updated };
      }
      if (action === "abandon" || action === "discard") {
        const reason = request.body?.reason?.trim();
        let snapshotCommit: string | undefined;
        if (item.type === "structured_requirement") {
          snapshotCommit = (
            await versions.checkpoint(
              paths.repositoryRoot,
              paths.projectRoot,
              item.branchRef,
              "Abandoned work snapshot"
            )
          ).commitSha;
          store.addWorkItemEvent(item.id, "checkpoint", "system", item.workflowState, item.workflowState, project.guestId, {
            name: "Abandoned work snapshot",
            commitSha: snapshotCommit
          });
        }
        await versions.abandon(
          paths.repositoryRoot,
          paths.projectRoot,
          item.branchRef,
          item.type === "structured_requirement"
        );
        const updated = store.archiveWorkItem(
          item.id,
          "abandoned",
          source,
          project.guestId,
          { reason, snapshotCommit }
        );
        hub.publish(project.id, "work_item_updated", updated, `work:${updated.id}:${updated.revision}`);
        return { workItem: updated };
      }
      if (action === "publish") {
        if (item.type === "structured_requirement" && item.workflowState !== "pending_release") {
          throw new StoreError("invalid_transition", "需求尚未达到待上线阶段", 409);
        }
        const cumulativeChanges = await versions.workingChanges(
          paths.repositoryRoot,
          paths.projectRoot,
          item.baseCommit
        );
        if (item.type === "direct_coding" && cumulativeChanges.length === 0) {
          throw new StoreError(
            "release_candidate_unchanged",
            "当前直接编码工作没有相对正式基线的累计改动",
            409
          );
        }
        const sequence = store.nextCodeVersionSequence(project.id);
        const title = request.body?.title?.trim() || item.title;
        const summary =
          request.body?.summary?.trim() ||
          (item.type === "structured_requirement"
            ? `发布需求 R${String(item.requirementSequence ?? 0).padStart(3, "0")}：${item.title}`
            : `发布当前直接编码工作的累计改动：${item.title}`);
        const validating = store.setWorkItemExecution(item.id, "running");
        hub.publish(
          project.id,
          "work_item_updated",
          validating,
          `work:${validating.id}:${validating.revision}`
        );
        let validation: ReleaseValidationReport;
        try {
          validation = await releaseValidator({
            projectId: project.id,
            projectRoot: paths.projectRoot,
            refreshPreview: (projectId, projectRoot) =>
              previews.refresh(projectId, projectRoot)
          });
        } catch (error) {
          store.addWorkItemEvent(
            item.id,
            "publish_failed",
            "system",
            item.workflowState,
            item.workflowState,
            project.guestId,
            { error: error instanceof Error ? error.message : "发布前门禁失败" }
          );
          const updated = store.setWorkItemExecution(
            item.id,
            "idle",
            error instanceof Error ? error.message : "发布前门禁失败"
          );
          hub.publish(
            project.id,
            "work_item_updated",
            updated,
            `work:${updated.id}:${updated.revision}`
          );
          throw error;
        }
        let published: Awaited<ReturnType<VersionControl["publish"]>>;
        try {
          const candidate = await versions.checkpoint(
            paths.repositoryRoot,
            paths.projectRoot,
            item.branchRef,
            "Release validation passed"
          );
          store.addWorkItemEvent(
            item.id,
            "checkpoint",
            "system",
            item.workflowState,
            item.workflowState,
            project.guestId,
            { name: "Release validation passed", commitSha: candidate.commitSha }
          );
          const releaseRoot = join(paths.projectRoot, "docs", "releases");
          await mkdir(releaseRoot, { recursive: true });
          await writeFile(
            join(releaseRoot, `V${sequence}.md`),
            [
            `# V${sequence} · ${title}`,
            "",
            summary || "本版本由当前工作项发布。",
            "",
            `- 来源：${item.type === "structured_requirement" ? "结构化需求" : "直接编码"}`,
            `- 工作项：${item.id}`,
            `- 需求：${item.requirementSequence ? `R${String(item.requirementSequence).padStart(3, "0")}` : "不适用（直接编码）"}`,
            `- 基线提交：${item.baseCommit || "项目初始基线"}`,
            `- 候选提交：${candidate.commitSha}`,
            `- Git tag：code/v${sequence}`,
            `- 确认身份：${project.guestId}`,
            `- 确认时间：${validation.validatedAt}`,
            `- 对话范围：工作项 ${item.id} 的全部累计对话`,
            `- 变化摘要：${summary}`,
            "- 累计 Diff：",
            ...cumulativeChanges.map(
              ({ status, path, previousPath }) =>
                `  - ${status}：${previousPath ? `${previousPath} → ` : ""}${path}`
            ),
            `- 需求文档：${item.requirementSequence ? `docs/requirements/R${String(item.requirementSequence).padStart(3, "0")}-*/` : "不适用"}`,
            `- 技术方案：${item.requirementSequence ? `docs/technical/R${String(item.requirementSequence).padStart(3, "0")}-*.md` : "不适用"}`,
            `- 测试与构建：${validation.checks
              .filter(({ id }) => ["test", "typecheck", "lint", "build"].includes(id))
              .map(({ id, status }) => `${id}=${status}`)
              .join("；")}`,
            `- 敏感内容检查：${validation.checks.find(({ id }) => id === "sensitive_content")?.evidence ?? "已通过"}`,
            `- 最低文件与配置：${validation.checks.find(({ id }) => id === "candidate_files")?.evidence ?? "已通过"}；${validation.checks.find(({ id }) => id === "configuration")?.evidence ?? "不适用"}`,
            `- 预览：${validation.checks.find(({ id }) => id === "preview")?.evidence ?? "不适用"}`,
            "- 发布结果：成功",
            "- 已知限制：未部署到项目外部生产环境",
            ""
            ].join("\n"),
            "utf8"
          );
          const releaseCandidate = await versions.checkpoint(
            paths.repositoryRoot,
            paths.projectRoot,
            item.branchRef,
            "Release candidate"
          );
          store.addWorkItemEvent(
            item.id,
            "checkpoint",
            "system",
            item.workflowState,
            item.workflowState,
            project.guestId,
            { name: "Release candidate", commitSha: releaseCandidate.commitSha }
          );
          published = await versions.publish(
            paths.repositoryRoot,
            paths.projectRoot,
            item.branchRef,
            sequence,
            title
          );
        } catch (error) {
          store.addWorkItemEvent(
            item.id,
            "publish_failed",
            "system",
            item.workflowState,
            item.workflowState,
            project.guestId,
            { error: error instanceof Error ? error.message : "发布事务失败" }
          );
          const updated = store.setWorkItemExecution(
            item.id,
            "idle",
            error instanceof Error ? error.message : "发布事务失败"
          );
          hub.publish(
            project.id,
            "work_item_updated",
            updated,
            `work:${updated.id}:${updated.revision}`
          );
          throw error;
        }
        let version;
        try {
          const formalPreview = await previews.refresh(project.id, paths.projectRoot);
          if (formalPreview.previewCapable && formalPreview.previewStatus !== "ready") {
            throw new ReleaseValidationError(
              "formal_preview_unavailable",
              "正式版本预览切换失败",
              formalPreview.previewError ?? "正式预览未就绪"
            );
          }
          version = store.publishCodeVersion({
            workItemId: item.id,
            title,
            summary,
            commitSha: published.commitSha,
            tagRef: published.tagRef
          });
        } catch (error) {
          await versions.rollbackPublish(
            paths.repositoryRoot,
            paths.projectRoot,
            item.branchRef,
            published.tagRef,
            published.previousMain,
            published.branchCommit
          );
          store.addWorkItemEvent(
            item.id,
            "publish_failed",
            "system",
            item.workflowState,
            item.workflowState,
            project.guestId,
            { error: error instanceof Error ? error.message : "发布事务失败" }
          );
          const updated = store.setWorkItemExecution(
            item.id,
            "idle",
            error instanceof Error ? error.message : "发布事务失败"
          );
          hub.publish(
            project.id,
            "work_item_updated",
            updated,
            `work:${updated.id}:${updated.revision}`
          );
          throw error;
        }
        hub.publish(project.id, "version_published", version, `version:${version.id}`);
        return { version, workItem: store.getWorkItem(item.id) };
      }
      throw new StoreError("action_unknown", "不支持的工作项操作", 400);
    }
  );

  app.get<{ Params: ProjectParams; Querystring: { offset?: string } }>(
    "/api/guests/:guestId/projects/:projectId/versions",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      return store.listCodeVersions(
        project.id,
        Math.max(0, Number(request.query.offset ?? 0) || 0)
      );
    }
  );

  app.get<{ Params: VersionParams }>(
    "/api/guests/:guestId/projects/:projectId/versions/:versionId",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const version = store.getCodeVersion(request.params.versionId);
      if (!version || version.projectId !== project.id) {
        throw new StoreError("version_not_found", "代码版本不存在", 404);
      }
      const workItem = store.getWorkItem(version.workItemId);
      if (!workItem) throw new StoreError("work_item_not_found", "工作记录不存在", 404);
      const baseVersion = version.baseVersionId
        ? store.getCodeVersion(version.baseVersionId)
        : null;
      const baseCommit = baseVersion?.commitSha ?? workItem.baseCommit;
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const [changes, trackedPaths] = await Promise.all([
        versions.changedFiles(
          paths.repositoryRoot,
          paths.projectRoot,
          baseCommit,
          version.commitSha
        ),
        versions.listPaths(paths.repositoryRoot, paths.projectRoot, version.commitSha)
      ]);
      const events = store.listWorkItemEvents(workItem.id);
      const publishAttemptEvent = events.find(({ kind }) => kind === "publish_attempt");
      const publishedEvent = [...events].reverse().find(({ kind }) => kind === "published");
      const documents = {
        requirements: trackedPaths.filter((path) => path.startsWith("docs/requirements/")),
        technical: trackedPaths.filter(
          (path) =>
            path.startsWith("docs/technical/") ||
            path === "docs/technical-decisions.md"
        ),
        tests: trackedPaths.filter((path) => path.startsWith("docs/test-reports/")),
        release: trackedPaths.filter((path) => path === `docs/releases/V${version.sequence}.md`)
      };
      return {
        version,
        workItem,
        baseVersion,
        initiatedGuest: publishAttemptEvent?.actorGuestId
          ? store.getGuest(publishAttemptEvent.actorGuestId)
          : null,
        confirmedGuest: publishedEvent?.actorGuestId
          ? store.getGuest(publishedEvent.actorGuestId)
          : store.getGuest(project.guestId),
        changes,
        fileStats: changes.reduce(
          (counts, change) => ({
            ...counts,
            [change.status]: counts[change.status] + 1
          }),
          { added: 0, modified: 0, deleted: 0, renamed: 0 }
        ),
        documents
      };
    }
  );

  app.get<{ Params: WorkItemParams }>(
    "/api/guests/:guestId/projects/:projectId/work-items/:workItemId/snapshot/files",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const item = store.getWorkItem(request.params.workItemId);
      if (!item || item.projectId !== project.id) {
        throw new StoreError("work_item_not_found", "工作记录不存在", 404);
      }
      if (item.type !== "structured_requirement") {
        throw new StoreError(
          "work_snapshot_unavailable",
          "直接编码工作不保留已清除代码快照",
          409
        );
      }
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const snapshotCommit = await versions.resolveRef(
        paths.repositoryRoot,
        paths.projectRoot,
        item.branchRef
      );
      return {
        items: await versions.listTree(
          paths.repositoryRoot,
          paths.projectRoot,
          snapshotCommit
        )
      };
    }
  );

  app.get<{ Params: WorkItemParams; Querystring: { path?: string } }>(
    "/api/guests/:guestId/projects/:projectId/work-items/:workItemId/snapshot/file",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const item = store.getWorkItem(request.params.workItemId);
      if (!item || item.projectId !== project.id || item.type !== "structured_requirement") {
        throw new StoreError("work_snapshot_unavailable", "工作快照不可用", 409);
      }
      if (!request.query.path) throw new StoreError("file_required", "请选择文件");
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const snapshotCommit = await versions.resolveRef(
        paths.repositoryRoot,
        paths.projectRoot,
        item.branchRef
      );
      return versions.readFileAt(
        paths.repositoryRoot,
        paths.projectRoot,
        snapshotCommit,
        request.query.path
      );
    }
  );

  app.get<{ Params: WorkItemParams }>(
    "/api/guests/:guestId/projects/:projectId/work-items/:workItemId/snapshot/diff",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const item = store.getWorkItem(request.params.workItemId);
      if (
        !item ||
        item.projectId !== project.id ||
        (item.type !== "structured_requirement" && item.workflowState === "abandoned")
      ) {
        throw new StoreError("work_snapshot_unavailable", "工作快照不可用", 409);
      }
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const snapshotCommit = await versions.resolveRef(
        paths.repositoryRoot,
        paths.projectRoot,
        item.branchRef
      );
      return {
        diff: await versions.diff(
          paths.repositoryRoot,
          paths.projectRoot,
          item.baseCommit,
          snapshotCommit
        ),
        changes: await versions.changedFiles(
          paths.repositoryRoot,
          paths.projectRoot,
          item.baseCommit,
          snapshotCommit
        )
      };
    }
  );

  app.get<{ Params: VersionParams }>(
    "/api/guests/:guestId/projects/:projectId/versions/:versionId/files",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const version = store.getCodeVersion(request.params.versionId);
      if (!version || version.projectId !== project.id) {
        throw new StoreError("version_not_found", "代码版本不存在", 404);
      }
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      return {
        items: await versions.listTree(
          paths.repositoryRoot,
          paths.projectRoot,
          version.commitSha
        )
      };
    }
  );

  app.get<{ Params: VersionParams; Querystring: { path?: string } }>(
    "/api/guests/:guestId/projects/:projectId/versions/:versionId/file",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const version = store.getCodeVersion(request.params.versionId);
      if (!version || version.projectId !== project.id) {
        throw new StoreError("version_not_found", "代码版本不存在", 404);
      }
      if (!request.query.path) throw new StoreError("file_required", "请选择文件");
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      return versions.readFileAt(
        paths.repositoryRoot,
        paths.projectRoot,
        version.commitSha,
        request.query.path
      );
    }
  );

  app.get<{ Params: VersionParams; Querystring: { path?: string } }>(
    "/api/guests/:guestId/projects/:projectId/versions/:versionId/diff",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const version = store.getCodeVersion(request.params.versionId);
      if (!version || version.projectId !== project.id) {
        throw new StoreError("version_not_found", "代码版本不存在", 404);
      }
      const workItem = store.getWorkItem(version.workItemId);
      if (!workItem) throw new StoreError("work_item_not_found", "工作记录不存在", 404);
      const base = version.baseVersionId
        ? store.getCodeVersion(version.baseVersionId)?.commitSha ?? workItem.baseCommit
        : workItem.baseCommit;
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      return {
        diff: await versions.diff(
          paths.repositoryRoot,
          paths.projectRoot,
          base,
          version.commitSha,
          request.query.path
        )
      };
    }
  );

  app.get<{
    Params: ProjectParams;
    Querystring: { before?: string };
  }>("/api/guests/:guestId/projects/:projectId/turns", async (request) => {
    const project = requireProject(store, request.params.guestId, request.params.projectId);
    return store.listTimelineTurns(project.id, request.query.before);
  });

  app.post<{ Params: ProjectParams; Body: MessageBody }>(
    "/api/guests/:guestId/projects/:projectId/turns",
    async (request, reply) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const text = request.body?.text ?? "";
      const validation = validateMessageText(text);
      if (!validation.valid) throw new StoreError(validation.code, validation.message);
      const images = decodeImages(request.body?.images);
      let turn = store.enqueueTurn(project.id, text);
      try {
        turn = await persistAttachments(
          config,
          store,
          project.guestId,
          project.id,
          turn.id,
          images
        );
        turn = await persistUploadedAttachments(
          config,
          store,
          project.guestId,
          project.id,
          turn.id,
          request.body?.uploadIds
        );
      } catch {
        store.deleteQueuedTurn(turn.id);
        throw new StoreError("image_processing_failed", "图片处理失败，消息未发送");
      }
      hub.publish(project.id, "turn_created", turn, turn.id);
      runner.kick(project.id);
      return reply.status(202).send(turn);
    }
  );

  app.get<{ Params: GuestParams }>(
    "/ws/guests/:guestId",
    { websocket: true },
    (socket, request) => {
      if (!store.getGuest(request.params.guestId)) {
        socket.close(1008, "游客不存在");
        return;
      }
      const unsubscribe = hub.subscribe(`guest:${request.params.guestId}`, (event) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      });
      socket.on("close", unsubscribe);
      socket.send(JSON.stringify({ connected: true }));
    }
  );

  app.get<{ Params: { projectId: string; "*": string } }>(
    "/preview/:projectId/*",
    async (request, reply) => {
      const project = store.getProject(request.params.projectId);
      if (!project?.previewCapable || project.previewStatus !== "ready") {
        return reply.status(404).send("Preview unavailable");
      }
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const requested = request.params["*"] || "index.html";
      try {
        const safe = await assertInsideProject(paths.projectRoot, requested);
        const raw = await readFile(safe);
        const extension = safe.split(".").pop()?.toLowerCase();
        const data = extension === "html" ? injectPreviewBridge(raw.toString("utf8")) : raw;
        const mime =
          extension === "html"
            ? "text/html; charset=utf-8"
            : extension === "css"
              ? "text/css; charset=utf-8"
              : extension === "js" || extension === "mjs"
                ? "text/javascript; charset=utf-8"
                : extension === "json"
                  ? "application/json; charset=utf-8"
                  : extension === "png"
                    ? "image/png"
                    : extension === "jpg" || extension === "jpeg"
                      ? "image/jpeg"
                      : "application/octet-stream";
        return reply
          .header(
            "content-security-policy",
            "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; connect-src https:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
          )
          // The preview iframe intentionally has an opaque origin because it omits
          // allow-same-origin. Its own CSS, scripts, and images therefore need to
          // be loadable cross-origin even though their URLs share the app host.
          .header("cross-origin-resource-policy", "cross-origin")
          .type(mime)
          .send(data);
      } catch {
        return reply.status(404).send("Not found");
      }
    }
  );

  app.post<{ Params: ProjectParams }>(
    "/api/guests/:guestId/projects/:projectId/preview/retry",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      await previews.refresh(project.id, paths.projectRoot);
      return store.getProject(project.id)!;
    }
  );

  app.get<{ Params: AttachmentParams }>(
    "/api/guests/:guestId/projects/:projectId/turns/:turnId/items/:itemId/attachments/:attachmentId",
    async (request, reply) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const turn = store.getTurn(request.params.turnId);
      if (!turn || turn.projectId !== project.id) {
        throw new StoreError("attachment_not_found", "图片不存在", 404);
      }
      const attachment = store.getAttachmentPath(
        turn.id,
        request.params.itemId,
        request.params.attachmentId
      );
      if (!attachment) throw new StoreError("attachment_not_found", "图片不存在", 404);
      const data = await readFile(attachment.path);
      return reply.type(attachment.mimeType).header("cache-control", "private, max-age=3600").send(data);
    }
  );

  app.delete<{ Params: TurnParams }>(
    "/api/guests/:guestId/projects/:projectId/turns/:turnId/queue",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const turn = store.getTurn(request.params.turnId);
      if (!turn || turn.projectId !== project.id) {
        throw new StoreError("turn_not_found", "任务不存在", 404);
      }
      const cancelled = store.cancelQueuedTurn(turn.id);
      hub.publish(project.id, "turn_completed", cancelled, cancelled.id);
      return cancelled;
    }
  );

  app.post<{
    Params: TurnParams;
    Body: {
      confirmed?: boolean;
      revision?: number;
      idempotencyKey?: string;
      source?: "button" | "natural_language";
    };
  }>(
    "/api/guests/:guestId/projects/:projectId/turns/:turnId/stop",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const turn = store.getTurn(request.params.turnId);
      const item = turn ? store.getWorkItem(turn.workItemId) : null;
      if (
        !turn ||
        turn.projectId !== project.id ||
        !item ||
        item.archivedAt ||
        turn.status !== "running"
      ) {
        throw new StoreError("turn_not_running", "任务已不在执行中", 409);
      }
      if (
        request.body?.confirmed !== true ||
        !Number.isInteger(request.body?.revision) ||
        typeof request.body?.idempotencyKey !== "string" ||
        request.body.idempotencyKey.length < 8 ||
        request.body.idempotencyKey.length > 200
      ) {
        throw new StoreError(
          "action_confirmation_required",
          "停止任务需要有效的二次确认上下文",
          409
        );
      }
      const stopIdempotencyKey = `stop:${turn.id}`;
      store.reserveWorkflowAction({
        workItemId: item.id,
        action: "stop",
        revision: item.revision,
        idempotencyKey: stopIdempotencyKey,
        source: request.body.source ?? "button",
        actorGuestId: project.guestId
      });
      store.addWorkItemEvent(
        item.id,
        "confirmed_action",
        request.body.source ?? "button",
        item.workflowState,
        item.workflowState,
        project.guestId,
        { action: "stop", turnId: turn.id },
        `audit:${stopIdempotencyKey}`
      );
      const stopped = await runner.stop(project.id, turn.id);
      const updated = store.getWorkItem(item.id)!;
      hub.publish(
        project.id,
        "work_item_updated",
        updated,
        `work:${updated.id}:${updated.revision}`
      );
      return stopped;
    }
  );

  app.get<{ Params: ProjectParams }>(
    "/api/guests/:guestId/projects/:projectId/files",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      const changes = new Map<string, "new" | "updated">();
      const activeWorkItem = store.getActiveWorkItem(project.id);
      if (
        activeWorkItem?.type === "direct_coding" &&
        /^[a-f0-9]{40,64}$/u.test(activeWorkItem.baseCommit)
      ) {
        for (const change of await versions.workingChanges(
          paths.repositoryRoot,
          paths.projectRoot,
          activeWorkItem.baseCommit
        )) {
          if (change.status === "deleted") continue;
          changes.set(change.path, change.status === "added" ? "new" : "updated");
        }
      } else {
        const latestTurn = store.listTurns(project.id).items.at(-1);
        if (latestTurn) {
        for (const item of latestTurn.items) {
          if (item.type !== "file_change") continue;
          if (item.action === "delete") {
            changes.delete(item.path);
          } else if (
            (item.action === "rename" || item.action === "move") &&
            item.previousPath
          ) {
            const previousChange = changes.get(item.previousPath);
            changes.delete(item.previousPath);
            changes.set(item.path, previousChange === "new" ? "new" : "updated");
          } else {
            changes.set(item.path, item.action === "create" ? "new" : "updated");
          }
        }
        }
      }
      return { items: markChangedFiles(await buildFileTree(paths.projectRoot), changes) };
    }
  );

  app.get<{ Params: ProjectParams; Querystring: { path?: string } }>(
    "/api/guests/:guestId/projects/:projectId/file",
    async (request) => {
      const project = requireProject(store, request.params.guestId, request.params.projectId);
      if (!request.query.path) throw new StoreError("file_required", "请选择文件");
      const paths = await ensureProjectPaths(config, project.guestId, project.id);
      return readProjectFile(paths.projectRoot, request.query.path);
    }
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { guestId?: string };
  }>(
    "/ws/projects/:projectId",
    { websocket: true },
    (socket, request) => {
      const guestId = request.query.guestId ?? "";
      const project = store.getProjectForGuest(request.params.projectId, guestId);
      if (!project) {
        socket.close(1008, "项目不可用");
        return;
      }
      const stopTimer = previewStopTimers.get(project.id);
      if (stopTimer) {
        clearTimeout(stopTimer);
        previewStopTimers.delete(project.id);
      }
      const dynamicReadyWithoutRuntime =
        project.previewStatus === "ready" &&
        Boolean(project.previewUrl?.startsWith("http")) &&
        !previews.hasRuntime(project.id);
      if (
        project.previewCapable &&
        (project.previewStatus === "stopped" || dynamicReadyWithoutRuntime)
      ) {
        void ensureProjectPaths(config, project.guestId, project.id).then((paths) =>
          previews.refresh(project.id, paths.projectRoot)
        );
      }
      const unsubscribe = hub.subscribe(project.id, (event) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      });
      socket.on("close", () => {
        unsubscribe();
        const current = store.getProject(project.id);
        if (!current?.previewCapable || hub.viewerCount(project.id) > 0) return;
        const timer = setTimeout(() => {
          previewStopTimers.delete(project.id);
          const current = store.getProject(project.id);
          if (!current?.previewCapable || hub.viewerCount(project.id) > 0) return;
          void previews.stop(project.id);
        }, PREVIEW_IDLE_MS);
        timer.unref();
        previewStopTimers.set(project.id, timer);
      });
      setImmediate(() => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(
          JSON.stringify({
            id: crypto.randomUUID(),
            projectId: project.id,
            kind: "sync",
            occurredAt: new Date().toISOString(),
            data: {
              connected: true,
              project: store.getProject(project.id),
              activeWorkItem: store.getActiveWorkItem(project.id),
              workItemEvents: (() => {
                const item = store.getActiveWorkItem(project.id);
                return item ? store.listWorkItemEvents(item.id) : [];
              })(),
              turns: store.listTimelineTurns(project.id).items
            }
          })
        );
      });
    }
  );

  app.route({
    method: "GET",
    url: "/*",
    handler: (_request, reply) => reply.callNotFound(),
    wsHandler: (socket, request) => {
      const projectId = previews.projectIdFromHostname(request.hostname);
      const project = projectId ? store.getProject(projectId) : null;
      const target = projectId ? previews.target(projectId) : null;
      if (!projectId || !project || project.previewStatus !== "ready" || !target) {
        socket.close(1013, "Preview unavailable");
        return;
      }
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const upstream = new WebSocket(
        `ws://${target.hostname}:${target.port}${request.raw.url ?? "/"}`,
        protocols.length ? protocols : undefined,
        {
          headers: {
            host: request.hostname,
            origin: `https://${request.hostname}`
          }
        }
      );
      upstream.on("open", () => {
        socket.on("message", (data, isBinary) => upstream.send(data, { binary: isBinary }));
        upstream.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
      });
      upstream.on("close", (code, reason) => socket.close(code, reason.toString()));
      upstream.on("error", () => socket.close(1011, "Preview connection failed"));
      socket.on("close", () => upstream.close());
      socket.on("error", () => upstream.close());
    }
  });

  const webRoot = resolve("dist/web");
  if (config.isProduction && existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({ error: { code: "not_found", message: "未找到" } });
    });
  }

  return app;
}
