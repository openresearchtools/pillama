import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FetchFunction } from "@earendil-works/pi-ai";

export interface ResumeSettings { enabled: boolean; attempts: number }
const defaults: ResumeSettings = { enabled: false, attempts: 3 };

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function settings(value: unknown): ResumeSettings {
  if (value === undefined) return { ...defaults };
  const input = object(value, "pillama resume");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw Error("pillama resume.enabled must be boolean");
  if (input.attempts !== undefined && (typeof input.attempts !== "number" || !Number.isSafeInteger(input.attempts) || input.attempts < 0)) {
    throw Error("pillama resume.attempts must be a non-negative integer");
  }
  return { enabled: input.enabled as boolean | undefined ?? defaults.enabled,
    attempts: input.attempts as number | undefined ?? defaults.attempts };
}

class RecoveryDenied extends Error {
  constructor(readonly response: Response) {
    super(`llama.cpp stream recovery denied: HTTP ${response.status}`);
  }
}

/** Keep Pi's stock parser above an unchanged byte stream, including split SSE frames. */
export function resumableFetch(fetcher: FetchFunction, model: string, attempts: number, userSignal?: AbortSignal, timeoutMs = 600000): FetchFunction {
  settings({ attempts });
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return fetcher(input, init);
    // One identity per generation, not per chat: parallel turns and retries must
    // never replace each other's server-side ring buffers.
    const conversation = `${randomUUID()}::${encodeURIComponent(model)}`;
    const headers = new Headers(request.headers);
    headers.set("X-Conversation-Id", conversation);
    headers.set("Accept-Encoding", "identity");
    const endpoint = new URL(url);
    endpoint.pathname = endpoint.pathname.replace(/\/chat\/completions$/, "/stream");
    endpoint.search = new URLSearchParams({ conv_id: conversation }).toString();
    const replayHeaders = new Headers(headers);
    for (const name of ["content-type", "content-length", "x-conversation-id"]) replayHeaders.delete(name);
    let offset = 0, consumedAttempts = 0, complete = false, stopped = false, suffix = "";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const life = new AbortController();
    const callerSignal = userSignal ?? request.signal;
    const signal = AbortSignal.any([request.signal, callerSignal, life.signal]);
    const cleanup = () => callerSignal.removeEventListener("abort", abort);
    const stop = async () => {
      if (stopped || complete) return;
      stopped = true;
      // An aborted socket does not cancel a resumable generation. Explicit Stop
      // uses the same endpoint/authentication, with a separate bounded signal.
      const response = await fetcher(endpoint, { method: "DELETE", headers: replayHeaders,
        redirect: "error", signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
      if (!response.ok) throw Error(`llama.cpp stream cancellation: HTTP ${response.status}`);
    };
    const abort = () => { void stop().catch(() => {}); };
    callerSignal.addEventListener("abort", abort, { once: true });
    // Keep the original per-attempt header deadline. The provider wrapper gives
    // the SDK enough total time for these attempts without poisoning its parser's
    // controller when only one network attempt times out.
    const fetchHeaders = async (target: RequestInfo | URL, options?: RequestInit) => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      timer.unref();
      try {
        return await fetcher(target, { ...options, signal: AbortSignal.any([signal, deadline.signal]) });
      } finally { clearTimeout(timer); }
    };
    const recover = async () => {
      while (consumedAttempts < attempts) {
        signal.throwIfAborted();
        consumedAttempts++;
        await sleep(Math.min(1000 * consumedAttempts, 5000), undefined, { signal });
        const replay = new URL(endpoint);
        replay.searchParams.set("from", String(offset));
        let response: Response;
        try {
          response = await fetchHeaders(replay, { headers: replayHeaders, redirect: "error" });
        } catch (error) {
          signal.throwIfAborted();
          continue;
        }
        if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return response;
        // Authentication and policy failures cannot be repaired by resending
        // the generation. Leave them visible instead of disguising them as loss.
        if ([401, 403].includes(response.status)) throw new RecoveryDenied(response);
        await response.body?.cancel();
      }
      // Pi owns fresh-request retry and partial-message rollback. Never splice a
      // new generation into the existing parser, especially after tool deltas.
      throw Error(`Connection error: llama.cpp stream recovery exhausted after ${attempts} attempts; Pi may retry as a new request`);
    };
    let response: Response;
    try {
      signal.throwIfAborted();
      try { response = await fetchHeaders(new Request(request, { headers, redirect: "error" })); }
      catch (error) { signal.throwIfAborted(); response = await recover(); }
      if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        cleanup();
        return response;
      }
      reader = response.body.getReader();
    } catch (error) {
      cleanup();
      await stop().catch(() => {});
      // Preserve HTTP authentication status before headers reach the SDK: a
      // rejected fetch would otherwise be mislabeled as a retryable network error.
      if (error instanceof RecoveryDenied) return error.response;
      throw error;
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            signal.throwIfAborted();
            try {
              const chunk = await reader!.read();
              if (chunk.done) {
                if (!complete) throw Error("llama.cpp stream ended before [DONE]");
                cleanup(); controller.close(); return;
              }
              // Offset counts original UTF-8 bytes, not decoded text length or
              // event count. Retain only enough text to recognize the terminator.
              const scan = suffix + Buffer.from(chunk.value).toString("latin1");
              complete ||= /(?:^|[\r\n])data: ?\[DONE\](?:\r?\n|$)/.test(scan);
              suffix = scan.slice(-64);
              controller.enqueue(chunk.value);
              offset += chunk.value.byteLength;
              return;
            } catch (error) {
              signal.throwIfAborted();
              if (complete) { cleanup(); controller.close(); return; }
              await reader?.cancel().catch(() => {});
              reader?.releaseLock();
              reader = (await recover()).body!.getReader();
            }
          }
        } catch (error) {
          cleanup();
          await reader?.cancel().catch(() => {});
          await stop().catch(() => {});
          if (error instanceof RecoveryDenied) await error.response.body?.cancel();
          controller.error(error);
        }
      },
      async cancel() {
        cleanup(); life.abort();
        await reader?.cancel().catch(() => {});
        await stop().catch(() => {});
      },
    });
    const resultHeaders = new Headers(response.headers);
    resultHeaders.delete("content-length");
    resultHeaders.delete("content-encoding");
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: resultHeaders });
  };
}

