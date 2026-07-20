import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { assertInsideProject } from "./paths.js";

const HIDDEN_NAMES = new Set([
  "node_modules",
  ".git",
  ".pi",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".npm-cache",
  ".tmp",
  ".DS_Store"
]);
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};
const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".ico",
  ".mp3",
  ".mp4",
  ".mov"
]);
const MAX_TEXT_BYTES = 1024 * 1024;

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  change?: "new" | "updated";
  children?: FileTreeNode[];
}

export async function buildFileTree(projectRoot: string): Promise<FileTreeNode[]> {
  async function walk(directory: string): Promise<FileTreeNode[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = entries.filter((entry) => !HIDDEN_NAMES.has(entry.name));
    visible.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    });
    return Promise.all(
      visible.map(async (entry): Promise<FileTreeNode> => {
        const absolute = join(directory, entry.name);
        const path = relative(projectRoot, absolute);
        if (entry.isDirectory()) {
          return { name: entry.name, path, type: "directory", children: await walk(absolute) };
        }
        return { name: entry.name, path, type: "file" };
      })
    );
  }
  return walk(projectRoot);
}

export type FileView =
  | { kind: "text"; name: string; path: string; size: number; content: string; language: string }
  | { kind: "image"; name: string; path: string; size: number; mimeType: string; data: string }
  | { kind: "large"; name: string; path: string; size: number; message: string }
  | { kind: "binary"; name: string; path: string; size: number; mimeType: string; message: string };

function languageFor(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".json": "json",
      ".css": "css",
      ".html": "html",
      ".md": "markdown",
      ".py": "python",
      ".go": "go",
      ".rs": "rust",
      ".sh": "shell",
      ".yaml": "yaml",
      ".yml": "yaml"
    }[extension] ?? "text"
  );
}

export async function readProjectFile(projectRoot: string, requestedPath: string): Promise<FileView> {
  const absolute = await assertInsideProject(projectRoot, requestedPath);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error("请选择文件");
  const extension = extname(absolute).toLowerCase();
  const common = {
    name: basename(absolute),
    path: relative(projectRoot, absolute),
    size: metadata.size
  };
  if (IMAGE_TYPES[extension]) {
    const buffer = await readFile(absolute);
    return {
      kind: "image",
      ...common,
      mimeType: IMAGE_TYPES[extension],
      data: buffer.toString("base64")
    };
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return {
      kind: "binary",
      ...common,
      mimeType: "application/octet-stream",
      message: "无法预览"
    };
  }
  if (metadata.size > MAX_TEXT_BYTES) {
    return { kind: "large", ...common, message: "文件过大，无法预览" };
  }
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) {
    return {
      kind: "binary",
      ...common,
      mimeType: "application/octet-stream",
      message: "无法预览"
    };
  }
  return {
    kind: "text",
    ...common,
    content: buffer.toString("utf8"),
    language: languageFor(absolute)
  };
}
