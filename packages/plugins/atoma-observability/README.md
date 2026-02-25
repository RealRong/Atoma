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

The plugin registers `ctx.events.on(...)` listeners and listens to:

- `storeCreated`
- `readStart/readFinish`
- `writeStart/writeCommitted/writeFailed`
- `changeStart/changeCommitted/changeFailed`

It then uses `StoreObservability` to emit debug events (default prefix: `obs:*`).
The plugin ships with a devtools trace exporter and optional `pino` + OTLP HTTP exporters.

## Usage (client)

```ts
import { createClient } from 'atoma-client'
import { memoryBackendPlugin } from 'atoma-backend-memory'
import { observabilityPlugin } from 'atoma-observability'

const client = createClient({
    plugins: [
        memoryBackendPlugin(),
        observabilityPlugin({
            eventPrefix: 'obs',
            pino: { enabled: true, level: 'info' },
            otlp: {
                enabled: true,
                endpoint: 'http://localhost:4318/v1/traces'
            }
        })
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
- The plugin’s default trace id uses `id` for writes and a per-query context for reads. You can always create custom contexts via the plugin extension.
- For best results, call `observe.registerStore(...)` before issuing reads/writes for that store.

## Further reading

- `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md` (repo root)
- `ATOMA_OBSERVABILITY_PLUGINIZATION_REFACTOR.zh.md` (repo root)
