# Atoma Batch (client-side batching)

This folder implements Atoma’s **client-side batching engine** used by adapters (most commonly the HTTP adapter) to coalesce many small operations into fewer `POST /ops` requests.

## What it provides

- **Two independent lanes**
  - **Query lane**: batches `QueryOp`.
  - **Write lane**: batches `WriteOp`.
- **Coalesced flushing**
  - Flush in a microtask by default (same-tick coalescing).
  - Optional `flushIntervalMs` to delay flushing for better batching.
- **Backpressure**
  - `maxQueueLength` can be global or per lane.
  - Query overflow strategy: reject new work or drop old queries.
- **Concurrency control**
  - `queryMaxInFlight` and `writeMaxInFlight` cap in-flight requests per lane.
- **Observability hooks**
  - When tasks carry an `ObservabilityContext` and `ctx.active === true`, the lanes emit `adapter:request/adapter:response` debug events.

## Key modules

- `BatchEngine.ts`
  - Public surface: `enqueueOp` / `enqueueOps`, `dispose`.
  - Owns lifecycle and scheduling; network sending is delegated to an injected `opsClient` (lane scheduling/queues live inside `QueryLane`/`WriteLane`).
- `queryLane.ts`
  - Drains QueryOp tasks and sends `POST /ops`.
  - Maintains FIFO batching boundaries (trace is no longer a batching dimension).
- `writeLane.ts`
  - Drains WriteOp tasks and sends `POST /ops`.
- `internal.ts`
  - Internal helpers (config normalization, small utils, adapter debug events fan-out, and `executeOpsTasksBatch` which does payload → `opsClient.executeOps` → result mapping/fallback).

## How it runs (end-to-end)

### 1) Enqueue from an adapter

An adapter that enables batching will create a `BatchEngine` and call:

- `enqueueOp(op, internalContext?)`
- `enqueueOps(ops, internalContext?)`

`internalContext` is an internal observability wiring object (`ObservabilityContext`). It is copied onto tasks for debug attribution (and for writing `op.meta.traceId/requestId`).

### 2) Scheduling (coalesced flush)

`BatchEngine` owns the scheduling policy:

- Each lane has its own `*Scheduled` flag and optional `*Timer`.
- By default, enqueues coalesce into a single microtask flush.
- If `flushIntervalMs > 0`, flushing can be delayed to increase batch size.
  - The goal is to coalesce more enqueues within the `flushIntervalMs` window and reduce request count.

### 3) Draining into HTTP requests

Each drain iteration:

- selects a batch of tasks (query/write FIFO),
- builds a request payload,
- sends `POST /ops` via the injected `opsClient.executeOps`,
- maps server results back to individual task promises.

### 4) Trace and `op.meta` rules

To ensure observability does not affect batching performance, tracing is **op-scoped**:

- Each task’s `ctx` only affects its corresponding `op.meta.traceId/requestId`.
- `OpsRequest.meta` only keeps transport-level fields (e.g. `v/clientTimeMs`) and does not include traceId/requestId.
- No trace headers are injected (e.g. `x-atoma-trace-id` / `x-atoma-request-id`); Atoma does not support/parse header trace. Cross-end correlation is op-scoped via `op.meta` (and subscribe uses query params).
- Mixed traces within the same request are allowed; debug events set `mixedTrace: true`.

### 5) Debug events (adapter:request/adapter:response)

When tasks carry `debugEmitter`, both lanes emit request-level adapter events.

Design choice:

- Events are **fan-out per emitter/store** (not “one per HTTP request”), so traces are not dropped when tasks belong to different stores/traces.
- Each emitted payload includes both:
  - per-emitter counters (`opCount`, and for writes also `taskCount`)
  - request-level counter (`totalOpCount`)

## Configuration tips

- If you want minimal latency: keep `flushIntervalMs` at `0` (default).
- If you want higher batching efficiency: set a small `flushIntervalMs` (e.g. 5–20ms) and tune `maxOpsPerRequest` / `maxBatchSize`.
- If you want strict backpressure: set `maxQueueLength` (especially for write lane) to protect memory.
