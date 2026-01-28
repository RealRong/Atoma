# Atoma 可观测性（观测管线总览）

本目录实现 Atoma 的**跨框架可观测性基础设施**：trace/request/op 标识、确定性采样、默认安全的 debug 事件发射器，以及 `explain` 诊断产物结构。

若你关注“最优长期架构”（不使用隐藏 carrier、只用显式 internal context 传递），请阅读仓库根目录的 `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md`。

## 对外 API vs 内部链路

- 包根入口（`src/index.ts`）目前只对外导出**类型**：`TraceContext`、`Explain`、`DebugConfig`、`DebugEvent`。
- 仓库内部链路统一只透传 `ObservabilityContext` 并调用 `ctx.emit(...)`（调用方只消费）。

## `src/observability/` 里有什么

- `Observability.ts`
  - 聚合入口：`Observability.trace|sampling|utf8|runtime`
- `types/*`
  - 主要数据类型：`TraceContext`、`DebugConfig`、`DebugEvent`、`Explain`、`ObservabilityContext`
- `trace/*`
  - traceId/requestId 相关纯函数
- `sampling/*`
  - 确定性采样
- `utf8/*`
  - `byteLength()`：用于估算 payload 字节数（通常仅在 debug 生效时才会计算）
- `runtime/*`
  - `ObservabilityRuntime`：唯一编织入口（创建/复用 ctx、序列号、LRU、默认安全 emit）

## 关键概念

- `traceId`：把一次“用户动作/一次 store 调用链”在 core/adapter/batch/server 间串起来。
- `requestId`：把一次具体网络请求串起来（一般由 `traceId + 序号` 派生）。
- `opId`：batch 请求中的单个 op（query/write）的标识。
- `scope`：多 store/多域并存时做隔离，避免事件串台。
- `DebugEvent.sequence`：同一 `traceId` 内单调递增，用于稳定排序（比仅靠 timestamp 更可靠）。
- `DebugEvent.spanId` / `parentSpanId`：可选层级关系（当前默认 spanId 为 `s_${sequence}`）。

## 端到端：整条观测管线如何运行

### 1）通过 client schema 开启 debug（推荐）

Atoma 不再把 `Core.store.createStore(...)` 作为用户态入口。
请把 `debug/debugSink` 配到 client schema 中，然后通过 `client.stores.*` 获取 store。

- `debug.enabled` 关闭时：**不会创建 emitter**，所有埋点点位都会变成近似 0 成本的空操作。
- `debug.sample` 默认为 `0`：store 通常会**避免分配 traceId**，降低默认开销。

补充：Atoma 刻意让 `DebugConfig` 保持“纯数据”。事件最终投递到哪里由 wiring 层决定（例如日志、UI、远端采集器）。

### 2）Store 决定是否分配 `traceId`

以 `query` 为例：

- 若创建 `ObservabilityContext` 时显式传入了 `traceId`（例如 `createContext({ traceId })`），直接沿用。
- 否则只在“确实需要时”分配：
  - `options.explain === true`，或
  - debug 开启且 `sample > 0`

写入链路同理：显式 `traceId` 优先；否则只在采样命中时才分配。

### 3）Runtime 创建 `ObservabilityContext`（采样/脱敏/默认安全在这里收敛）

`Observability.runtime.create(...).createContext(...)` 永远返回一个对象：

- `ctx.active === false` 时：`ctx.emit(...)` 为 no-op（近似零开销）
- `ctx.active === true` 时：`ctx.emit(...)` 会封装 `DebugEvent` 并投递给 `onEvent`

发射事件时：

- 统一封装 `DebugEvent` 的 envelope：`schemaVersion`、`timestamp`、`scope`、`sequence`、`spanId` 等。
- payload 默认安全：
  - `payload: false`（默认）→ 只输出摘要（长度、字段数等）
  - 可选 `redact(value)` 先脱敏，再决定摘要/输出
