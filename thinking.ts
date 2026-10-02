import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { object } from "./telemetry.ts";
import { serverRoot } from "./router.ts";

// Pi's public vocabulary, not a table of model capabilities.
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = typeof levels[number];
type Model = NonNullable<ExtensionContext["model"]>;
type Json = Record<string, unknown>;
export const THINKING_KEY = "pillama:thinking";
export interface Thinking {
  provider: string; model: string; levels: Level[]; selected: Level;
  source: "automatic" | "user" | "server"; templateHash: string;
}
interface Detection { levels: Level[]; effort?: string; toggle: boolean; templateDefault?: Level; serverDefault?: Level }

/** Accept an explicit, rejecting enum guard. Never execute remote Jinja in this process. */
export function templateControls(template: string, caps: Json): Detection | undefined {
  if (template.length > 128 * 1024) return;
  const source = template.replace(/\{#[\s\S]*?#\}/g, "");
  const blocks = [...source.matchAll(/\{%[-+]?([\s\S]*?)[-+]?%\}/g)];
  const toggle = blocks.some(b => /\bif\s+enable_thinking\b/.test(b[1]));
  if (caps.supports_reasoning_effort === true) {
    for (const effort of ["reasoning_effort", "reasoning_strength"]) {
      const variables = new Set([effort]);
      for (const block of blocks) {
        const alias = block[1].trim().match(/^set\s+(\w+)\s*=\s*(\w+)(?:\s*\||\s*$)/);
        if (alias && variables.has(alias[2])) variables.add(alias[1]);
        const guard = block[1].trim().match(/^if\s+(\w+)\s+not\s+in\s*[\[(]([^\])]+)[\])]$/);
        if (!guard || !variables.has(guard[1])) continue;
        const following = source.slice(block.index! + block[0].length).split(/\{%/)[0];
        if (!/\{\{[-+]?\s*raise_exception\(/.test(following)) continue;
        const literals = guard[2].split(",").map(s => s.trim());
        if (literals.at(-1) === "") literals.pop();
        if (literals.length > levels.length || literals.some(s => !/^(['"])[a-z]+\1$/.test(s))) return;
        const values = literals.map(s => s.slice(1, -1));
        if (!values.length || values.some(v => v === "off" || !levels.includes(v as Level))) return;
        const declaredDefault = source.match(new RegExp(`\\b${effort}\\s*\\|\\s*default\\(\\s*['"]([a-z]+)['"]\\s*\\)`))?.[1];
        return { levels: levels.filter(l => values.includes(l)), effort, toggle,
          templateDefault: levels.includes(declaredDefault as Level) ? declaredDefault as Level : undefined };
      }
    }
    // Effort exists, but its accepted values are unclear: do not guess.
    return;
  }
  return toggle ? { levels: ["medium"], toggle: true, templateDefault: "medium" } : undefined;
}

function serverPolicy(args: unknown): { known: boolean; explicit: boolean; level?: Level } {
  if (!Array.isArray(args)) return { known: false, explicit: false };
  let explicit = false, level: Level | undefined;
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== "string") continue;
    const [flag, inline] = args[i].split(/=(.*)/s);
    const value = inline ?? args[i + 1];
    if (["--reasoning", "-rea", "--reasoning-effort", "--reasoning-budget", "--chat-template-kwargs", "--reasoning-preserve", "--no-reasoning-preserve"].includes(flag)) {
      explicit = true;
      if (flag === "--reasoning" || flag === "-rea") {
        if (value === "off") level = "off";
      } else if (flag === "--reasoning-effort" && levels.includes(value)) level = value;
    }
  }
  return { known: true, explicit, level };
}

function nativeDefaults(model: Model): boolean {
  const c = object(model.compat);
  if (c.supportsReasoningEffort !== false || c.supportsStore !== false || c.maxTokensField !== "max_tokens") return false;
  if (c.thinkingTokenBudgetField || c.supportsThinkingTokenBudget || c.chatTemplateKwargs || model.samplingParams) return false;
  if (model.reasoning) {
    return c.thinkingFormat === "qwen-chat-template" && levels.every(l => {
      const actual = model.thinkingLevelMap?.[l];
      return l === "off" || l === "medium" ? actual === l : actual === null || (l === "max" && actual === undefined);
    });
  }
  return !model.thinkingLevelMap && !c.thinkingFormat;
}

function cliLevel(): Level | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    const value = args[i] === "--thinking" ? args[i + 1] : args[i].startsWith("--thinking=") ? args[i].slice(11)
      : args[i] === "--model" ? args[i + 1]?.split(":").at(-1) : undefined;
    if (levels.includes(value as Level)) return value as Level;
  }
}

/** Session-only discovery and model metadata. No provider replacement or models.json writes. */
export function thinkingController(pi: ExtensionAPI, agentDir = getAgentDir()) {
  pi.registerFlag("pillama-thinking", { type: "string", default: "auto", description: "Discover llama.cpp thinking at load time (auto or off)" });
  let life = new AbortController(), timer: ReturnType<typeof setInterval> | undefined;
  let context: ExtensionContext | undefined, pending: Promise<void> | undefined, applying = false;
  let observedModel: Model | undefined;
  let requestLevel: { provider: string; model: string; level: Level } | undefined;
  let managed: { model: Model; original: Model; detection: Detection; data: Thinking; server: boolean } | undefined;
  const manual = new Map<string, Level>();
  const cache = new Map<string, Detection | undefined>();
  const key = (model: Model) => `${model.provider}/${model.id}`;
  const publish = (ctx: ExtensionContext) => {
    const data = managed && ctx.model === managed.model ? structuredClone(managed.data) : null;
    if (ctx.mode === "rpc") ctx.ui.setStatus(THINKING_KEY, data ? JSON.stringify(data) : undefined);
    pi.events.emit(THINKING_KEY, data);
  };
  const restore = async (ctx: ExtensionContext) => {
    const previous = managed;
    managed = undefined;
    if (previous && ctx.model === previous.model) {
      applying = true;
      try { await pi.setModel(previous.original); observedModel = ctx.model; }
      finally { applying = false; }
    }
    publish(ctx);
  };
  const desired = (ctx: ExtensionContext, model: Model): Level | undefined => {
    const settings = pi.getSettings();
    return manual.get(key(model)) ?? cliLevel() ?? ctx.scopedModels.find(m => m.model.id === model.id && m.model.provider === model.provider)?.thinkingLevel
      ?? settings.modelThinkingLevels?.[key(model)] ?? settings.defaultThinkingLevel;
  };
  const userMetadata = async (model: Model) => {
    try {
      const config = object(JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")));
      const provider = object(object(config.providers)[model.provider]);
      const override = object(object(provider.modelOverrides)[model.id]);
      const definition = Array.isArray(provider.models) ? provider.models.map(object).find(m => m.id === model.id) : undefined;
      return [provider, override, definition].some(raw => raw && Object.keys(raw).some(k =>
        ["reasoning", "thinkingLevelMap", "samplingParams"].includes(k) || (k === "compat" && Object.keys(object(raw[k])).some(c => /thinking|reasoning|chatTemplate/i.test(c)))));
    } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  };
  async function inspect(ctx: ExtensionContext) {
    const model = ctx.model;
    if (!model || model.provider !== pi.getFlag("pillama-provider") || model.api !== "openai-completions" || pi.getFlag("pillama-thinking") !== "auto") return;
    const original = managed?.model === model ? managed.original : model;
    if (!nativeDefaults(original) || await userMetadata(original)) { if (managed?.model === model) await restore(ctx); return; }
    const signal = AbortSignal.any([life.signal, ...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(10_000)]);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return;
    const headers = new Headers({ "Content-Type": "application/json" });
    if (auth.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);
    for (const [k, v] of Object.entries({ ...model.headers, ...auth.headers })) {
      if (v !== null && v !== undefined) headers.set(k, v); else headers.delete(k);
    }
    const root = serverRoot(auth.baseUrl ?? model.baseUrl);
    const request = async (path: string, body?: Json) => {
      const response = await fetch(root + path, { headers, signal, method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(`Thinking discovery: HTTP ${response.status}`);
      return object(await response.json());
    };
    const catalog = await request("/models");
    const entry = Array.isArray(catalog.data) ? catalog.data.map(object).find(e => e.id === model.id || (Array.isArray(e.aliases) && e.aliases.includes(model.id))) : undefined;
    if (!entry || object(entry.status).value !== "loaded") return;
    const policy = serverPolicy(object(entry.status).args);
    // Without launch arguments the API cannot prove that server defaults were not explicitly set.
    if (!policy.known) { if (managed?.model === model) await restore(ctx); return; }
    const suffix = `?model=${encodeURIComponent(model.id)}&autoload=false`;
    const props = await request("/props" + suffix);
    if (props.is_sleeping || typeof props.chat_template !== "string") return;
    const templateHash = createHash("sha256").update(props.chat_template).digest("hex");
    const fingerprint = JSON.stringify([root, model.id, templateHash, object(entry.status).args, props.chat_template_caps]);
    if (!cache.has(fingerprint)) {
      const detection = templateControls(props.chat_template, object(props.chat_template_caps));
      if (!detection) { cache.set(fingerprint, undefined); if (managed?.model === model) await restore(ctx); return; }
      const render = async (kwargs: Json) => {
        const result = await request("/apply-template" + suffix, { model: model.id, messages: [{ role: "user", content: "Hello" }], chat_template_kwargs: kwargs });
        if (typeof result.prompt !== "string" || !result.prompt) throw new Error("Missing rendered template");
        return result.prompt;
      };
      const prompts = await Promise.all(detection.levels.map(level => render({ ...(detection.toggle ? { enable_thinking: true } : {}), ...(detection.effort ? { [detection.effort]: level } : {}) })));
      if (detection.effort && new Set(prompts).size < 2) { cache.set(fingerprint, undefined); if (managed?.model === model) await restore(ctx); return; }
      const serverPrompt = await render({});
      const matches = detection.levels.filter((_, i) => prompts[i] === serverPrompt);
      if (matches.length === 1) detection.serverDefault = matches[0];
      if (detection.toggle) {
        const off = await render({ enable_thinking: false });
        if (prompts.some(p => p === off)) { cache.set(fingerprint, undefined); if (managed?.model === model) await restore(ctx); return; }
        if (serverPrompt === off) detection.serverDefault = "off";
        detection.levels = ["off", ...detection.levels];
      }
      cache.set(fingerprint, detection);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    const detection = cache.get(fingerprint);
    if (ctx.model !== model || signal.aborted) return;
    if (!detection) { if (managed?.model === model) await restore(ctx); return; }
    const current = pi.getThinkingLevel();
    const explicit = desired(ctx, model);
    // Rendered defaults also catch server environment settings absent from router argv.
    const server = policy.explicit || !detection.templateDefault || detection.serverDefault !== detection.templateDefault;
    const selected = explicit ?? (server ? policy.level ?? detection.serverDefault ?? current : detection.levels.at(-1)!);
    // A user's choice unavailable in this template must not be silently promoted.
    if (!detection.levels.includes(selected)) return;
    const source = explicit ? "user" : server ? "server" : "automatic";
    if (managed?.model === model && managed.data.templateHash === templateHash && managed.data.selected === selected && managed.data.source === source) return;
    const updated: Model = { ...original, reasoning: true, thinkingLevelMap: Object.fromEntries(levels.map(l => [l, detection.levels.includes(l) ? l : null])) };
    applying = true;
    try {
      if (!await pi.setModel(updated)) return;
      pi.setThinkingLevel(selected);
      observedModel = updated;
      managed = { model: updated, original, detection, server,
        data: { provider: model.provider, model: model.id, levels: [...detection.levels], selected, source, templateHash } };
    } finally { applying = false; }
    publish(ctx);
  }
  const refresh = async (ctx: ExtensionContext) => {
    if (pending) await pending;
    const task = inspect(ctx).catch(() => { /* Optional discovery must never break inference. */ });
    pending = task;
    try { await task; } finally { if (pending === task) pending = undefined; }
  };
  pi.on("thinking_level_select", (event, ctx) => {
    if (applying || !ctx.model || ctx.model !== observedModel) return;
    manual.set(key(ctx.model), event.level);
    if (managed?.model === ctx.model) {
      managed.data.selected = event.level; managed.data.source = "user"; publish(ctx);
    }
  });
  // A cold load can discover effort after Pi has captured its request options.
  // Keep finalized response metadata consistent with the payload actually sent.
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    const sent = requestLevel; requestLevel = undefined;
    if (sent && event.message.provider === sent.provider && event.message.model === sent.model)
      return { message: { ...event.message, thinkingLevel: sent.level } };
  });
  pi.on("session_start", async (_event, ctx) => {
    life.abort(); life = new AbortController(); clearInterval(timer); manual.clear(); managed = undefined; context = ctx; observedModel = ctx.model;
    const entries = ctx.sessionManager.getBranch();
    if (ctx.model && (entries.filter(e => e.type === "thinking_level_change").length > 1 || (ctx.model.reasoning && pi.getThinkingLevel() !== "medium"))) manual.set(key(ctx.model), pi.getThinkingLevel());
    await refresh(ctx);
    timer = setInterval(() => { if (context?.isIdle() && !pending) void refresh(context); }, 5000);
    timer.unref();
  });
  pi.on("model_select", async (_event, ctx) => {
    context = ctx; observedModel = ctx.model;
    if (applying) return;
    publish(ctx); await refresh(ctx);
  });
  pi.on("session_shutdown", () => { life.abort(); clearInterval(timer); context = undefined; cache.clear(); });
  return {
    refresh,
    payload(payload: Json, ctx: ExtensionContext, previousLevel: Level): Json {
      requestLevel = undefined;
      if (!managed || ctx.model !== managed.model) return payload;
      // Respect request-level controls from another extension or explicit sampling config.
      const kwargs = object(payload.chat_template_kwargs);
      if (["reasoning_effort", "thinking", "reasoning", "enable_thinking"].some(k => k in payload) || managed.detection.effort && managed.detection.effort in kwargs) return payload;
      if ("enable_thinking" in kwargs && (!managed.original.reasoning || kwargs.enable_thinking !== (previousLevel !== "off"))) return payload;
      const next = { ...kwargs };
      if (managed.server && next.preserve_thinking === true) delete next.preserve_thinking;
      if (managed.server && managed.data.source !== "user") {
        delete next.enable_thinking;
      } else {
        const selected = pi.getThinkingLevel();
        if (managed.detection.toggle) next.enable_thinking = selected !== "off";
        if (selected !== "off" && managed.detection.effort) next[managed.detection.effort] = selected;
      }
      const actual = managed.server && managed.data.source !== "user" ? managed.detection.serverDefault : pi.getThinkingLevel();
      if (actual) requestLevel = { provider: managed.data.provider, model: managed.data.model, level: actual };
      return { ...payload, chat_template_kwargs: next };
    },
  };
}
