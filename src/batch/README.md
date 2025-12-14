# Atoma Batch (client-side batching)

This folder implements Atoma’s **client-side batching engine** used by adapters (most commonly the HTTP adapter) to coalesce many small operations into fewer `POST /batch` requests.

## What it provides

- **Two independent lanes**
  - **Query lane**: batches read/query ops (e.g. `findMany`) into fewer requests.
  - **Write lane**: batches mutations (create/update/patch/delete) into bucketed bulk ops with fairness.
- **Coalesced flushing**
  - Flush in a microtask by default (same-tick coalescing).
  - Optional `flushIntervalMs` to delay flushing for better batching.
- **Backpressure**
  - `maxQueueLength` can be global or per lane.
  - Query overflow strategy: reject new work or drop old queries.
- **Concurrency control**
  - `queryMaxInFlight` and `writeMaxInFlight` cap in-flight requests per lane.
- **Observability hooks**
  - When tasks carry `traceId` + `debugEmitter`, the lanes emit `adapter:request/adapter:response` debug events.

## Key modules

- `BatchEngine.ts`
  - Public surface: `enqueueQuery`, `enqueueCreate/update/patch/delete`, `dispose`.
  - Owns scheduling (microtask/timer), lifecycle, and shared resources (abort controllers).
- `queryLane.ts`
  - Drains query tasks and sends batch query requests.
  - Maintains FIFO batching boundaries and avoids mixing traced/untraced tasks in a single request.
- `writeLane.ts`
  - Drains bucketed write tasks, builds bulk ops, and sends batch write requests.
  - Uses round-robin across buckets for fairness.
- `transport.ts`
  - `sendBatchRequest(fetcher, endpoint, headers, payload, signal, extraHeaders)`; JSON `POST`.
- `queryParams.ts`
  - Translates `FindManyOptions<T>` into server `QueryParams` (Batch protocol requires `params.page`).
- `protocol.ts`
  - Parses server results and normalizes envelopes.
- `adapterEvents.ts`
  - Small helper to fan-out `adapter:*` debug events to multiple emitters consistently.

## How it runs (end-to-end)

### 1) Enqueue from an adapter

An adapter that enables batching will create a `BatchEngine` and call:

- `enqueueQuery(resource, params, fallback, internalContext?)`
- `enqueueCreate/update/patch/delete(..., internalContext?)`

`internalContext` is an internal observability wiring object. If it contains `traceId` and `emitter`, those are copied onto tasks.

### 2) Scheduling (coalesced flush)

`BatchEngine` owns the scheduling policy:

- Each lane has its own `*Scheduled` flag and optional `*Timer`.
- By default, enqueues coalesce into a single microtask flush.
- If `flushIntervalMs > 0`, flushing can be delayed to increase batch size.
- If a lane hits a threshold (e.g. queue reaches cap, bucket reaches size), it “upgrades” a pending timer flush into an immediate microtask flush.

### 3) Draining into HTTP requests

Each drain iteration:

- selects a batch of tasks (query lane: FIFO contiguous group by `traceId` key; write lane: round-robin bucket slices),
- builds a request payload,
- sends `POST /batch` via `transport.ts`,
- maps server results back to individual task promises.

### 4) Trace/request header rules

For protocol cleanliness, a batch request includes `traceId`/`requestId` (payload + headers) **only when all tasks in that request have the same non-empty `traceId`**.

- If tasks are mixed (different traceIds or traced + untraced), the request is treated as “no common trace”:
  - no `x-atoma-trace-id` header
  - no `traceId`/`requestId` fields on the payload root
  - debug events set `mixedTrace: true`

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

