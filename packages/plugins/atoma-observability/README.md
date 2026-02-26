# Atoma Observability

This package intentionally keeps the root API minimal and exposes `observabilityPlugin` as the primary entry.

## Root API (minimal)

```ts
import { observabilityPlugin } from 'atoma-observability'
```

## Runtime subpath (advanced)

```ts
import { ObservabilityRuntime } from 'atoma-observability/runtime'
```

## Plugin behavior

- listens to `storeCreated` and auto-prepares store runtime
- listens to `readStart/readFinish`
- listens to `writeStart/writeCommitted/writeFailed`
- listens to `changeStart/changeCommitted/changeFailed`
- emits trace timeline through a devtools source

## Usage

```ts
import { createClient } from 'atoma-client'
import { memoryBackendPlugin } from 'atoma-backend-memory'
import { observabilityPlugin } from 'atoma-observability'

const client = createClient({
    plugins: [
        memoryBackendPlugin(),
        observabilityPlugin({
            maxTraceEvents: 800,
            maxRuntimeTraces: 512,
            debug: { enabled: true, sample: 1, payload: false },
            debugSink: (event, storeName) => {
                console.log(storeName, event)
            }
        })
    ]
})

client.stores('todos').create({ id: '1', title: 'hello' })
```
