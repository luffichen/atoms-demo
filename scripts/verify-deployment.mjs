#!/usr/bin/env node

const baseUrl = process.argv[2]?.replace(/\/+$/, "");
if (!baseUrl) {
  console.error("Usage: node scripts/verify-deployment.mjs https://atoms.example.com");
  process.exit(1);
}

async function request(path, options) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: options?.body ? { "content-type": "application/json", ...options.headers } : options?.headers
  });
  const elapsed = performance.now() - started;
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${options?.method ?? "GET"} ${path}: ${response.status} ${text}`);
  }
  return { data, elapsed };
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1];
}

const health = await request("/api/health");
if (health.data.ok !== true) throw new Error("Health check did not return ok=true");

const guests = (await request("/api/guests")).data.items;
const defaultGuest = guests.find(({ name }) => name === "default");
if (!defaultGuest) throw new Error("Default guest is missing");

const marker = `DEPLOYMENT_ACCEPTANCE_${Date.now()}`;
const created = (
  await request(`/api/guests/${defaultGuest.id}/projects`, {
    method: "POST",
    body: JSON.stringify({
      text: [
        "完成一次部署验收。",
        `必须先使用终端工具执行：printf '${marker}\\\\n'。`,
        `然后只使用文件写入工具创建 index.html，正文必须包含 ${marker}。`,
        "不要读取项目外文件。完成后简短说明。"
      ].join("")
    })
  })
).data;

const deadline = Date.now() + 10 * 60 * 1000;
let snapshot;
while (Date.now() < deadline) {
  snapshot = (
    await request(`/api/guests/${defaultGuest.id}/projects/${created.project.id}`)
  ).data;
  const status = snapshot.turns.items[0]?.status;
  if (["completed", "failed", "cancelled"].includes(status)) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

const firstTurn = snapshot?.turns?.items?.[0];
if (firstTurn?.status !== "completed") {
  throw new Error(`DeepSeek task did not complete: ${firstTurn?.status} ${firstTurn?.error ?? ""}`);
}
if (snapshot.project.previewStatus !== "ready" || !snapshot.project.previewUrl) {
  throw new Error(`Preview is not ready: ${snapshot.project.previewStatus}`);
}
const fileItem = firstTurn.items.find(
  ({ type, path, status }) => type === "file_change" && path === "index.html" && status === "completed"
);
if (!fileItem) throw new Error("Successful index.html file item is missing");
const terminalItem = firstTurn.items.find(
  ({ type, status, output }) =>
    type === "command_execution" && status === "completed" && String(output).includes(marker)
);
if (!terminalItem) throw new Error("Sandboxed terminal output marker is missing");
const finalAnswer = firstTurn.items.find(
  ({ type, phase, status, text }) =>
    type === "assistant_message" &&
    phase === "final_answer" &&
    status === "completed" &&
    String(text).trim()
);
if (!finalAnswer) throw new Error("Completed final_answer item is missing");

const preview = await request(snapshot.project.previewUrl);
if (!String(preview.data).includes(marker)) throw new Error("Preview does not contain acceptance marker");

const files = (
  await request(`/api/guests/${defaultGuest.id}/projects/${created.project.id}/files`)
).data.items;
if (!files.some(({ path, change }) => path === "index.html" && change === "new")) {
  throw new Error("File tree does not expose the new index.html marker");
}

const timings = [];
for (let index = 0; index < 20; index += 1) {
  timings.push((await request("/api/guests")).elapsed);
  timings.push((await request(`/api/guests/${defaultGuest.id}/projects`)).elapsed);
  timings.push(
    (await request(`/api/guests/${defaultGuest.id}/projects/${created.project.id}`)).elapsed
  );
}
const p95 = percentile(timings, 95);
if (p95 >= 2000) throw new Error(`Page API p95 is ${p95.toFixed(1)}ms, expected < 2000ms`);

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      projectId: created.project.id,
      deepseekStatus: firstTurn.status,
      previewStatus: snapshot.project.previewStatus,
      terminalSandbox: "passed",
      pageApiSamples: timings.length,
      pageApiP95Ms: Number(p95.toFixed(1))
    },
    null,
    2
  )
);
