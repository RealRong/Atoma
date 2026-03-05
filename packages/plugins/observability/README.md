# Atoma Observability

This package intentionally keeps the root API minimal and exposes `observabilityPlugin` as the primary entry.

## Root API (minimal)

```ts
import { observabilityPlugin } from '@atoma-js/observability'
```

## Plugin behavior

- listens to `storeCreated` and auto-prepares store runtime
- listens to `readStart/readFinish`
- listens to `writeStart/writeCommitted/writeFailed`
- listens to `changeStart/changeCommitted/changeFailed`
- emits trace timeline through a devtools source

## Usage

```ts
import { createClient } from '@atoma-js/client'
import { observabilityPlugin } from '@atoma-js/observability'

const client = createClient({
    plugins: [
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
