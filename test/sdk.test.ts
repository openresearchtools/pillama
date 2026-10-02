import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import pillama, { TELEMETRY_KEY, type Telemetry } from "../index.ts";

test("real headless SDK publishes structured snapshots through Pi's event bus", async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/models") {
      res.setHeader("content-type", "application/json");
      // A single-model server needs no router-loading endpoints.
      res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
      return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    for await (const part of req) body += part;
    assert.equal(JSON.parse(body).sse_ping_interval, 15);
    res.setHeader("content-type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ id: "sdk-response", choices: [{ delta: { content: "SDK works" }, finish_reason: null }],
      timings: { cache_n: 10, prompt_n: 20, predicted_n: 3, predicted_per_second: 30 } })}\n\n`);
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await mkdir("work", { recursive: true });
  const directory = await mkdtemp(resolve("work/sdk-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "llama.cpp": {
    baseUrl, apiKey: "synthetic", api: "openai-completions", models: [{ id: "sdk-model", contextWindow: 32768, maxTokens: 32 }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "llama.cpp", defaultModel: "sdk-model", retry: { enabled: false }, compaction: { enabled: false } }));
  const eventBus = createEventBus();
  const snapshots: Telemetry[] = [];
  const off = eventBus.on(TELEMETRY_KEY, data => { if (data) snapshots.push(data as Telemetry); });
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir, eventBus,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pillama] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir, resourceLoader, tools: [], sessionManager: SessionManager.inMemory(directory) });
  try {
    await session.bindExtensions({ mode: "json" });
    await session.prompt("synthetic SDK test");
    const done = snapshots.at(-1)!;
    assert.equal(done.phase, "done");
    assert.equal(done.prefill?.total, 30);
    assert.equal(done.prefill?.cached, 10);
    assert.equal(done.decode?.tokensPerSecond, 30);
    assert(!session.state.messages.some(message => message.role === "custom"));
    assert.equal(snapshots[0].phase, "connecting", "consumer snapshots are not later mutated");
  } finally {
    off(); session.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