export function resumeController(pi: ExtensionAPI, agentDir = getAgentDir()): void {
  const file = join(agentDir, "pillama.json");
  let current = { ...defaults };
  const wrapped = new Set<string>();
  const load = async () => {
    let value;
    try { value = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    current = settings(value === undefined ? undefined : object(value, "pillama settings").resume);
  };
  const attach = (_event: unknown, ctx: ExtensionContext) => {
    const model = ctx.model;
    if (!model || model.provider !== pi.getFlag("pillama-provider") || model.api !== "openai-completions" || wrapped.has(model.provider)) return;
    const original = ctx.modelRegistry.getProvider(model.provider);
    if (!original) return;
    // Preserve native llama.cpp's authentication, dynamic model catalog and
    // classifier implementation. Registering a legacy config here deletes the
    // native provider in Pi 1.x and can make every model disappear.
    pi.registerProvider({ ...original,
      streamSimple(model, context, options) {
        if (!current.enabled || model.api !== "openai-completions") return original.streamSimple(model, context, options);
        const timeout = options?.timeoutMs ?? 600000;
        const resumeBudget = Math.min(2147483647, timeout * (current.attempts + 1) + 5000 * current.attempts + 1000);
        return original.streamSimple(model, context, { ...options, maxRetries: 0, timeoutMs: resumeBudget,
          fetch: resumableFetch(options?.fetch ?? globalThis.fetch, model.id, current.attempts,
            options?.signal ?? new AbortController().signal, timeout) });
      },
    });
    wrapped.add(model.provider);
  };
  pi.on("session_start", async (event, ctx) => { await load(); attach(event, ctx); });
  pi.on("model_select", attach);
  pi.registerCommand("pillama-resume", {
    description: "Resume dropped llama.cpp streams: /pillama-resume on [attempts], off, or status",
    async handler(args, ctx) {
      const [action = "status", count, ...extra] = (args.trim() || "status").split(/\s+/);
      if (!["on", "off", "status"].includes(action) || extra.length || count !== undefined && action !== "on") {
        throw Error("Use /pillama-resume on [attempts], off, or status");
      }
      await load();
      if (action !== "status") {
        const next = settings({ enabled: action === "on", attempts: count === undefined ? current.attempts : Number(count) });
        let saved: Record<string, unknown> = {};
        try { saved = object(JSON.parse(await readFile(file, "utf8")), "pillama settings"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const temporary = `${file}.${randomUUID()}.tmp`;
        await mkdir(agentDir, { recursive: true, mode: 0o700 });
        try {
          await writeFile(temporary, JSON.stringify({ ...saved, resume: next }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await rename(temporary, file);
        } finally { await rm(temporary, { force: true }); }
        current = next;
        attach(undefined, ctx);
      }
      ctx.ui.notify(`llama.cpp stream recovery ${current.enabled ? "on" : "off"}; ${current.attempts} resume attempts before Pi's normal fresh-request retry.`, "info");
    },
  });
}
