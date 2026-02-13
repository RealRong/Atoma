# Atoma Observability

This package provides Atoma’s observability primitives **and** an official client plugin that wires them via runtime hooks.

Core/runtime no longer knows about observability. If you want traces/debug events, install the plugin (or build your own).

## What’s included

- `Observability` runtime
  - trace id generation
  - deterministic sampling
  - safe debug event emission
- `StoreObservability`
  - per-store runtime helper
- `observabilityPlugin()`
  - hooks-based wiring for `atoma-client`

## Plugin behavior (no core coupling)

The plugin registers `ctx.events.register(...)` and listens to:

- `store.onCreated`
- `read.onStart/onFinish`
- `write.onStart/onPatches/onCommitted/onFailed`

It then uses `StoreObservability` to emit debug events (default prefix: `obs:*`).
When `injectTraceMeta` is enabled (default), the plugin also writes `traceId/requestId` into `op.meta` for ops it can associate with a trace.

## Usage (client)

```ts
import { createClient } from 'atoma-client'
import { memoryBackendPlugin } from 'atoma-backend-memory'
import { observabilityPlugin } from 'atoma-observability'

const client = createClient({
    plugins: [
        memoryBackendPlugin(),
        observabilityPlugin({ injectTraceMeta: true })
    ]
})

client.observe.registerStore({
    storeName: 'todos',
    debug: { enabled: true, sample: 1, payload: false },
    debugSink: (e: any) => console.log(e)
})
```

## Notes

- `query.explain` is no longer part of core APIs. If you want explain-like artifacts, implement them at the plugin layer (e.g. buffer events per trace and build a summary).
- The plugin’s default trace id uses `actionId` for writes and a per-query context for reads. You can always create custom contexts via the plugin extension.
- If the server doesn’t consume `op.meta.traceId/requestId`, this still works for client-side correlation and future server upgrades.
- For best results, call `observe.registerStore(...)` before issuing reads/writes for that store.

## Further reading

- `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md` (repo root)
- `ATOMA_OBSERVABILITY_PLUGINIZATION_REFACTOR.zh.md` (repo root)
