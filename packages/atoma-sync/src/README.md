# Sync (Reading Guide)

This folder contains Atoma’s sync runtime: an outbox-based write pipeline, a cursor-based change pull, and an optional SSE subscription for near‑realtime updates.

The goal of this guide is to help you read the code top‑down and understand the core invariants.

## Mental Model (1 minute)

There are three independent “lanes”:

1) **Push lane**: local writes are queued into an **outbox** and pushed to the server as `write` operations.
2) **Pull lane**: fetches `changes.pull` from the server and advances a persistent **cursor**.
3) **Notify lane** (optional): keeps an SSE connection open; each notify message triggers a pull (no pushed changes, no cursor advancement).

All changes are applied by calling user-provided callbacks via a thin `applier` wrapper.

## File Map

- Orchestration / lifecycle:
  - `engine/SyncEngine.ts`
- Lanes:
  - `lanes/PushLane.ts`
  - `lanes/PullLane.ts`
  - `lanes/NotifyLane.ts`
- Persistence (IndexedDB KV):
  - `store.ts` (outbox + cursor stores)
  - `kvStore.ts`
- Policies / helpers:
  - `policies/retryPolicy.ts` (p-retry mapping + delay estimation for events)
  - `policies/singleInstanceLock.ts` (single active instance per outbox)
  - `policies/cursorGuard.ts` (cursor monotonic compare)
- Types + small utilities:
  - `types.ts`
  - `internal.ts`

## Core Invariants (the “rules”)

1) **Cursor is monotonic**: cursor updates only move forward (best-effort compare).
   - Implemented by `DefaultCursorStore.set(...)` via `defaultCompareCursor(...)`.
2) **Outbox is append-only except ack/reject**: once an item is enqueued, it remains until it is acked/rejected.
3) **In-flight items are not re-picked**: items marked `inFlightAtMs` are skipped by `peek(...)`.
4) **Stale in-flight recovery**: if an in-flight item “gets stuck” (crash/tab close), it becomes eligible again after `inFlightTimeoutMs`.
5) **Single instance**: only one active `SyncEngine` should push/pull/notify per `outboxKey` (per browser profile) at a time.

## Lifecycle (what `start()` really does)

Read `SyncEngine.start()` → `startWithLock()`:

1) Acquire `SingleInstanceLock` (stored in IndexedDB KV under `lock.key`).
2) If lock acquired and still “should run”:
   - Start notify lane (but only connects if enabled).
   - Request a push flush (so queued writes go out quickly).
   - Start periodic pull timer (optional; interval can be disabled).

Stopping (`stop()`):

- Stops notify lane
- Cancels periodic pull timer
- Releases lock

Disposing (`dispose()`):

- Calls `stop()` and permanently disables all lanes

## Data Flows

### 1) Local write → outbox → server (`write`)

Path:

- `outbox.enqueueWrites(...)` (runtime-owned outbox)
  - Requires each write to contain a single `WriteItem` with `meta.idempotencyKey`
  - Stores `SyncOutboxItem` write intents (`resource/action/item/options`) in `DefaultOutboxStore`
  - When sync is started in push/full mode, queue changes trigger `PushLane.requestFlush()`

Then:

- `PushLane.flush()` loops:
  - `outbox.peek(max)` to get pending items
  - Marks keys as in-flight (optional store method)
  - Calls `transport.pushWrites({ entries, meta, returning })`
  - For each outcome:
    - `ack` → `applyWriteAck(...)` then `outbox.ack(keys)`
    - `reject` → `applyWriteReject(...)` then `outbox.reject(keys)`
    - `retry` → releases in-flight keys back to pending (and triggers backoff)

Notes:

- Retry is only for retryable operation errors (classified by the transport implementation).
- On retry, in-flight keys are released back to pending.

### 2) Pull changes (`changes.pull`)

Path:

- `SyncEngine.pull()` → `PullLane.pull()`
  - Reads current cursor (or `initialCursor`, or `'0'`)
  - Calls `transport.pullChanges({ cursor, limit, resources?, meta })`
  - Applies `batch.changes` via `applier.applyPullChanges(...)`
  - Stores `batch.nextCursor` via `cursor.set(...)`

`SyncEngine` can also schedule periodic pulls with backoff on failure.

### 3) Notify (SSE)

Path:

- `SyncEngine.start()` starts the lanes; subscribe is enabled/disabled by config (`subscribe`) at start time.
- `NotifyLane`:
  - Opens `transport.subscribe(...)` (implemented by `Sync.subscribeNotifySse(...)`)
  - For each message:
    - Triggers a pull (with internal coalescing)
  - On error:
    - Closes subscription
    - Schedules reconnect with backoff

Important: cursor is advanced only by pull; notify never writes cursor.

## Retry / Backoff (shared pattern)

- `RetryBackoff` tracks attempt count and decides:
  - when to stop (max attempts)
  - what delay to wait (exponential backoff with jitter)
- Each lane chooses **how** to wait:
  - Push: `sleepMs(delay)`
  - Notify: `setTimeout(delay)`
  - Periodic pull: `setTimeout(delay)`

## Transport & Applier (integration points)

- `SyncTransport.pullChanges` is required for pull; you can build it from `opsClient` via `createOpsTransport(...)`.
- `SyncTransport.pushWrites` is required for push; you can build it from `opsClient` via `createOpsTransport(...)`.
- Subscription capability (`transport.subscribe`) is needed only when subscribe is enabled; SSE usually requires `buildUrl` (and optionally `connect`).
- `applier` is a wrapper that delegates to:
  - `applier.applyPullChanges(changes)`
  - `applier.applyWriteAck(ack)`
  - `applier.applyWriteReject(reject, conflictStrategy)`

This separation keeps sync logic independent from your actual store/mutation implementation.

## Quick Debug Checklist

- Writes not leaving the client:
  - Is `SyncEngine.start()` called?
  - Is the lock being acquired? (check lifecycle events)
  - Does outbox contain items? (`DefaultOutboxStore.size()`)
- Notifications not reconnecting:
  - Is subscribe enabled in config (`subscribe !== false`)?
  - Is `buildUrl` configured?
  - Is `EventSource` available (or a factory provided)?
