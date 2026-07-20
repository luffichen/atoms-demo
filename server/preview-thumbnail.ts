import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { linuxSandboxArgs } from "./safe-tools.js";

const CAPTURE_TIMEOUT_MS = 20_000;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROFILE_NAME = "thumbnail-chrome-profile";

export type ThumbnailBrowserRunner = (
  projectRoot: string,
  command: string
) => Promise<void>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runSandboxedBrowser(projectRoot: string, command: string): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("当前开发环境未配置预览截图浏览器");
  }
  const child = spawn(
    process.env.BWRAP_PATH ?? "/usr/bin/bwrap",
    linuxSandboxArgs(projectRoot, command, [], [], "bound"),
    {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("预览缩略图生成超时"));
    }, CAPTURE_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`预览缩略图生成失败（${code ?? "未知"}）：${stderr.trim()}`));
    });
  });
}

export class PreviewThumbnailer {
  constructor(private readonly runBrowser: ThumbnailBrowserRunner = runSandboxedBrowser) {}

  async capture(
    projectRoot: string,
    entryUrl: string,
    options: { width?: number; height?: number; outputName?: string } = {}
  ): Promise<Buffer> {
    const width = options.width ?? 1280;
    const height = options.height ?? 720;
    const outputName = options.outputName ?? "preview-thumbnail.png";
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 320 ||
      width > 2560 ||
      height < 480 ||
      height > 1600 ||
      !/^[a-z0-9-]+\.png$/u.test(outputName)
    ) {
      throw new Error("预览截图参数无效");
    }
    const output = join(projectRoot, ".tmp", outputName);
    const profile = join(projectRoot, ".tmp", PROFILE_NAME);
    await mkdir(join(projectRoot, ".tmp"), { recursive: true });
    await Promise.all([
      rm(output, { force: true }),
      rm(profile, { recursive: true, force: true })
    ]);
    const command = [
      "/usr/lib/atoms-chrome/chrome",
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=1",
      "--virtual-time-budget=3000",
      `--user-data-dir=/tmp/${PROFILE_NAME}`,
      `--screenshot=/tmp/${outputName}`,
      shellQuote(entryUrl)
    ].join(" ");
    await this.runBrowser(projectRoot, command);
    const image = await readFile(output);
    if (
      image.length === 0
      || image.length > MAX_THUMBNAIL_BYTES
      || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      throw new Error("预览截图不是有效的 PNG 文件");
    }
    return image;
  }
}
