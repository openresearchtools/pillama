# pillama

A small extension for **Pi 1.x and current llama.cpp**. Keeps Pi's existing provider, model picker, tool calling, and response parser. Adds one bottom status row, structured telemetry, and conservative discovery of the loaded model's thinking controls. No additional runtime dependencies, custom provider, proxy, or Pi fork.

```text
loading 50% · text model · 0:08
↑ 60% 600/1000 (200 ch) 200.0 tk/s · 0:12
↑ 100% 1000/1000 (200 ch) 200.0 tk/s · ↓ 20.0 tk/s (80 tk) · 0:16
```

The row uses Pi's theme `dim` color, matching the native footer. It uses Pi's native widget below the editor, just above the standard footer, and wraps onto as many lines as needed when the terminal is narrow. Resizing reflows it automatically. `↑` means prefill, `↓` means decode, `ch` means cached tokens, and elapsed time is minutes:seconds. RPC/SDK snapshots remain plain text and always contain the full values; structured measurements keep their original field names and millisecond precision.

## Install

```sh
pi install git:github.com/openresearchtools/pillama
```

Restart Pi or use `/reload`. Configure Pi's built-in `llama.cpp` provider with `/login llama.cpp`, then select your model. Development without installing:

```sh
pi -e ./index.ts
```

For an existing custom OpenAI-compatible llama.cpp provider, pass its exact provider ID:

```sh
pi --pillama-provider my-local-provider
```

Only that provider's `openai-completions` requests are affected. This extension targets the llama.cpp router, not Pi's experimental virtual-model routing.

## What it does

Every inference request adds `return_progress: true`, `timings_per_token: true`, and **`sse_ping_interval: 15`**. These are top-level request fields. They enable llama.cpp's prompt progress, server-measured speeds, and SSE comment heartbeats, including gaps between slow prefill batches. A current server is required. You can also set the server-wide default:

```sh
llama-server --models-dir /path/to/models --jinja --sse-ping-interval 15
```

Retain your usual GPU, context, and other server options. Heartbeats must pass through any reverse proxy without buffering; they cannot override a proxy's hard request deadline. pillama does not disable Pi's network timeouts or manufacture inference heartbeats on the client.

Before inference, pillama checks `/models`. For a router model that needs loading, it starts `/models/load` when router autoload is enabled, observes `/models/sse`, and checks readiness once a second. This happens **before** Pi opens the inference request, keeping cold loading outside that request's response-header timeout. All operations are cancellable; each catalog/load HTTP request has a 30-second limit. The overall loading wait has no artificial deadline while the router remains reachable. A UI/telemetry heartbeat updates elapsed time once a second during loading and inference. SSE progress is rendered at most four times a second.

Unknown/missing models and load failures appear in the row and structured data and abort inference. With `--no-models-autoload`, pillama respects the server setting and asks you to load through `/llama`. It never downloads missing models. Cancelling stops this client's wait, without unloading a model shared by other clients. Single-model servers skip router loading. Already sleeping models use llama.cpp's normal wake-on-request behavior.

Loading percentages come from the server's load-stage progress, with equal weight per reported stage. Unknown progress stays unknown; percentages are not fabricated. The server notes that mmap can report inaccurate load progress; `--load-mode none` is its option for accurate progress. The extension observes loads needed by an inference request, not unrelated background model loads.

## Thinking discovery

Once the selected router model is loaded, pillama reads its live `/props` template. There are no model-name rules or saved per-model capability files. It recognizes explicit Jinja enum guards that reject unsupported effort values, then verifies the allowed Pi levels through `/apply-template`. For on/off templates it verifies that enabling and disabling thinking produces different prompts. These checks render a tiny test prompt; they do not generate tokens or load another model.

Verified choices appear in Pi's existing `/thinking` picker and its native SDK/RPC thinking APIs. With no explicit preference, pillama selects the highest verified effort, or `medium` (on) for an on/off model. Only the current model object is updated, in memory. A cold model is inspected after loading and before its first inference request. Already loaded models are checked at session/model selection and every five seconds while idle. Template checks are cached in memory and invalidated by template, endpoint, model, or launch-argument changes. No Pi restart or GPU reload is needed to change effort.

Explicit choices take precedence:

- CLI `--thinking`, model suffixes, scoped-model levels, Pi global/per-model thinking settings, and observed manual thinking changes are respected.
- Explicit thinking-related `models.json` metadata or custom request mappings are left alone. For SDK sessions with a custom agent directory, use `extensionFactories: [pi => pillama(pi, { agentDir })]` so this check reads that directory.
- Server reasoning/template launch options suppress automatic maximum selection. The request leaves those settings to the server until the user explicitly changes effort in Pi. Existing server token budgets are never replaced. Rendered defaults differing from the template's declared default also suppress automatic selection.
- Unknown templates, ignored controls, unavailable discovery endpoints, and servers without router launch metadata retain Pi's behavior. In particular, single-model servers currently retain their existing thinking configuration because their API does not expose launch arguments.

Pi only reports thinking changes when the effective level changes. It cannot tell an extension that a client reselected the same value, or recover a requested SDK/RPC level already clamped before discovery. Set `defaultThinkingLevel` in Pi settings when a preference must apply before an unloaded model has been inspected. `--pillama-thinking off` disables discovery and automatic selection entirely while keeping telemetry.

