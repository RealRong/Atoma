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
  - `policies/retryBackoff.ts` (shared retry/backoff logic)
  - `policies/backoffPolicy.ts` (delay calculation + sleep)
  - `policies/singleInstanceLock.ts` (single active instance per outbox)
  - `policies/batchPolicy.ts` (group outbox items into a write batch)
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

1) Acquire `SingleInstanceLock` (stored in IndexedDB KV under `lockKey`).
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

- `SyncEngine.enqueueWrite(...)`
  - Ensures each `WriteItem` has `meta.idempotencyKey`
  - Stores `SyncOutboxItem` entries in `DefaultOutboxStore`
  - Triggers `PushLane.requestFlush()`

Then:

- `PushLane.flush()` loops:
  - `outbox.peek(max)` to get pending items
  - `buildWriteBatch(...)` groups items by `(resource, action)` into a single write op
  - Marks keys as in-flight (optional store method)
  - Calls `transport.opsClient.executeOps({ ops: [writeOp], meta })`
  - For each result:
    - OK → `applyWriteAck(...)` then `outbox.ack(keys)`
    - Not OK → `applyWriteReject(...)` then `outbox.reject(keys)`

Notes:

- Retry is only for retryable operation errors (see `isRetryableOpError`).
- On retry, in-flight keys are released back to pending.

### 2) Pull changes (`changes.pull`)

Path:

- `SyncEngine.pull()` → `PullLane.pull()`
  - Reads current cursor (or `initialCursor`, or `'0'`)
  - Calls `transport.opsClient.executeOps({ ops: [changes.pull], meta })`
  - Applies `batch.changes` via `applier.applyChanges(...)`
  - Stores `batch.nextCursor` via `cursor.set(...)`

`SyncEngine` can also schedule periodic pulls with backoff on failure.

### 3) Notify (SSE)

Path:

- `SyncEngine.start()` starts the lane, and `setSubscribed(true)` enables it.
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

- `SyncTransport.opsClient` is the only required server integration (providing `opsClient.executeOps(...)`).
- Subscription requires `subscribeUrl` (and optionally `eventSourceFactory`).
- `applier` is a wrapper that delegates to:
  - `onPullChanges(changes)`
  - `onWriteAck(ack)`
  - `onWriteReject(reject, conflictStrategy)`

This separation keeps sync logic independent from your actual store/mutation implementation.

## Quick Debug Checklist

- Writes not leaving the client:
  - Is `SyncEngine.start()` called?
  - Is the lock being acquired? (check lifecycle events)
  - Does outbox contain items? (`DefaultOutboxStore.size()`)
- Notifications not reconnecting:
  - Is `setSubscribed(true)` called?
  - Is `subscribeUrl` configured?
  - Is `EventSource` available (or a factory provided)?
