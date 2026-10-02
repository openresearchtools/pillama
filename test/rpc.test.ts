import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readTelemetry, type Telemetry } from "../telemetry.ts";

const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const extension = resolve("index.ts");

async function runProbe(mode: "success" | "missing" | "cancel" | "failed" | "tools") {
  let status = mode === "missing" ? "missing" : "unloaded";
  let requests = 0;
  let heartbeatRequested = false;
  const watchers = new Set<http.ServerResponse>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; };
  const server = http.createServer(async (req, res) => {
    const json = (data: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/models") return json({ data: status === "missing" ? [] : [{ id: "test-model", status: { value: status, failed: status === "failed" } }] });
    if (req.url === "/props") return json({ models_autoload: true });
    if (req.url === "/models/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ready\n\n"); watchers.add(res);
      res.on("close", () => watchers.delete(res));
      return;
    }
    if (req.url === "/models/load") {
      status = "loading";
      json({ success: true });
      later(() => {
        for (const watcher of watchers) watcher.write('data: {"model":"test-model","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.5}}}\n\n');
      }, 350);
      if (mode !== "cancel") later(() => { status = mode === "failed" ? "failed" : "loaded"; }, 1800);
      return;
    }
    if (req.url !== "/v1/chat/completions") return json({ error: { message: "unknown endpoint" } }, 404);
    requests++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    heartbeatRequested = payload.sse_ping_interval === 15 && payload.return_progress === true && payload.timings_per_token === true;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, extra = {}, finish: string | null = null) => res.write(`data: ${JSON.stringify({
      id: `test-${requests}`, model: "test-model", object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
    })}\n\n`);
    chunk({ role: "assistant", content: null }, { prompt_progress: { total: 1000, cache: 200, processed: 200, time_ms: 0 } });
    const ping = setInterval(() => res.write(":\n\n"), 150);
    const finish = later(() => {
      chunk({}, { prompt_progress: { total: 1000, cache: 200, processed: 1000, time_ms: 2100 } });
      const timings = { cache_n: 200, prompt_n: 800, prompt_ms: 2100, prompt_per_second: 380.95,
        predicted_n: 20, predicted_ms: 1000, predicted_per_second: 20 };
      if (mode === "tools" && requests === 1) {
        chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "noop", arguments: "{}" } }] }, { timings });
        chunk({}, {}, "tool_calls");
      } else { chunk({ content: "Hello" }, { timings }); chunk({}, {}, "stop"); }
      res.end("data: [DONE]\n\n");
    }, 2100);
    res.on("close", () => { clearInterval(ping); clearTimeout(finish); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await mkdir("work", { recursive: true });
  const directory = await mkdtemp(resolve("work/rpc-"));
  const agent = join(directory, "agent");
  await mkdir(agent);
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "test-llama": {
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic", api: "openai-completions",
    models: [{ id: "test-model", contextWindow: 32768, maxTokens: 64, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 700, retry: { enabled: false }, compaction: { enabled: false } }));
  const noop = join(directory, "noop.ts");
  await writeFile(noop, 'export default function(pi) { pi.registerTool({ name: "noop", label: "noop", description: "Test", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } }); }');
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-tools", "-e", extension, ...(mode === "tools" ? ["-e", noop] : []),
    "--provider", "test-llama", "--model", "test-model", "--pillama-provider", "test-llama"], {
    cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [], snapshots: Telemetry[] = [];
  let stderr = "", buffer = "", sentAbort = false;
  child.stderr.on("data", data => { stderr += data; });
  const completed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => reject(new Error(`Pi exited ${code}: ${stderr}`)));
    child.stdout.on("data", data => {
      buffer += data;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { reject(new Error(`Non-JSON RPC output: ${line}`)); return; }
        events.push(event);
        const snapshot = readTelemetry(event);
        if (snapshot) {
          snapshots.push(snapshot);
          if (mode === "cancel" && snapshot.phase === "loading" && !sentAbort) {
            sentAbort = true; child.stdin.write('{"type":"abort"}\n');
          }
        }
        if (event.type === "agent_end") resolve();
        if (event.type === "response" && event.success === false) reject(new Error(JSON.stringify(event)));
      }
    });
  });
  child.stdin.write('{"type":"prompt","message":"synthetic test"}\n');
  try {
    await Promise.race([completed, new Promise<never>((_, reject) => later(() => reject(new Error(`RPC timeout: ${stderr}\n${JSON.stringify(events.slice(-5))}`)), 15000))]);
    assert.equal(events.filter(event => event.type === "extension_error").length, 0, stderr);
    if (mode === "success" || mode === "tools") {
      assert(heartbeatRequested);
      assert.equal(requests, mode === "tools" ? 2 : 1);
      assert(snapshots.some(s => s.phase === "loading" && s.loading?.progress === 0.5));
      const done = snapshots.filter(s => s.phase === "done");
      assert.equal(done.length, mode === "tools" ? 2 : 1);
      assert.equal(done[0].prefill?.cached, 200);
      assert.equal(done[0].prefill?.total, 1000);
      assert.equal(done[0].decode?.tokensPerSecond, 20);
      assert(done[0].elapsedMs >= 3900, "total time includes cold load and response");
      assert(snapshots.filter(s => s.phase === "loading").length >= 2, "loading remains observable");
      const messages = events.filter(e => e.type === "message_end" && e.message.role === "assistant");
      assert(messages.some(e => e.message.content.some((b: any) => b.type === "text" && b.text === "Hello")));
      assert(!events.some(e => e.message?.role === "custom"), "telemetry must not enter conversation history");
      if (mode === "tools") assert.notEqual(done[0].requestId, done[1].requestId);
    } else {
      assert.equal(requests, 0, "failed/cancelled loading must not submit inference");
      const last = snapshots.at(-1)!;
      assert.equal(last.phase, mode === "cancel" ? "aborted" : "error");
      if (mode === "missing") assert.match(last.error ?? "", /not found/);
    }
  } finally {
    for (const timer of timers) clearTimeout(timer);
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const mode of ["success", "missing", "cancel", "failed", "tools"] as const) {
  test(`real Pi RPC: ${mode}`, { timeout: 20000 }, () => runProbe(mode));
}
