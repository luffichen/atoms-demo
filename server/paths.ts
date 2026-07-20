import { mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AppConfig } from "./config.js";

export interface ProjectPaths {
  guestRoot: string;
  projectRoot: string;
  sessionRoot: string;
  attachmentRoot: string;
  repositoryRoot: string;
}

export async function ensureProjectPaths(
  config: AppConfig,
  guestId: string,
  projectId: string
): Promise<ProjectPaths> {
  const guestRoot = join(config.workspaceRoot, guestId);
  const paths = {
    guestRoot,
    projectRoot: join(guestRoot, "projects", projectId),
    sessionRoot: join(guestRoot, "sessions", projectId),
    attachmentRoot: join(guestRoot, "attachments", projectId),
    repositoryRoot: join(guestRoot, "repositories", `${projectId}.git`)
  };
  await Promise.all([
    mkdir(paths.projectRoot, { recursive: true }),
    mkdir(paths.sessionRoot, { recursive: true }),
    mkdir(paths.attachmentRoot, { recursive: true })
  ]);
  return paths;
}

export async function ensureWorkItemSessionPath(
  config: AppConfig,
  guestId: string,
  projectId: string,
  workItemId: string
): Promise<string> {
  const paths = await ensureProjectPaths(config, guestId, projectId);
  const workItemSessionRoot = join(paths.sessionRoot, workItemId);
  await mkdir(workItemSessionRoot, { recursive: true });
  return workItemSessionRoot;
}

export async function assertInsideProject(projectRoot: string, candidate: string): Promise<string> {
  const root = await realpath(projectRoot);
  const unresolved = resolve(projectRoot, candidate);
  let target: string;
  try {
    target = await realpath(unresolved);
  } catch {
    target = unresolved;
  }
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("拒绝访问项目目录之外的路径");
  }
  return target;
}
