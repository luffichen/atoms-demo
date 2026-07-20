import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

type FileIdentity = {
  device: number;
  inode: number;
};

export type FileStructureSnapshot = Map<string, FileIdentity>;

export type FileStructureChange =
  | { action: "create" | "delete"; path: string }
  | { action: "rename" | "move"; path: string; previousPath: string };

const excludedDirectories = new Set([
  ".git",
  ".agents",
  ".codex",
  ".sessions",
  "node_modules",
  "dist",
  "build",
  "coverage"
]);

export function snapshotProjectFiles(root: string): FileStructureSnapshot {
  const snapshot: FileStructureSnapshot = new Map();
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = lstatSync(absolute);
        snapshot.set(relative(root, absolute), { device: stat.dev, inode: stat.ino });
      } catch {
        // The agent may still be changing this path; the next snapshot is authoritative.
      }
    }
  };
  visit(root);
  return snapshot;
}

function identityKey(identity: FileIdentity): string {
  return `${identity.device}:${identity.inode}`;
}

export function diffProjectFileStructure(
  before: FileStructureSnapshot,
  after: FileStructureSnapshot
): FileStructureChange[] {
  const missing = [...before].filter(([path]) => !after.has(path));
  const added = [...after].filter(([path]) => !before.has(path));
  const addedByIdentity = new Map(
    added.map(([path, identity]) => [identityKey(identity), path])
  );
  const matchedAdded = new Set<string>();
  const changes: FileStructureChange[] = [];

  for (const [previousPath, identity] of missing) {
    const path = addedByIdentity.get(identityKey(identity));
    if (!path) {
      changes.push({ action: "delete", path: previousPath });
      continue;
    }
    matchedAdded.add(path);
    changes.push({
      action: dirname(previousPath) === dirname(path) ? "rename" : "move",
      path,
      previousPath
    });
  }
  for (const [path] of added) {
    if (!matchedAdded.has(path)) changes.push({ action: "create", path });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}
