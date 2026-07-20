#!/usr/bin/env node

const baseUrl = process.argv[2]?.replace(/\/+$/, "");
if (!baseUrl) {
  console.error("Usage: node scripts/verify-requirement-workflow.mjs https://atoms.example.com");
  process.exit(1);
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: options?.body ? { "content-type": "application/json", ...options.headers } : options?.headers
  });
  const text = await response.text();
  const data = JSON.parse(text);
  if (!response.ok) {
    throw new Error(`${options?.method ?? "GET"} ${path}: ${response.status} ${text}`);
  }
  return data;
}

async function waitForTurn(projectPath, sequence, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await request(projectPath);
    const turn = snapshot.turns.items.find((candidate) => candidate.sequence === sequence);
    if (turn && ["completed", "failed", "cancelled"].includes(turn.status)) {
      return { snapshot, turn };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Turn ${sequence} did not finish before timeout`);
}

function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])]);
}

const guests = (await request("/api/guests")).items;
const guest = guests.find(({ name }) => name === "default");
if (!guest) throw new Error("Default guest is missing");

const created = await request(`/api/guests/${guest.id}/projects`, {
  method: "POST",
  body: JSON.stringify({
    mode: "structured_requirement",
    text: [
      "规划一个最小化的部署验收标记功能：项目首页展示只读文本“需求工作流验收通过”。",
      "不需要权限、配置、数据存储或兼容历史数据，验收标准为页面可见该文本。",
      "请先复述结论并询问是否确认需求，不要编写代码。"
    ].join("")
  })
});

const projectPath = `/api/guests/${guest.id}/projects/${created.project.id}`;
const initial = await waitForTurn(projectPath, 1);
if (initial.turn.status !== "completed") {
  throw new Error(`Requirement discussion failed: ${initial.turn.status} ${initial.turn.error ?? ""}`);
}

await request(
  `${projectPath}/work-items/${created.workItem.id}/actions`,
  {
    method: "POST",
    body: JSON.stringify({
      action: "confirm_requirements",
      source: "button",
      confirmed: true,
      revision: initial.snapshot.activeWorkItem.revision,
      idempotencyKey: crypto.randomUUID()
    })
  }
);

const finalized = await waitForTurn(projectPath, 2);
if (finalized.turn.status !== "completed") {
  throw new Error(`Requirement document finalization failed: ${finalized.turn.status} ${finalized.turn.error ?? ""}`);
}

const snapshot = await request(projectPath);
const technicalTurn = snapshot.turns.items.find((turn) => turn.sequence === 3);
if (!technicalTurn) throw new Error("Technical design turn was not created");
if (!["technical_design", "technical_pending_confirmation"].includes(snapshot.activeWorkItem.workflowState)) {
  throw new Error(`Unexpected workflow state: ${snapshot.activeWorkItem.workflowState}`);
}

const tree = flatten((await request(`${projectPath}/files`)).items);
const requirementDocument = tree.find(
  ({ type, path }) =>
    type === "file" &&
    /^docs\/requirements\/R001-[^/]+\/[^/]+\.md$/.test(path)
);
if (!requirementDocument) throw new Error("R001 requirement document is missing");

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      projectId: created.project.id,
      requirementDocument: requirementDocument.path,
      requirementTurnStatus: finalized.turn.status,
      workflowState: snapshot.activeWorkItem.workflowState,
      technicalTurnStatus: technicalTurn.status
    },
    null,
    2
  )
);
