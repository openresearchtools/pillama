import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus, readTelemetry, TELEMETRY_KEY, updateStream, type Telemetry } from "../telemetry.ts";
import { loadProgress, serverRoot, watchModels } from "../router.ts";

function state(): Telemetry {
  return { version: 1, requestId: "test", provider: "llama.cpp", model: "model", phase: "waiting",
    startedAt: 0, elapsedMs: 12000, text: "" };
}

test("prefill counts cached tokens without counting them as newly evaluated tokens", () => {
  const data = state();
  updateStream(data, { prompt_progress: { total: 1000, processed: 600, cache: 200, time_ms: 2000 } });
  assert.deepEqual(data.prefill, { total: 1000, processed: 600, cached: 200, ms: 2000, tokensPerSecond: 200 });
  assert.match(formatStatus(data), /prefill 60% 600\/1000 \(200 cached\) 200.0 tok\/s/);
  updateStream(data, { timings: { prompt_n: 800, cache_n: 200, prompt_ms: 4000,
    prompt_per_second: 200, predicted_n: 80, predicted_ms: 4000, predicted_per_second: 20 } });
  assert.equal(data.prefill?.total, 1000);
  assert.equal(data.prefill?.processed, 1000);
  assert.equal(data.decode?.tokensPerSecond, 20);
  assert.match(formatStatus(data), /total 12.0s/);
  updateStream(data, { prompt_progress: { total: 1000, processed: 999, cache: 200, time_ms: 4000 } });
  assert.match(formatStatus(data), /prefill 99%/);
});

test("zero-time progress and absent/malformed stats never invent speed or tokens", () => {
  const data = state();
  updateStream(data, { prompt_progress: { total: 1000, processed: 1000, cache: 1000, time_ms: 0 } });
  assert.equal(data.prefill?.tokensPerSecond, undefined);
  updateStream(data, { choices: [{ delta: { reasoning_content: "thinking" } }] });
  assert.equal(data.phase, "decode");
  assert.equal(data.decode, undefined);
  updateStream(data, { timings: { predicted_n: NaN, predicted_per_second: Infinity } });
  assert.equal(data.decode, undefined);
});

test("timing-only final chunk recovers totals and keeps server-generated token count", () => {
  const data = state();
  updateStream(data, { choices: [], timings: { cache_n: 128, prompt_n: 32, prompt_ms: 16,
    prompt_per_second: 2000, predicted_n: 50, predicted_ms: 2000, predicted_per_second: 25 } });
  assert.equal(data.prefill?.total, 160);
  assert.equal(data.prefill?.cached, 128);
  assert.equal(data.decode?.tokens, 50);
});

test("load progress respects stages and unknown progress stays unknown", () => {
  assert.deepEqual(loadProgress({ progress: { stages: ["text_model", "mmproj_model"], current: "mmproj_model", value: 0.5 } }),
    { stage: "mmproj_model", stageProgress: 0.5, progress: 0.75 });
  assert.equal(loadProgress({})?.progress, undefined);
  assert.equal(serverRoot("http://host/prefix/v1/"), "http://host/prefix");
});

test("native RPC reader accepts snapshots and clears, ignores unrelated data", () => {
  const event = { type: "extension_ui_request", method: "setStatus", statusKey: TELEMETRY_KEY };
  assert.equal(readTelemetry(event), null);
  assert.deepEqual(readTelemetry({ ...event, statusText: JSON.stringify(state()) }), state());
  assert.equal(readTelemetry({ ...event, statusText: "garbage" }), undefined);
  assert.equal(readTelemetry({ ...event, statusKey: "another-extension" }), undefined);
});

test("SSE parser handles arbitrary byte boundaries, Unicode, comments and malformed frames", async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: invalid\r\n\r\ndata: {"model":"雪",\r\ndata: "event":"model_status"}\r\n\r\n');
  const response = new Response(new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  }));
  const events: unknown[] = [];
  await watchModels(response, data => events.push(data));
  assert.deepEqual(events, [{ model: "雪", event: "model_status" }]);
});
