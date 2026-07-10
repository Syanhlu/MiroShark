// Manual smoke test for the real MiroShark API flow (VNG SimClient integration prep).
// Not part of the pytest suite or CI — needs a live backend + MIROSHARK_ADMIN_TOKEN.
// Run: MIROSHARK_ADMIN_TOKEN=... node scripts/vng-smoke-test/smoke-test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = process.env.MIROSHARK_URL || "http://localhost:5001";
const ADMIN_TOKEN = process.env.MIROSHARK_ADMIN_TOKEN;

function log(step, obj) {
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

async function req(method, path, { json, form, headers } = {}) {
  const opts = { method, headers: { ...headers } };
  if (json) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form; // FormData sets its own Content-Type boundary
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function poll(fn, isDone, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000, label = "poll" } = {}) {
  const start = Date.now();
  while (true) {
    const result = await fn();
    if (isDone(result)) return result;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  if (!ADMIN_TOKEN) throw new Error("MIROSHARK_ADMIN_TOKEN not set in this shell's env");

  // 1. ontology/generate (multipart)
  const form = new FormData();
  const docText = readFileSync(join(__dirname, "doctext-skin-lines.txt"), "utf-8");
  form.append("files", new Blob([docText], { type: "text/plain" }), "skin-reception-mock-social.txt");
  form.append(
    "simulation_requirement",
    "Simulate Vietnamese and regional social media reaction to the reveal of the 'Cyberpunk Premium / Neon Mecha / Ronin' game skin line, drawing on the tone and concerns already visible in mock community posts (price sensitivity, art-quality praise/criticism, pay-to-win perception, regional launch-timing complaints)."
  );
  form.append("project_name", "smoke-test-vn-skin-reception");

  let r = await req("POST", "/api/graph/ontology/generate", { form });
  log("1. POST /api/graph/ontology/generate", { status: r.status, body: r.body });
  if (!r.body?.success) throw new Error("Step 1 failed");
  const projectId = r.body.data.project_id;

  // 2. graph/build
  r = await req("POST", "/api/graph/build", { json: { project_id: projectId } });
  log("2. POST /api/graph/build", { status: r.status, body: r.body });
  if (!r.body?.success) throw new Error("Step 2 failed");
  const buildTaskId = r.body.data.task_id;

  // 3. poll graph/task/<task_id>
  const buildTask = await poll(
    async () => (await req("GET", `/api/graph/task/${buildTaskId}`)).body,
    (result) => result?.data?.status === "completed" || result?.data?.status === "failed",
    { label: "graph build task" }
  );
  log("3. GET /api/graph/task/<task_id> (final)", buildTask);
  if (buildTask?.data?.status !== "completed") throw new Error("Step 3: graph build did not complete");
  const graphId = buildTask.data.result?.graph_id;
  if (!graphId) throw new Error("Step 3: no graph_id in task result");

  // 4. simulation/create
  r = await req("POST", "/api/simulation/create", {
    json: {
      project_id: projectId,
      graph_id: graphId,
      enable_threads: true,
      enable_facebook: true,
      enable_polymarket: false,
      enable_tiktok: false,
      country: "vn",
    },
  });
  log("4. POST /api/simulation/create", { status: r.status, body: r.body });
  if (!r.body?.success) throw new Error("Step 4 failed");
  const simulationId = r.body.data.simulation_id;

  // 5. simulation/prepare
  r = await req("POST", "/api/simulation/prepare", { json: { simulation_id: simulationId } });
  log("5. POST /api/simulation/prepare", { status: r.status, body: r.body });
  if (!r.body?.success) throw new Error("Step 5 failed");

  // 6. poll simulation/prepare/status
  const prepareStatus = await poll(
    async () =>
      (
        await req("POST", "/api/simulation/prepare/status", {
          json: { simulation_id: simulationId, task_id: r.body.data.task_id },
        })
      ).body,
    (result) => result?.data?.status === "ready" || result?.data?.status === "failed",
    { label: "prepare status", timeoutMs: 10 * 60 * 1000 }
  );
  log("6. POST /api/simulation/prepare/status (final)", prepareStatus);
  if (prepareStatus?.data?.status !== "ready") throw new Error("Step 6: prepare did not become ready");

  // 7. simulation/start
  r = await req("POST", "/api/simulation/start", {
    json: { simulation_id: simulationId, platform: "parallel", max_rounds: 1 },
  });
  log("7. POST /api/simulation/start", { status: r.status, body: r.body });
  if (!r.body?.success) throw new Error("Step 7 failed");

  // 8. poll run-status
  const runStatus = await poll(
    async () => (await req("GET", `/api/simulation/${simulationId}/run-status`)).body,
    (result) => ["completed", "failed"].includes(result?.data?.runner_status),
    { label: "run status", intervalMs: 2000, timeoutMs: 3 * 60 * 1000 }
  );
  log("8. GET /api/simulation/<id>/run-status (final)", runStatus);
  if (runStatus?.data?.runner_status !== "completed") throw new Error("Step 8: run did not complete");

  // 9. publish
  r = await req("POST", `/api/simulation/${simulationId}/publish`, {
    json: { public: true },
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  log("9. POST /api/simulation/<id>/publish", { status: r.status, body: r.body });
  if (!r.body?.success) throw new Error("Step 9 failed");

  // 10. signal.json
  r = await req("GET", `/api/simulation/${simulationId}/signal.json`);
  log("10. GET /api/simulation/<id>/signal.json", { status: r.status, body: r.body });

  // Bonus: check /posts for the citations-source question
  r = await req("GET", `/api/simulation/${simulationId}/posts`);
  log("Bonus: GET /api/simulation/<id>/posts", { status: r.status, body: typeof r.body === "object" ? { ...r.body, data: Array.isArray(r.body.data) ? `[${r.body.data.length} items, first: ${JSON.stringify(r.body.data[0])}]` : r.body.data } : r.body });

  console.log("\n=== DONE: simulation_id =", simulationId, "===");
}

main().catch((e) => {
  console.error("\nSMOKE TEST FAILED:", e);
  process.exit(1);
});
