import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareModel } from "./router.ts";
import { thinkingController, type GeneratedProvider } from "./thinking.ts";
import { resumeController } from "./resume.ts";
import { formatStatus, object, STATUS_KEY, TELEMETRY_KEY, updateStream, type Telemetry } from "./telemetry.ts";

export { readTelemetry, STATUS_KEY, TELEMETRY_KEY, type Telemetry } from "./telemetry.ts";
export { THINKING_KEY, type Thinking } from "./thinking.ts";

export default function pillama(pi: ExtensionAPI, options: { agentDir?: string; isGeneratedProvider?: GeneratedProvider } = {}): void {
  pi.registerFlag("pillama-provider", {
    description: "llama.cpp provider ID to monitor", type: "string", default: "llama.cpp",
  });
  resumeController(pi, options.agentDir);
  const thinking = thinkingController(pi, options.agentDir, options.isGeneratedProvider);
  let active: { state: Telemetry; ctx: ExtensionContext; started: number;
    controller: AbortController; timer?: ReturnType<typeof setInterval>; lastPublish: number;
    finished: boolean; unlink: () => void } | undefined;

  const publish = (force = false) => {
    const run = active;
    if (!run) return;
    const now = performance.now();
    if (!force && now - run.lastPublish < 250) return;
    run.lastPublish = now;
    run.state.elapsedMs = Math.round(now - run.started);
    run.state.text = formatStatus(run.state);
    const snapshot = structuredClone(run.state);
    if (run.ctx.mode === "tui") {
      // Native footer statuses truncate; Text widgets wrap and reflow on resize.
      run.ctx.ui.setWidget(STATUS_KEY, [run.ctx.ui.theme.fg("dim", snapshot.text)], { placement: "belowEditor" });
    } else run.ctx.ui.setStatus(STATUS_KEY, snapshot.text);
    // Native RPC transport: no stdout patches, custom protocol, or transcript messages.
    if (run.ctx.mode === "rpc") run.ctx.ui.setStatus(TELEMETRY_KEY, JSON.stringify(snapshot));
    pi.events.emit(TELEMETRY_KEY, snapshot);
  };
  const finish = (phase: "done" | "aborted" | "error", error?: string) => {
    if (!active || active.finished) return;
    active.finished = true;
    active.state.phase = phase;
    active.state.error = error;
    clearInterval(active.timer);
    active.unlink();
    active.controller.abort();
    publish(true);
  };
  const clear = (_event: unknown, ctx: ExtensionContext) => {
    finish("aborted");
    active = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (ctx.mode === "tui") ctx.ui.setWidget(STATUS_KEY, undefined);
    if (ctx.mode === "rpc") ctx.ui.setStatus(TELEMETRY_KEY, undefined);
    pi.events.emit(TELEMETRY_KEY, null);
  };

  pi.on("before_provider_request", async (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== pi.getFlag("pillama-provider") || model.api !== "openai-completions") return;
    finish("aborted");
    const previousThinking = pi.getThinkingLevel();
    let payload = object(event.payload);
    const controller = new AbortController();
    const abort = () => { if (active?.controller === controller) finish("aborted"); };
    const signal = ctx.signal;
    active = {
      state: { version: 1, requestId: randomUUID(), provider: model.provider,
        model: typeof payload.model === "string" ? payload.model : model.id,
        phase: "connecting", startedAt: Date.now(), elapsedMs: 0, text: "" },
      ctx, started: performance.now(), controller, lastPublish: -Infinity, finished: false,
      unlink: () => signal?.removeEventListener("abort", abort),
    };
    const run = active;
    signal?.addEventListener("abort", abort, { once: true });
    run.timer = setInterval(() => publish(true), 1000);
    run.timer.unref();
    publish(true);
    try {
      signal?.throwIfAborted();
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const headers = new Headers({ "Content-Type": "application/json" });
      if (auth.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);
      for (const [key, value] of Object.entries({ ...model.headers, ...auth.headers })) {
        if (value !== null && value !== undefined) headers.set(key, value);
        else headers.delete(key);
      }
      await prepareModel({ baseUrl: auth.baseUrl ?? model.baseUrl, model: run.state.model, headers,
        signal: controller.signal, onLoading: loading => {
          if (active !== run || run.finished) return;
          run.state.phase = "loading";
          run.state.loading = loading;
          publish();
        },
      });
      if (!run.finished) {
        await thinking.refresh(ctx);
        payload = thinking.payload(payload, ctx, previousThinking);
      }
      if (!run.finished) { run.state.phase = "waiting"; publish(true); }
    } catch (error) {
      if (active === run && !run.finished) {
        finish(signal?.aborted ? "aborted" : "error", signal?.aborted ? undefined : String(error instanceof Error ? error.message : error));
        // Pi logs exceptions from payload hooks and continues. Abort explicitly so a
        // missing/failed model cannot silently fall through into a long inference wait.
        ctx.abort();
      }
    }
    return { ...payload, stream: true, return_progress: true, timings_per_token: true, sse_ping_interval: 15 };
  });
  pi.on("provider_stream_event", (event) => {
    if (!active || active.finished || event.provider !== active.state.provider || event.model !== active.state.model) return;
    updateStream(active.state, event.data);
    publish();
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (!active || active.finished || message.role !== "assistant" || message.provider !== active.state.provider) return;
    finish(message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "done", message.errorMessage);
  });
  pi.on("agent_end", () => { if (active && !active.finished) finish("aborted"); });
  pi.on("model_select", clear);
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
}
