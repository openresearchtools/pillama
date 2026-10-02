import { setTimeout as sleep } from "node:timers/promises";
import { object, number, type Telemetry } from "./telemetry.ts";

/** Strip only the API suffix; preserve reverse-proxy path prefixes. */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function loadProgress(data: unknown): Telemetry["loading"] {
  const p = object(object(data).progress);
  const stage = typeof p.current === "string" ? p.current : typeof p.stage === "string" ? p.stage : undefined;
  const ratio = number(p.value);
  const stageProgress = ratio === undefined ? undefined : Math.min(1, ratio);
  const stages = Array.isArray(p.stages) ? p.stages : [];
  const index = stages.indexOf(stage);
  return { stage, stageProgress,
    progress: index >= 0 && stageProgress !== undefined ? (index + stageProgress) / stages.length : stageProgress };
}

/** SSE framing handles split UTF-8, CRLF, multiline data, comments, and bounded frames. */
export async function watchModels(response: Response, onEvent: (data: unknown) => void): Promise<void> {
  if (!response.ok || !response.body) throw new Error(`Model events: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { continue; }
          onEvent(parsed);
        }
      }
      if (buffer.length > 1024 * 1024) throw new Error("Model event exceeds 1 MiB");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Load before inference, so a cold model does not consume the inference header timeout. */
export async function prepareModel(options: {
  baseUrl: string; model: string; headers: Headers; signal: AbortSignal;
  onLoading: (progress: Telemetry["loading"]) => void;
}): Promise<void> {
  const { model, headers, signal, onLoading } = options;
  const root = serverRoot(options.baseUrl);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${root}${path}`, {
      headers, method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(String(object(object(data).error).message ?? `llama.cpp: HTTP ${response.status}`));
    return object(data);
  };
  const list = async () => {
    const data = await request("/models");
    if (!Array.isArray(data.data)) throw new Error("llama.cpp returned an invalid model list");
    return data.data.map(object);
  };
  const models = await list();
  if (models.length === 0) throw new Error(`Model not found: ${model}`);
  // Single-model llama-server exposes OpenAI model records without router status.
  if (!models.some(item => typeof object(item.status).value === "string")) return;
  const match = (item: Record<string, unknown>) => item.id === model || (Array.isArray(item.aliases) && item.aliases.includes(model));
  let entry = models.find(match);
  if (!entry) throw new Error(`Model not found: ${model}`);
  if (object(entry.status).value === "loaded" || object(entry.status).value === "sleeping") return;
  const canonical = String(entry.id);
  const watcher = new AbortController();
  const watchSignal = AbortSignal.any([signal, watcher.signal]);
  let failure: string | undefined;
  onLoading(undefined);
  // Start listening before initiating loading. Short catalog requests remain authoritative
  // if the event stream is unavailable or reconnects during a quiet loading stage.
  const watching = (async () => {
    while (!watchSignal.aborted) {
      try {
        const response = await fetch(`${root}/models/sse`, {
          headers, signal: AbortSignal.any([watchSignal, AbortSignal.timeout(30_000)]),
        });
        await watchModels(response, raw => {
          const event = object(raw), data = object(event.data);
          if (event.model !== canonical && event.model !== model) return;
          if (event.event === "status_change" || event.event === "model_status") {
            if (data.status === "loading") onLoading(loadProgress(data));
            if (data.status === "unloaded") failure = "Model failed to load or was unloaded";
          }
        });
      } catch { /* Catalog polling still detects readiness and failure. */ }
      await sleep(1000, undefined, { signal: watchSignal }).catch(() => {});
    }
  })();
  try {
    const initialStatus = object(entry.status).value;
    if (initialStatus === "downloading") throw new Error(`Model is still downloading: ${model}`);
    if (initialStatus === "unloaded") {
      const props = await request("/props");
      if (props.models_autoload === false) throw new Error(`Model is unloaded; load it with /llama: ${model}`);
      try { await request("/models/load", { model: canonical }); }
      catch (error) {
        // Another client can win the load race. Accept only an actually running model.
        const current = (await list()).find(match);
        if (!["loading", "loaded", "sleeping"].includes(String(object(current?.status).value))) throw error;
      }
    }
    while (true) {
      signal.throwIfAborted();
      entry = (await list()).find(match);
      const status = object(entry?.status);
      if (!entry) throw new Error(`Model not found: ${model}`);
      if (status.value === "loaded" || status.value === "sleeping") return;
      if (failure || status.failed || status.value === "unloaded") throw new Error(failure ?? `Model failed to load: ${model}`);
      await sleep(1000, undefined, { signal });
    }
  } finally {
    watcher.abort();
    await watching;
  }
}
