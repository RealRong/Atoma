# Atoma Observability (Pipeline Overview)

This folder implements Atoma’s **framework-agnostic observability primitives**: trace identifiers, deterministic sampling, safe debug-event emission, and the “explain” diagnostic payload.

If you want the long-term “optimal architecture” (no hidden carrier, explicit internal context only), read `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md` at repo root.

## Public surface vs internal wiring

- The package root (`src/index.ts`) re-exports **types only**: `TraceContext`, `Explain`, `DebugConfig`, `DebugEvent`.
- Inside the repo, the internal pipeline only passes `ObservabilityContext` and calls `ctx.emit(...)` (callers only consume).

## What’s in `src/observability/`

- `Observability.ts`
  - Aggregated entry: `Observability.trace|sampling|utf8|runtime`
- `types/*`
  - Main data types: `TraceContext`, `DebugConfig`, `DebugEvent`, `Explain`, `ObservabilityContext`
- `trace/*`
  - pure helpers for traceId/requestId
- `sampling/*`
  - deterministic sampling
- `utf8/*`
  - `byteLength()` – optional byte-size estimation for request payloads (used only when debug is enabled)
- `runtime/*`
  - `ObservabilityRuntime` – the only wiring entry (ctx creation/reuse, sequences, LRU, safe emit)

## Core concepts

- `traceId`: correlates one logical user action / store API call chain across layers.
- `requestId`: correlates one concrete network request (often derived from `traceId` + sequence).
- `opId`: correlates a single op inside a batch request (query/write).
- `scope`: isolates events when multiple stores exist in the same process.
- `DebugEvent.sequence`: monotonically increasing per `traceId` (stable ordering even if timestamps collide).
- `DebugEvent.spanId` / `parentSpanId`: optional hierarchy for visualizing phases (current default spanId is `s_${sequence}`).

## End-to-end data flow (how the pipeline runs)

### 1) User enables debug at store creation

At the public API level, users typically enable debug via `createCoreStore({ debug: ... })`.

- If `debug.enabled` is false, **no emitter is created** and all callsites are effectively no-ops.
- If `debug.sample` is `0` (default), the store will usually **avoid allocating a traceId**, keeping overhead near zero.

Note: Atoma intentionally keeps `DebugConfig` as pure data. The actual event sink is owned by the wiring layer (typically forwarding into a `DevtoolsBridge`).

### 2) Store decides whether to allocate a `traceId`

For read paths like `findMany`:

- If caller passes `options.traceId`, it’s used as-is.
- Otherwise, Atoma allocates a trace only when it’s useful:
  - `options.explain === true`, or
  - debug is enabled and `sample > 0`

For write paths, the store uses a similar rule (explicit `traceId` wins; otherwise allocate only when sampled).

### 3) Runtime creates an `ObservabilityContext` (sampling + payload safety lives here)

`Observability.runtime.create(...).createContext(...)` always returns an object:

- when `ctx.active === false`, `ctx.emit(...)` is a no-op (near-zero overhead)
- when `ctx.active === true`, `ctx.emit(...)` wraps and forwards `DebugEvent` into `onEvent`

When emitting:

- `DebugEvent` is wrapped with required metadata: `schemaVersion`, `timestamp`, `scope`, `sequence`, `spanId`, etc.
- Payload is safe by default:
  - `payload: false` → payload is summarized (lengths, key counts, etc.)
  - optional `redact(value)` runs before summarization / inclusion
- Sink failures are swallowed (debug must not break business logic).

### 4) Internal propagation: `ObservabilityContext`

Inside the repository, every module (except wiring) only receives and forwards `ObservabilityContext`, and only calls `ctx.emit(...)`.

### 5) Engine emits structured events at key points

Current event types emitted by the engine include:

- Query (core):
  - `query:start` – captures a safe summary of query params
  - `query:index` – index candidate collection result + query plan snapshot
  - `query:finalize` – final filtering/sorting/pagination counts
  - `query:cacheWrite` – whether results were written to store cache (and why not)
- Adapter / network:
  - `adapter:request` – endpoint, method, payloadBytes (optional), opCount (batch), etc.
  - `adapter:response` – ok/status/durationMs and similar counters
- Mutation (core):
  - `mutation:patches` – patch counts and changed fields
  - `mutation:rollback` – rollback reason

### 6) Sinks: where events go

The store layer forwards `DebugEvent` into a devtools bridge as a `DevtoolsEvent`:

- `{ type: 'debug-event', payload: e }`

Consumers (Devtools UI, logs, remote collectors) should group by `store + traceId` and sort by `sequence`.

## Explain vs Debug Events

- **Debug events**: a stream of timeline evidence (`DebugEvent[]`), shipped to `debug.onEvent`.
- **Explain**: a copy/paste friendly diagnostic artifact attached to `findMany` results when `options.explain === true`.

Today, explain contains deterministic, JSON-serializable fields (index/finalize/cacheWrite/adapter/errors…). The `Explain.events` field exists in the type but is not automatically populated by core; if you want it, implement a sink that buffers events per trace and attaches them at the boundary you control.

## Practical example (user-side)

```ts
import { createCoreStore, createDevtoolsBridge } from 'atoma'

const devtools = createDevtoolsBridge()
devtools.subscribe((evt) => {
    if (evt.type === 'debug-event') {
        console.log('[atoma debug]', evt.payload.store, evt.payload.traceId, evt.payload.sequence, evt.payload.type)
    }
})

const store = createCoreStore({
    name: 'todos',
    adapter: /* ... */,
    devtools,
    debug: {
        enabled: true,
        sample: 1,
        payload: false,
        redact: (v) => v
    }
})

// Produce an explain payload
const res = await store.findMany({ where: { done: { eq: false } }, explain: true })
console.log(res.explain)
```

## Notes on IDs and trace propagation

- For ops requests: traceId/requestId are carried in an **op-scoped** form via `op.meta.traceId` / `op.meta.requestId` (especially important for batching: mixed traces are allowed without splitting requests).
- The `x-atoma-trace-id` / `x-atoma-request-id` headers are optional: the server may still parse them as request-level context (e.g. for top-level errors/logging), but they are no longer the source of truth for op-scoped tracing.
- `requestId` is derived via `ctx.requestId()` (the runtime maintains a per-trace sequence), which avoids process-global mutable state and supports SSR/concurrency.
- For `sync/subscribe-vnext` GET/SSE (no JSON body): tracing is passed via URL query params (`traceId`/`requestId`).

## Further reading

- `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md` (repo root)
- `OBSERVABILITY_AND_AUTHZ_DESIGN.md` (repo root)
