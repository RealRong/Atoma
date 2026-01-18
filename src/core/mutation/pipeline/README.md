# Mutation Pipeline (Core)

This folder contains the mutation execution pipeline for Atoma stores. It turns dispatch events into optimistic state updates, persistence operations, and final writeback/callback handling.

## Call chain (high level)

1. `MutationPipeline.api.dispatch` enqueues events in `Scheduler`.
2. `Scheduler` normalizes `opContext`, segments compatible events, and calls `executeMutationFlow` per segment.
3. `executeMutationFlow` builds a `MutationProgram` and applies optimistic state updates.
4. `executeMutationPersistence` executes direct writes or enqueues outbox writes.
5. Flow finalizes writeback, callbacks, and rollback on errors.

## Module map

- `MutationPipeline.ts`: Entry point wiring scheduler, tickets, and history.
- `Scheduler.ts`: Queueing, segmentation, and draining behavior.
- `LocalPlan.ts`: Local plan builder (base/optimistic state, patches, write intents).
- `MutationProgram.ts`: Compiler from plan to executable write program.
- `MutationFlow.ts`: Segment execution and orchestration.
- `WriteIntents.ts`: Dispatch/patch translation into protocol write intents.
- `WriteOps.ts`: Protocol op construction and execution.
- `Persist.ts`: Persist mode selection (direct/outbox) and execution path.
- `WritebackCollector.ts`: Aggregation of server writeback (created, upserts, versions).
- `WriteTicketManager.ts`: Write ticket creation and confirmation lifecycle.
- `types.ts`: Shared pipeline types.

## Key concepts

- **Segments**: A segment is a batch of dispatch events with compatible context and persist mode.
- **Optimistic state**: Local state updates applied before persistence completes.
- **Patches**: Immer patches/inverse patches for history and rollback.
- **Persist modes**: `direct` executes writes immediately; `outbox` enqueues writes for sync.
- **Tickets**: `beginWrite` creates a write ticket; `awaitTicket` controls optimistic vs strict confirmation.

## Error handling

- Any error in persistence triggers rollback to the base state.
- Tickets are settled with the error, and operation callbacks receive the failure.

## Contributor notes

- Keep cross-file data flow explicit and documented.
- Avoid mixing `create`/`patches` with other operations in a segment.
- Prefer deterministic behavior for batched operations and callbacks.
