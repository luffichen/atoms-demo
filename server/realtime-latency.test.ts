import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { openMemoryDatabase } from "./db.js";
import { RealtimeHub, type RealtimeKind } from "./realtime.js";
import { Store } from "./store.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  workspaceRoot: "/tmp/atoms-realtime-latency-tests",
  databasePath: ":memory:",
  deepseekKeyFile: "/tmp/unused",
  deepseekModel: "deepseek-v4-pro",
  releaseMetadataModel: "deepseek-v4-flash",
  publicDomain: "localhost",
  isProduction: false
};

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

describe("实时事件 WebSocket 延迟", () => {
  let db: Database.Database;
  let store: Store;
  let hub: RealtimeHub;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openMemoryDatabase();
    store = new Store(db);
    hub = new RealtimeHub();
    app = await buildApp({ config, store, hub });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("五类事件各采样 30 次且 WebSocket 交付 p95 小于 1 秒", async () => {
    const guest = store.listGuests()[0];
    const { project, turn } = store.createProjectWithTurn(guest.id, "实时采样", "开始");
    await app.ready();

    let resolveSync!: () => void;
    const synchronized = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const socket = await app.injectWS(
      `/ws/projects/${project.id}?guestId=${encodeURIComponent(guest.id)}`,
      {},
      {
        onInit: (client) => {
          client.once("message", () => resolveSync());
        }
      }
    );
    await synchronized;

    const categories: Array<{
      name: string;
      kind: RealtimeKind;
      data: (index: number) => unknown;
    }> = [
      {
        name: "messageStatus",
        kind: "turn_started",
        data: (index) => ({ ...turn, status: "running", sample: index })
      },
      {
        name: "assistantDelta",
        kind: "item_assistant_message_delta",
        data: (index) => ({ turnId: turn.id, itemId: "assistant", delta: `${index}` })
      },
      {
        name: "fileWrite",
        kind: "file_append",
        data: (index) => ({
          turnId: turn.id,
          streamId: "stream",
          path: "index.ts",
          offset: index,
          delta: `${index}`
        })
      },
      {
        name: "terminalOutput",
        kind: "item_command_output_snapshot",
        data: (index) => ({ turnId: turn.id, itemId: "command", output: `${index}` })
      },
      {
        name: "todoUpdate",
        kind: "item_started",
        data: (index) => ({
          id: `todo-${index}`,
          turnId: turn.id,
          type: "todo_list",
          todos: [{ content: `步骤 ${index}`, status: "in_progress" }]
        })
      }
    ];

    const results: Record<string, number> = {};
    for (const category of categories) {
      const samples: number[] = [];
      for (let index = 0; index < 30; index += 1) {
        const received = new Promise<Record<string, unknown>>((resolve) => {
          socket.once("message", (data) => resolve(JSON.parse(data.toString())));
        });
        const startedAt = performance.now();
        hub.publish(
          project.id,
          category.kind,
          category.data(index),
          `${category.name}-${index}`
        );
        const envelope = await received;
        samples.push(performance.now() - startedAt);
        expect(envelope.kind).toBe(category.kind);
      }
      const p95 = percentile95(samples);
      results[category.name] = Number(p95.toFixed(1));
      expect(samples.filter((sample) => sample < 1_000).length).toBeGreaterThanOrEqual(29);
      expect(p95).toBeLessThan(1_000);
    }
    console.info("realtime-websocket-p95-ms", results);
    socket.terminate();
  });
});
