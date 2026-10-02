import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createLlamaProvider } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/provider.js";
import pillama, { THINKING_KEY, type Thinking } from "../index.ts";
import { templateControls } from "../thinking.ts";

const template = `{% if enable_thinking is undefined or enable_thinking is true %}
{% set resolved = reasoning_effort|default('medium') %}
{% if resolved not in ('low', 'medium', 'xhigh') %}
{{ raise_exception('Unsupported effort') }}
{% endif %}{% endif %}`;
const caps = { supports_reasoning_effort: true };

test("template detection requires an explicit rejecting enum and ignores comments", () => {
  assert.deepEqual(templateControls(template, caps)?.levels, ["low", "medium", "xhigh"]);
  assert.equal(templateControls(`{# ${template} #}`, caps), undefined);
  assert.equal(templateControls("{{ reasoning_effort }}", caps), undefined);
  assert.equal(templateControls(template.replace("xhigh", "mystery"), caps), undefined);
  assert.deepEqual(templateControls("{% if enable_thinking %}think{% endif %}", {})?.levels, ["medium"]);
});

async function fixture(options: { loaded?: boolean; args?: string[]; unknown?: boolean; toggle?: boolean; settings?: object; override?: object; serverDefault?: string; ignored?: boolean; unavailable?: boolean; onProps?: () => void; exposeArgs?: boolean } = {}) {
  let loaded = options.loaded ?? true;
  const requests: any[] = [], snapshots: Thinking[] = [];
  let probes = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    const json = (data: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
    let text = "";
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : {};
    if (url.pathname === "/models") return json({ data: [{ id: "discovered-model", source: "preset", status: { value: loaded ? "loaded" : "unloaded", ...(options.exposeArgs === false ? {} : { args: options.args ?? [] }) } }] });
    if (url.pathname === "/props" && !url.searchParams.has("model")) return json({ models_autoload: true });
    if (url.pathname === "/models/load") { loaded = true; return json({ success: true }); }
    if (url.pathname === "/models/sse") { res.writeHead(404); return res.end(); }
    if (url.pathname === "/props") {
      options.onProps?.();
      assert(loaded, "discovery must not query an unloaded model");
      assert.equal(url.searchParams.get("autoload"), "false");
      if (options.unavailable) { res.writeHead(404); return res.end(); }
      return json({ chat_template: options.unknown ? "unknown template" : options.toggle ? "{% if enable_thinking %}think{% endif %}" : template,
        chat_template_caps: options.toggle ? {} : caps });
    }
    if (url.pathname === "/apply-template") {
      probes++;
      assert.equal(url.searchParams.get("autoload"), "false");
      const kwargs = body.chat_template_kwargs ?? {};
      const serverDefault = options.serverDefault ?? (options.args?.includes("--reasoning-effort") ? options.args[options.args.indexOf("--reasoning-effort") + 1] : "medium");
      return json({ prompt: options.ignored ? "unchanged" : kwargs.enable_thinking === false ? "off" : options.toggle ? "on" : `effort=${kwargs.reasoning_effort ?? serverDefault}` });
    }
    if (url.pathname === "/v1/chat/completions") {
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await mkdir("work", { recursive: true });
  const directory = await mkdtemp(resolve("work/thinking-"));
  const agentDir = join(directory, "agent"); await mkdir(agentDir);
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "llama.cpp": { type: "api_key", key: "synthetic", env: { LLAMA_BASE_URL: baseUrl } } }));
  const settings = JSON.stringify({ defaultProvider: "llama.cpp", defaultModel: "discovered-model", retry: { enabled: false }, compaction: { enabled: false }, ...options.settings });
  await writeFile(join(agentDir, "settings.json"), settings);
  const models = JSON.stringify({ providers: options.override ? { "llama.cpp": { modelOverrides: { "discovered-model": options.override } } } : {} });
  await writeFile(join(agentDir, "models.json"), models);
  const bus = createEventBus();
  bus.on(THINKING_KEY, data => { if (data) snapshots.push(data as Thinking); });
  const provider = createLlamaProvider();
  provider.setCatalog([{ id: "discovered-model", status: { value: "loaded" }, meta: { n_ctx: 32768 } } as any], baseUrl);
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir, eventBus: bus, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, extensionFactories: [pi => pi.registerProvider(provider.provider), pi => pillama(pi, { agentDir })] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir, model: provider.provider.getModels()[0], resourceLoader: loader, tools: [], sessionManager: SessionManager.inMemory(directory) });
  await session.bindExtensions({ mode: "json" });
  return { session, requests, snapshots, get probes() { return probes; },
    async close() {
      await session.dispose();
      assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), models);
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), settings);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    } };
}