Effort is sent as a template parameter, **not a reasoning token budget**. Pi's generic picker descriptions such as “~8k tokens” remain Pi's labels; pillama does not impose those limits. The native level names stay unchanged (there are no additional `pl-*` controls).

`get_available_thinking_levels`, `set_thinking_level`, `get_state`, and the corresponding SDK session methods operate on the updated current model. Additional discovery details are published on the SDK event bus as `pillama:thinking` and over RPC as `setStatus` with that key and a JSON `Thinking` object (`provider`, `model`, `levels`, `selected`, `source`, `templateHash`). Like `pillama:telemetry`, this reserved status key is data, not an extra visible row. `source` identifies automatic selection, a user choice, or deference to server defaults. No reasoning data or test prompts are added to the conversation.

## Measurements

- `prefill.total`: all prompt tokens, including the cached prefix.
- `prefill.processed`: cached plus newly evaluated tokens completed so far.
- `prefill.cached`: reused KV-cache tokens (shown in brackets).
- `prefill.tokensPerSecond`: server prompt speed; when only progress is available, `(processed - cached) / elapsedSeconds`. Cache reuse is not counted as newly evaluated throughput.
- `decode.tokens` / `decode.tokensPerSecond`: server generation counts/speed, including reasoning and tool generation; never counted from text or SSE chunks.
- `elapsedMs`: wall time from the start of request preparation through completion, including loading, waiting, prefill, and decoding. Final snapshots freeze this total.

Speeds are cumulative server averages. Missing statistics remain absent. Each request has its own UUID, including tool-call continuations and retries. Final statistics remain until the next request or a model/session change. No telemetry is added to prompts, assistant text, or session history.

## RPC

Works with unmodified Pi:

```sh
pi --mode rpc
```

Pi emits two ordinary `extension_ui_request` events with `method: "setStatus"`:

- `statusKey: "pillama"`: `statusText` is the readable row.
- `statusKey: "pillama:telemetry"`: `statusText` is a JSON-encoded `Telemetry` snapshot. Treat this reserved key as data, not another visible row.

Both are fire-and-forget notifications; **do not send a UI response**. A missing `statusText` clears the corresponding status. Generic clients can show `pillama`; clients wanting numbers can use the second event. No new top-level RPC event types or stdout interception are required.

```ts
import { readTelemetry } from "pillama/telemetry";

function onPiRpcEvent(event: unknown) {
  const data = readTelemetry(event);
  if (data === undefined) return; // unrelated event
  if (data === null) { clearStatus(); return; }
  renderStatus(data.text);
  updateMetrics(data); // phase, loading, prefill, decode, elapsedMs, requestId
}
```

The exported `Telemetry` interface in `telemetry.ts` is the schema; `version` is currently `1`. All snapshots contain `provider`, `model`, `phase`, `startedAt` (Unix milliseconds), `elapsedMs`, `requestId`, and `text`. Phase is `connecting`, `loading`, `waiting`, `prefill`, `decode`, `done`, `aborted`, or `error`. Optional fields include `loading`, `prefill`, `decode`, and `error`.

## SDK

Use Pi's native event bus. This works without any UI context and is independent of `session.subscribe()` conversation events:

```ts
import {
  createAgentSession, createEventBus, DefaultResourceLoader, getAgentDir,
} from "@earendil-works/pi-coding-agent";
import pillama, { TELEMETRY_KEY, type Telemetry } from "pillama";

const eventBus = createEventBus();
const unsubscribe = eventBus.on(TELEMETRY_KEY, value => {
  const telemetry = value as Telemetry | null;
  // null clears the display; otherwise this is the same snapshot as RPC.
  updateMetrics(telemetry);
});
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(), agentDir: getAgentDir(), eventBus,
  extensionFactories: [pillama],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ resourceLoader });
try {
  await session.bindExtensions({});
  await session.prompt("Your request");
} finally {
  unsubscribe();
  session.dispose();
}
```

Use either the installed extension or the factory, not both. When constructing your own SDK resource loader, pass the bus you subscribe to. Plain `--print`/`--mode json` output has no native status transport; SDK consumers use the bus, and external process clients use RPC. The extension never writes extra JSON to stdout.

## Development

```sh
npm ci
npm run check
npm test
```

Tests include actual Pi 1.0.0 RPC processes and a headless SDK session against local synthetic servers. The RPC test uses a 700 ms idle timeout, a 1.8-second model load, and a 2.1-second prefill gap bridged by SSE comments. It verifies load progress, cached-token accounting, tool continuations, cancellation, failures, and clean conversation/RPC output. No real model, GPU, or external API is used by tests.

Hardware validation on 2 October 2026 also passed with Pi 1.0.0, llama.cpp `b11146-7fe450e19`, an RTX 3090, and Qwen3.8-27B-UD-Q4_K_XL. RPC reported real loading percentages through 100%, a 22-second cold load despite Pi's 20-second HTTP timeout, 3,211 prompt tokens at about 1,016 tok/s, and 3,212 cached tokens reused on the next request. Both responses carried generation speed and total elapsed time (25.3 s cold / 0.6 s cached). These were short correctness checks, not generation-speed benchmarks.

Thinking discovery was also checked against that real model with its full 262,144-token context across two RTX 3090s. Native SDK and RPC exposed `off`, `low`, `medium`, `xhigh`, selected `xhigh` automatically, and honored manual level changes without reloading the GPU model. Real requests at `xhigh`, `low`, and `off` all completed; no thinking-budget field was sent.

Upstream contracts: [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
