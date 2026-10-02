/** Native Pi event-bus channel and RPC setStatus key for machine-readable snapshots. */
export const TELEMETRY_KEY = "pillama:telemetry";
export const STATUS_KEY = "pillama";

export interface Telemetry {
  version: 1;
  requestId: string;
  provider: string;
  model: string;
  phase: "connecting" | "loading" | "waiting" | "prefill" | "decode" | "done" | "aborted" | "error";
  startedAt: number;
  elapsedMs: number;
  loading?: { stage?: string; stageProgress?: number; progress?: number };
  prefill?: { total: number; processed: number; cached: number; ms?: number; tokensPerSecond?: number };
  decode?: { tokens: number; ms?: number; tokensPerSecond?: number };
  error?: string;
  text: string;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** All speeds are server token counts, never text/SSE chunk counts. */
export function updateStream(state: Telemetry, data: unknown): void {
  const chunk = object(data);
  const progress = object(chunk.prompt_progress);
  const total = number(progress.total), processed = number(progress.processed), cached = number(progress.cache);
  if (total !== undefined && processed !== undefined && cached !== undefined) {
    const ms = number(progress.time_ms);
    state.phase = "prefill";
    state.prefill = { total, processed, cached, ms,
      tokensPerSecond: ms && processed >= cached ? (processed - cached) * 1000 / ms : undefined };
  }
  const timings = object(chunk.timings);
  const prompt = number(timings.prompt_n), cache = number(timings.cache_n);
  if (prompt !== undefined) {
    const reused = cache ?? state.prefill?.cached ?? 0;
    const count = prompt + reused;
    state.prefill = {
      total: state.prefill?.total ?? count,
      processed: Math.max(state.prefill?.processed ?? 0, count), cached: reused,
      ms: number(timings.prompt_ms) ?? state.prefill?.ms,
      tokensPerSecond: number(timings.prompt_per_second) ?? state.prefill?.tokensPerSecond,
    };
  }
  const generated = number(timings.predicted_n);
  if (generated !== undefined) {
    state.decode = { tokens: generated, ms: number(timings.predicted_ms),
      tokensPerSecond: number(timings.predicted_per_second) };
    if (generated > 0) state.phase = "decode";
  }
  // Some chunks contain content but no timings (including buffered reasoning/tool deltas).
  const choice = object(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
  const delta = object(choice.delta);
  if (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls) state.phase = "decode";
}

export function formatStatus(state: Telemetry): string {
  const rate = (value?: number) => value === undefined ? "—" : value.toFixed(1);
  const parts = ["llama.cpp"];
  if (state.phase === "loading") {
    const pct = state.loading?.progress;
    parts.push(`loading ${pct === undefined ? "…" : `${Math.round(pct * 100)}%`}`);
    if (state.loading?.stage) parts.push(state.loading.stage.replaceAll("_", " "));
  } else if (!["prefill", "decode", "done"].includes(state.phase)) parts.push(state.phase);
  if (state.prefill) {
    const p = state.prefill;
    const percent = p.total > 0 ? ` ${Math.min(100, Math.floor(p.processed / p.total * 100))}%` : "";
    parts.push(`prefill${percent} ${p.processed}/${p.total} (${p.cached} cached) ${rate(p.tokensPerSecond)} tok/s`);
  }
  if (state.decode && state.decode.tokens > 0) {
    parts.push(`decode ${rate(state.decode.tokensPerSecond)} tok/s (${state.decode.tokens} tokens)`);
  }
  parts.push(`total ${(state.elapsedMs / 1000).toFixed(1)}s`);
  if (state.error) parts.push(state.error.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 180));
  return parts.join(" · ");
}

/** Decode Pi's native RPC status event. undefined = unrelated; null = cleared. */
export function readTelemetry(event: unknown): Telemetry | null | undefined {
  const value = object(event);
  if (value.type !== "extension_ui_request" || value.method !== "setStatus" || value.statusKey !== TELEMETRY_KEY) return;
  if (value.statusText === undefined) return null;
  if (typeof value.statusText !== "string") return;
  try {
    const data = JSON.parse(value.statusText);
    if (data?.version === 1 && typeof data.requestId === "string" && typeof data.phase === "string") return data;
  } catch { /* Ignore events from incompatible clients. */ }
}