- sink 的异常会被吞掉（观测不允许影响业务路径）。

### 4）内部上下文传播：`ObservabilityContext`

仓库内部约定：除 wiring 层外，所有模块只接收并透传 `ObservabilityContext`，只调用 `ctx.emit(...)`。

### 5）引擎在关键阶段发结构化事件

当前实现里常见事件类型包括：

- 查询（core）：
  - `query:start`：查询参数摘要
  - `query:index`：索引候选集收集结果 + query plan 快照
  - `query:finalize`：最终过滤/排序/分页前后计数
  - `query:cacheWrite`：是否写入 store 缓存（以及不写的原因）
- 适配器/网络：
  - `adapter:request`：method/endpoint/payloadBytes（可选）/opCount（batch）等
  - `adapter:response`：ok/status/durationMs 等
- 写入（core）：
  - `mutation:patches`：patch 数量、变更字段
  - `mutation:rollback`：回滚原因

### 6）Sink：事件最终流向哪里

Atoma 只负责生成 `DebugEvent`；事件最终流向哪里由 **wiring 层**决定（例如输出到控制台/日志系统/远端采集器/自研 Devtools）。

目前库内不再提供旧的 `DevtoolsBridge` 事件流。若你需要 Debug 事件流，可在创建 store 时提供 `debugSink(e)`：

- `debugSink` 负责接收已脱敏/摘要化后的 `DebugEvent`（由 `debug.payload/redact` 控制）
- 消费侧通常按 `store + traceId` 聚合，并按 `sequence` 排序展示

## Explain vs Debug 事件流

- **Debug 事件流**：时间线证据（`DebugEvent[]`），由 wiring 层按需接出（当前不作为稳定对外 API 文档化）。
- **Explain**：可复制粘贴的诊断快照；当 `query({ explain: true })` 时挂在返回值上。

目前 explain 主要包含可 JSON 序列化的结构化信息（index/finalize/cacheWrite/adapter/errors…）。类型里虽然有 `Explain.events`，但 core 并不会自动把事件流塞进去；如需把事件也附到 explain，需要在你控制的边界处用 sink 按 trace 缓存并注入。

## 实用示例（用户侧）

```ts
import { createClient } from 'atoma'

const client = createClient({
    schema: {
        todos: {
            debug: { enabled: true, sample: 1, payload: false, redact: (v: unknown) => v },
            debugSink: (e: any) => console.log(e)
        }
    },
    backend: /* ... */
})

const store = client.stores.todos
const res = await store.query?.({
    filter: { op: 'eq', field: 'done', value: false },
    explain: true
} as any)
console.log(res?.explain)
```

如果你想在开发期查看“client/store/sync/history 等运行时状态”，请使用 `atoma-devtools`（通过 `devtoolsPlugin()` 注册，UI 用 `mountAtomaDevTools()` 挂载）。

## 关于 ID 与 trace 传递

- 对于 ops 请求：traceId/requestId 以 **op-scoped** 形式写在 `op.meta.traceId` / `op.meta.requestId`（batch 场景尤其重要：同一请求内允许 mixed trace，不需要为 trace 拆批）。
- **禁止 Header Trace**：不支持 `x-atoma-trace-id` / `x-atoma-request-id` 作为任何权威或可选 carrier，服务端也不应解析/依赖它们（避免把 trace 错误地 request-scoped 化，并与 batch mixed trace 冲突）。
- `requestId` 通常通过 `ctx.requestId()`（runtime 内部维护 per-trace 序列）在实例内按 trace 生成序列，避免进程级全局可变状态，更适合 SSR/并发场景。
- 对于 `sync/subscribe` 这类 GET/SSE（无 JSON body）：trace 通过 URL query（`traceId`/`requestId`）传递。

## 延伸阅读

- `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md`（仓库根目录）
- `OBSERVABILITY_AND_AUTHZ_DESIGN.md`（仓库根目录）
