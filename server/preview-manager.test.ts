import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import {
  createNodePortHook,
  detectPreviewSpec,
  createNextConfigOverlay,
  PreviewManager,
  previewStartCommand
} from "./preview-manager.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8080,
  workspaceRoot: "/tmp",
  databasePath: ":memory:",
  deepseekKeyFile: "/tmp/unused",
  deepseekModel: "deepseek-v4-pro",
  releaseMetadataModel: "deepseek-v4-flash",
  publicDomain: "34.81.124.243.sslip.io",
  isProduction: true
};

describe("PreviewManager", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("识别静态页面、Next.js、Vite 和普通 Node 启动方式", () => {
    expect(detectPreviewSpec({ hasIndexHtml: true })).toEqual({
      framework: "static",
      script: null
    });
    expect(
      detectPreviewSpec({
        hasIndexHtml: false,
        scripts: { dev: "next dev", start: "next start" },
        dependencies: { next: "^14.2.0" }
      })
    ).toEqual({ framework: "next", script: "dev" });
    expect(
      detectPreviewSpec({
        hasIndexHtml: false,
        scripts: { preview: "vite preview" },
        devDependencies: { vite: "^7.0.0" }
      })
    ).toEqual({ framework: "vite", script: "preview" });
    expect(
      detectPreviewSpec({
        hasIndexHtml: false,
        scripts: { start: "node server.js" }
      })
    ).toEqual({ framework: "node", script: "start" });
    expect(detectPreviewSpec({ hasIndexHtml: false, scripts: { test: "vitest" } })).toBeNull();
  });

  it("为不同框架生成只监听回环地址的启动命令", () => {
    expect(previewStartCommand({ framework: "next", script: "dev" }, 41001)).toBe(
      "npm run dev -- --hostname 127.0.0.1 --port 41001"
    );
    expect(previewStartCommand({ framework: "vite", script: "preview" }, 41002)).toBe(
      "npm run preview -- --host 127.0.0.1 --port 41002"
    );
    expect(previewStartCommand({ framework: "node", script: "start" }, 41003)).toBe(
      "env ATOMS_PREVIEW_PORT=41003 HOST=127.0.0.1 HOSTNAME=127.0.0.1 PORT=41003 npm run start"
    );
  });

  it("为硬编码监听端口的 NestJS/Node 应用生成动态端口钩子", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-preview-"));
    await mkdir(join(root, ".tmp"), { recursive: true });

    const hook = await createNodePortHook(root);

    expect(hook).toBe(join(root, ".tmp/preview-port-hook.cjs"));
    expect(await readFile(hook, "utf8")).toContain("net.Server.prototype.listen");
    expect(await readFile(hook, "utf8")).toContain("ATOMS_PREVIEW_PORT");
  });

  it("通过沙箱覆盖层兼容旧版 Next.js 的 TypeScript 配置且不改项目文件", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-preview-"));
    await writeFile(
      join(root, "next.config.ts"),
      "type Config = { reactStrictMode: boolean }; const config: Config = { reactStrictMode: true }; export default config;"
    );
    await mkdir(join(root, ".tmp"), { recursive: true });

    const binds = await createNextConfigOverlay(root);

    expect(binds).toEqual([
      {
        source: join(root, ".tmp/preview-next.config.mjs"),
        destination: "/project/next.config.mjs"
      }
    ]);
    expect(await readFile(binds[0].source, "utf8")).not.toContain("type Config");
    expect(await readFile(join(root, "next.config.ts"), "utf8")).toContain("type Config");
  });

  it("静态项目直接就绪且项目子域名只能解析合法 UUID", async () => {
    root = await mkdtemp(join(tmpdir(), "atoms-preview-"));
    await writeFile(join(root, "index.html"), "<main>ready</main>");
    const manager = new PreviewManager(config);
    const projectId = "5a69808a-c69a-464b-9f94-d7e411aa79ba";
    const states: string[] = [];
    manager.onState((state) => states.push(state.previewStatus));

    await expect(manager.refresh(projectId, root)).resolves.toMatchObject({
      previewCapable: true,
      previewStatus: "ready",
      previewUrl: `/preview/${projectId}/`,
      previewError: null
    });
    expect(states).toEqual(["ready"]);
    expect(
      manager.projectIdFromHostname(`p-${projectId}.34.81.124.243.sslip.io`)
    ).toBe(projectId);
    expect(manager.projectIdFromHostname("p-not-a-uuid.34.81.124.243.sslip.io")).toBeNull();
    expect(manager.projectIdFromHostname(`p-${projectId}.example.com`)).toBeNull();
    await manager.close();
  });
});
