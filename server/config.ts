import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  workspaceRoot: string;
  databasePath: string;
  deepseekKeyFile: string;
  deepseekModel: string;
  releaseMetadataModel: string;
  publicDomain: string;
  isProduction: boolean;
}

function resolveKeyFile(configured?: string): string {
  const candidates = [
    configured,
    "deepseek.key",
    "docs/deepseek.key"
  ].filter((value): value is string => Boolean(value));
  return resolve(candidates.find((candidate) => existsSync(resolve(candidate))) ?? candidates[0]);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const workspaceRoot = resolve(env.ATOMS_WORKSPACE_ROOT ?? "./workspace");
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8080),
    workspaceRoot,
    databasePath: resolve(env.ATOMS_DATABASE_PATH ?? `${workspaceRoot}/atoms-demo.sqlite`),
    deepseekKeyFile: resolveKeyFile(env.DEEPSEEK_KEY_FILE),
    deepseekModel: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    releaseMetadataModel: env.RELEASE_METADATA_MODEL ?? "deepseek-v4-flash",
    publicDomain: env.ATOMS_PUBLIC_DOMAIN ?? "localhost",
    isProduction: env.NODE_ENV === "production"
  };
}

export function readDeepseekKey(config: AppConfig): string {
  const key = readFileSync(config.deepseekKeyFile, "utf8").trim();
  if (!key) {
    throw new Error(`DeepSeek 密钥文件为空：${config.deepseekKeyFile}`);
  }
  return key;
}
