import { AgentRunner } from "./agent-runner.js";
import { buildApp } from "./app.js";
import { loadConfig, readDeepseekKey } from "./config.js";
import { openDatabase } from "./db.js";
import { RealtimeHub } from "./realtime.js";
import { Store } from "./store.js";
import { PreviewManager } from "./preview-manager.js";

const config = loadConfig();
process.env.DEEPSEEK_API_KEY = readDeepseekKey(config);
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";

const database = openDatabase(config.databasePath);
const store = new Store(database);
const hub = new RealtimeHub();
const previews = new PreviewManager(config);
const runner = new AgentRunner(config, store, hub, undefined, previews);
const app = await buildApp({ config, store, hub, runner, previews, logger: true });

runner.recoverAndStart();

const shutdown = async () => {
  await app.close();
  database.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
