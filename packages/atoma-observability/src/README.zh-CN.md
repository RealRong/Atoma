# Atoma Observability

本包提供 Atoma 的可观测性原语 **以及** 一个官方客户端插件（通过 hooks 完成接入）。

Core/Runtime 不再感知 observability。需要 trace/debug 时，请显式安装插件（或自建插件）。

## 包含内容

- `Observability` runtime
  - trace id 生成
  - 确定性采样
  - 安全的 debug 事件发射
- `StoreObservability`
  - 按 store 复用 runtime 的便捷封装
- `observabilityPlugin()`
  - 基于 hooks 的 `atoma-client` 官方接入

## 插件行为（零核心耦合）

插件通过 `ctx.hooks.register(...)` 订阅：

- `store.onCreated`
- `read.onStart/onFinish`
- `write.onStart/onPatches/onCommitted/onFailed`

随后由 `StoreObservability` 发出 debug 事件（默认前缀 `obs:*`）。

## 用法（客户端）

```ts
import { createClient } from 'atoma-client'
import { observabilityPlugin } from 'atoma-observability'

const client = createClient({
    schema: {
        todos: {
            debug: { enabled: true, sample: 1, payload: false },
            debugSink: (e: any) => console.log(e)
        }
    },
    plugins: [observabilityPlugin()]
})
```

## 备注

- `query.explain` 已不再属于 core API。如需 explain 类诊断，请在插件层自行实现（例如按 trace 缓存事件并生成摘要）。
- 插件默认使用 `actionId` 作为写入 traceId，读请求使用每次 query 的上下文；也可通过插件扩展自行创建 context。

## 延伸阅读

- `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md`（根目录）
- `ATOMA_OBSERVABILITY_PLUGINIZATION_REFACTOR.zh.md`（根目录）
