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
  - `utf8ByteLength()`：用于估算 payload 字节数（通常仅在 debug 生效时才会计算）
- `runtime/*`
  - `ObservabilityRuntime`：唯一编织入口（创建/复用 ctx、序列号、LRU、默认安全 emit）
- `debug/*`
  - legacy 低层实现（当前仓库不再直接使用）

## 关键概念

- `traceId`：把一次“用户动作/一次 store 调用链”在 core/adapter/batch/server 间串起来。
- `requestId`：把一次具体网络请求串起来（一般由 `traceId + 序号` 派生）。
- `opId`：batch 请求中的单个 op（query/write）的标识。
- `scope`：多 store/多域并存时做隔离，避免事件串台。
- `DebugEvent.sequence`：同一 `traceId` 内单调递增，用于稳定排序（比仅靠 timestamp 更可靠）。
- `DebugEvent.spanId` / `parentSpanId`：可选层级关系（当前默认 spanId 为 `s_${sequence}`）。

## 端到端：整条观测管线如何运行

### 1）用户在创建 store 时开启 debug

典型入口是 `createCoreStore({ debug: ... })`：

- `debug.enabled` 关闭时：**不会创建 emitter**，所有埋点点位都会变成近似 0 成本的空操作。
- `debug.sampleRate` 默认为 `0`：store 通常会**避免分配 traceId**，降低默认开销。

补充：Atoma 刻意让 `DebugConfig` 保持“纯数据”。事件最终投递到哪里由 wiring 层决定（通常转发到 `DevtoolsBridge`）。

### 2）Store 决定是否分配 `traceId`

以 `findMany` 为例：

- 若调用方传了 `options.traceId`，直接沿用。
- 否则只在“确实需要时”分配：
  - `options.explain === true`，或
  - debug 开启且 `sampleRate > 0`

写入链路同理：显式 `traceId` 优先；否则只在采样命中时才分配。

### 3）Runtime 创建 `ObservabilityContext`（采样/脱敏/默认安全在这里收敛）

`Observability.runtime.create(...).createContext(...)` 永远返回一个对象：

- `ctx.active === false` 时：`ctx.emit(...)` 为 no-op（近似零开销）
- `ctx.active === true` 时：`ctx.emit(...)` 会封装 `DebugEvent` 并投递给 `onEvent`

发射事件时：

- 统一封装 `DebugEvent` 的 envelope：`schemaVersion`、`timestamp`、`scope`、`sequence`、`spanId` 等。
- payload 默认安全：
  - `includePayload: false`（默认）→ 只输出摘要（长度、字段数等）
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

store 层会把 `DebugEvent` 转换/转发为 devtools 事件：

- `{ type: 'debug-event', payload: e }`

消费侧（Devtools UI / 日志 / 远端采集器）通常按 `store + traceId` 聚合，并按 `sequence` 排序展示。

## Explain vs Debug 事件流

- **Debug 事件流**：时间线证据（`DebugEvent[]`），通过 `debug.sink` 流出。
- **Explain**：可复制粘贴的诊断快照；当 `findMany({ explain: true })` 时挂在返回值上。

目前 explain 主要包含可 JSON 序列化的结构化信息（index/finalize/cacheWrite/adapter/errors…）。类型里虽然有 `Explain.events`，但 core 并不会自动把事件流塞进去；如需把事件也附到 explain，需要在你控制的边界处用 sink 按 trace 缓存并注入。

## 实用示例（用户侧）

```ts
import { createCoreStore, createDevtoolsBridge } from 'atoma'

const devtools = createDevtoolsBridge()
devtools.subscribe((evt) => {
    if (evt.type === 'debug-event') {
        console.log('[atoma debug]', evt.payload.store, evt.payload.traceId, evt.payload.sequence, evt.payload.type)
    }
})

const store = createCoreStore({
    name: 'todos',
    adapter: /* ... */,
    devtools,
    debug: {
        enabled: true,
        sampleRate: 1,
        includePayload: false,
        redact: (v) => v
    }
})

// 生成 explain 诊断产物
const res = await store.findMany({ where: { done: { eq: false } }, explain: true })
console.log(res.explain)
```

## 关于 ID 与请求头

- HTTP adapter 与 `BatchEngine` 通常会透传：
  - `x-atoma-trace-id`
  - `x-atoma-request-id`
- `requestId` 通常通过 `createRequestIdSequencer()` 在实例内按 trace 生成序列，避免进程级全局可变状态，更适合 SSR/并发场景。

## 延伸阅读

- `OBSERVABILITY_OPTIMAL_ARCHITECTURE.md`（仓库根目录）
- `OBSERVABILITY_AND_AUTHZ_DESIGN.md`（仓库根目录）