test("native Pi discovers levels, selects highest, and honors later SDK choices without rewriting config", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.session.getAvailableThinkingLevels(), ["off", "low", "medium", "xhigh"]);
    assert.equal(f.session.thinkingLevel, "xhigh");
    await f.session.prompt("first");
    assert.equal(f.requests[0].chat_template_kwargs.reasoning_effort, "xhigh");
    f.session.setThinkingLevel("low");
    await f.session.prompt("second");
    assert.equal(f.requests[1].chat_template_kwargs.reasoning_effort, "low");
    f.session.setThinkingLevel("off");
    await f.session.prompt("third");
    assert.equal(f.requests[2].chat_template_kwargs.enable_thinking, false);
    assert.equal(f.requests[2].chat_template_kwargs.reasoning_effort, undefined);
    assert(f.requests.every(r => r.thinking_budget_tokens === undefined && r.reasoning_budget_tokens === undefined));
    assert.equal(f.probes, 5, "verified template cached only in memory");
    assert.equal(f.snapshots.at(-1)?.source, "user");
  } finally { await f.close(); }
});

test("cold load discovers before first inference and retains Pi's native level API", async () => {
  const f = await fixture({ loaded: false });
  try {
    assert.equal(f.probes, 0);
    await f.session.prompt("cold");
    assert.equal(f.requests[0].chat_template_kwargs.reasoning_effort, "xhigh");
    assert.equal(f.session.thinkingLevel, "xhigh");
    assert.equal((f.session.state.messages.at(-1) as any).thinkingLevel, "xhigh");
  } finally { await f.close(); }
});

test("explicit Pi default beats automatic maximum", async () => {
  const f = await fixture({ settings: { defaultThinkingLevel: "low" } });
  try {
    assert.equal(f.session.thinkingLevel, "low");
    await f.session.prompt("manual");
    assert.equal(f.requests[0].chat_template_kwargs.reasoning_effort, "low");
  } finally { await f.close(); }
});

test("server reasoning flags remain server-controlled until the user selects an effort", async () => {
  const f = await fixture({ args: ["--reasoning-effort", "low", "--reasoning-budget", "4096"] });
  try {
    assert.equal(f.session.thinkingLevel, "low");
    await f.session.prompt("server");
    assert.deepEqual(f.requests[0].chat_template_kwargs, {});
    f.session.setThinkingLevel("xhigh");
    await f.session.prompt("user");
    assert.equal(f.requests[1].chat_template_kwargs.reasoning_effort, "xhigh");
    assert.equal(f.requests[1].reasoning_budget_tokens, undefined);
  } finally { await f.close(); }
});

test("unknown template and explicit model metadata are left alone", async () => {
  for (const options of [{ unknown: true }, { override: { reasoning: false } }]) {
    const f = await fixture(options);
    try {
      assert.deepEqual(f.session.getAvailableThinkingLevels(), ["off"]);
      assert.equal(f.snapshots.length, 0);
      await f.session.prompt("untouched");
      assert.equal(f.requests[0].chat_template_kwargs, undefined);
    } finally { await f.close(); }
  }
});

test("verified on/off template enables Pi medium without manufacturing effort or budget", async () => {
  const f = await fixture({ toggle: true });
  try {
    assert.deepEqual(f.session.getAvailableThinkingLevels(), ["off", "medium"]);
    assert.equal(f.session.thinkingLevel, "medium");
    await f.session.prompt("toggle");
    assert.deepEqual(f.requests[0].chat_template_kwargs, { enable_thinking: true });
  } finally { await f.close(); }
});

test("a server default differing from the declared template default wins even without an argv flag", async () => {
  const f = await fixture({ serverDefault: "low" });
  try {
    assert.equal(f.session.thinkingLevel, "low");
    assert.equal(f.snapshots.at(-1)?.source, "server");
    await f.session.prompt("server environment");
    assert.deepEqual(f.requests[0].chat_template_kwargs, {});
  } finally { await f.close(); }
});

test("ignored controls and unavailable discovery endpoints never alter inference", async () => {
  for (const options of [{ ignored: true }, { unavailable: true }, { exposeArgs: false }]) {
    const f = await fixture(options);
    try {
      assert.deepEqual(f.session.getAvailableThinkingLevels(), ["off"]);
      await f.session.prompt("fallback");
      assert.equal(f.requests[0].chat_template_kwargs, undefined);
    } finally { await f.close(); }
  }
});

test("cancelling discovery after a cold load never submits inference or changes the model", async () => {
  const options: { loaded: boolean; onProps?: () => void } = { loaded: false };
  const f = await fixture(options);
  options.onProps = () => { void f.session.abort(); };
  try {
    await f.session.prompt("cancel discovery");
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.session.getAvailableThinkingLevels(), ["off"]);
  } finally { await f.close(); }
});

test("a changed unrecognized template removes previously discovered controls", async () => {
  const options = { unknown: false };
  const f = await fixture(options);
  try {
    assert.equal(f.session.thinkingLevel, "xhigh");
    options.unknown = true;
    await f.session.prompt("changed model template");
    assert.deepEqual(f.session.getAvailableThinkingLevels(), ["off"]);
    assert.equal(f.requests[0].chat_template_kwargs?.reasoning_effort, undefined);
  } finally { await f.close(); }
});
