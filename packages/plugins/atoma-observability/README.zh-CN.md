# Atoma Observability

本包默认只暴露 `observabilityPlugin` 作为客户端接入入口。

## 根导出（最小公开面）

```ts
import { observabilityPlugin } from 'atoma-observability'
```

## 插件行为

- 监听 `storeCreated` 并自动准备 store runtime
- 监听 `readStart/readFinish`
- 监听 `writeStart/writeCommitted/writeFailed`
- 监听 `changeStart/changeCommitted/changeFailed`
- 通过 devtools source 输出 trace 时间线

## 用法

```ts
import { createClient } from 'atoma-client'
import { observabilityPlugin } from 'atoma-observability'

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
