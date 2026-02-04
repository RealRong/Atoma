# Observability 完全插件化重构方案（Runtime 不感知）

目标：让 Runtime/核心流程完全不知道 observability；所有 trace/debug/explain 由插件提供，并且可选。

本文给出：
- 完整的重构步骤
- 改造清单（文件级）
- 新接口草案（含 hooks）
- 观测插件（官方）实现思路

---

## 一、目标与边界

### 目标
- Runtime/Core 不再包含 observability 的类型、字段、调用或语义。
- Trace/Debug/Explain 由插件提供，默认关闭。
- 用户可完全不知道 observability，也不影响核心功能。

### 非目标
- 不保证兼容旧 API（当前无用户，可直接破坏性重构）。
- 不强求 explain 仍由 core 提供（将迁移到插件 API）。

---

## 二、当前耦合点（必须移除）

1) 类型耦合
- `CoreRuntime`/`RuntimeConfig` 中含 `observe`。
- `RuntimeIo`/`RuntimePersistence` 使用 `ObservabilityContext`。
- `Query`/`QueryResult` 含 `explain`。

2) 流程耦合
- `ReadFlow`/`WriteFlow` 直接创建 trace、emit debug、构建 explain。
- `Stores` 在创建 store 时调用 `runtime.observe.registerStore(...)`。

3) 插件/默认实现耦合
- `createClient` 内部默认 `new StoreObservability()`。
- `DefaultObservePlugin` 只包装 runtime.observe。

---

## 三、目标架构（完全不感知）

### 核心层（Core/Runtime）
- 仅暴露通用 hooks 和标准读写流程。
- 不理解 traceId / explain / debug。
- 不持有 ObservabilityContext。

### 插件层（Observability Plugin）
- 使用 hooks 收集读写/存储事件。
- 在 io/persist handler 中注入 trace/requestId（如果需要）。
- 提供独立 API（可选，如 `client.observe.createContext(...)` / `client.observe.query(...)`）实现 trace/debug（explain 由插件扩展决定）。

---

## 四、新接口草案（通用 hooks，无 observability 语义）

### 4.1 Runtime hooks 类型

```ts
// packages/atoma-types/src/runtime/hooks.ts
import type { Patch } from 'immer'
import type * as Types from '../core'
import type { StoreHandle } from './handleTypes'

export type RuntimeWriteHookSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type RuntimeReadStartArgs = Readonly<{
    handle: StoreHandle<any>
    query: Types.Query<any>
}>

export type RuntimeReadFinishArgs = Readonly<{
    handle: StoreHandle<any>
    query: Types.Query<any>
    result: Types.QueryResult<any>
    durationMs?: number
}>

export type RuntimeWriteStartArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    intents: Array<Types.WriteIntent<any>>
    source: RuntimeWriteHookSource
}>

export type RuntimeWritePatchesArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    patches: Patch[]
    inversePatches: Patch[]
    source: RuntimeWriteHookSource
}>

export type RuntimeWriteCommittedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    result?: unknown
}>

export type RuntimeWriteFailedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    error: unknown
}>

export type RuntimeHooks = Readonly<{
    read?: Readonly<{
        onStart?: (args: RuntimeReadStartArgs) => void
        onFinish?: (args: RuntimeReadFinishArgs) => void
    }>
    write?: Readonly<{
        onStart?: (args: RuntimeWriteStartArgs) => void
        onPatches?: (args: RuntimeWritePatchesArgs) => void
        onCommitted?: (args: RuntimeWriteCommittedArgs) => void
        onFailed?: (args: RuntimeWriteFailedArgs) => void
    }>
    store?: Readonly<{
        onCreated?: (args: {
            handle: StoreHandle<any>
            storeName: string
        }) => void
    }>
}>

export type RuntimeHookRegistry = Readonly<{
    register: (hooks: RuntimeHooks) => () => void
    has: Readonly<{ writePatches: boolean }>
    emit: Readonly<{
        readStart: (args: RuntimeReadStartArgs) => void
        readFinish: (args: RuntimeReadFinishArgs) => void
        writeStart: (args: RuntimeWriteStartArgs) => void
        writePatches: (args: RuntimeWritePatchesArgs) => void
        writeCommitted: (args: RuntimeWriteCommittedArgs) => void
        writeFailed: (args: RuntimeWriteFailedArgs) => void
        storeCreated: (args: { handle: StoreHandle<any>; storeName: string }) => void
    }>
}>
```

### 4.2 PluginContext 增加 hooks

```ts
// packages/atoma-types/src/client/plugins/types.ts
import type { RuntimeHookRegistry } from '../../runtime'

export type PluginContext = Readonly<{
    clientId: string
    endpoints: EndpointRegistry
    capabilities: CapabilitiesRegistry
    runtime: CoreRuntime
    hooks: RuntimeHookRegistry
}>
```

### 4.3 observability 插件扩展（建议）

```ts
// 由插件提供，不再占用 schema
observe.registerStore({
    storeName: string
    debug?: DebugConfig
    debugSink?: (e: DebugEvent) => void
})
```

---

## 五、核心重构步骤（顺序）

### Step 1：引入 hooks 基础设施
- 新增 `RuntimeHookRegistry` 实现（atoma-runtime）。
- Runtime 构造时注入 hooks（默认空实现）。
- `PluginContext` 增加 `hooks`。

### Step 2：移除 observe 与 ObservabilityContext
- 删除 `RuntimeObservability` 与 `ObservabilityContext` 在 runtime 类型中的存在。
- `RuntimeIo.executeOps/query` 不再接收 `context`。
- `RuntimePersistence.executeWriteOps` 不再接收 `context`。

### Step 3：ReadFlow/WriteFlow 全面解耦
- 移除 `observe.createContext`、`emit`、`traceId`、`explain` 相关代码。
- 改为调用 hooks：
  - `readStart/readFinish`
  - `writeStart/writePatches/writeCommitted/writeFailed`
- `writePatches` 仅在 `hooks.has.writePatches` 为 true 时生成。

### Step 4：Stores 解耦 debug 注册
- `Stores` 创建 store 时不再调用 `runtime.observe.registerStore`。
- 改为 `hooks.emit.storeCreated({ handle, storeName })`。

### Step 5：移除 Observe Handler 链
- 删除 `observe` handler 链（PluginRegistry/HandlerChain 中移除 observe 支持）。
- 删除 `DefaultObservePlugin`。

### Step 6：迁移 explain 能力（插件化）
- 从 `Types.Query` 和 `QueryResult` 中移除 `explain`。
- explain 如需支持，由 observability 插件扩展提供（可选）。

---

## 六、观测插件（官方）实现草案

### 6.1 目标能力
- 为读写流程创建 trace/requestId（插件内维护）
- 发出 DebugEvent（调试事件）
- explain 迁移为插件层能力（本次仅落地 hooks + 事件流，explain 可后续补）

### 6.2 主要实现点
- 在 `ctx.hooks.register(...)` 中订阅 read/write/storeCreated。
- 内部维护 per-store ObservabilityRuntime（原 StoreObservability 逻辑可复用）。
- 通过 persist handler 使用 `opContext.actionId` 生成 traceId，并写入 `op.meta`（仅插件侧）。
- 提供扩展 API：
  - `client.observe.createContext(...)`
  - `client.observe.registerStore(...)`（store 级 debug 配置）
  - 可选：`client.observe.trace(fn)`（由插件实现）
  - 可选：注册 io handler 注入 traceId/requestId（op.meta）

### 6.3 示例伪代码

```ts
export function observabilityPlugin(): ClientPlugin<{ observe: ObserveApi }> {
    return {
        id: 'observability',
        init: (ctx) => {
            const storeObs = new StoreObservability()

            const stop = ctx.hooks.register({
                store: {
                    onCreated: ({ storeName }) => {
                        // 可用于记录 store 生命周期（不再透传 debug 配置）
                    }
                },
                read: {
                    onStart: ({ handle, query }) => { /* start trace */ },
                    onFinish: ({ handle, query, result, durationMs }) => { /* debug emit */ }
                },
                write: {
                    onPatches: ({ handle, opContext, patches, inversePatches }) => { /* debug emit */ }
                }
            })

            return {
                extension: {
                    observe: {
                        createContext: (storeName, args) => {
                            return storeObs.createContext(String(storeName), args)
                        }
                    }
                },
                dispose: () => stop()
            }
        }
    }
}
```

---

## 七、改造清单（文件级）

### atoma-types
- `src/runtime/runtimeTypes.ts`：移除 `RuntimeObservability` 与相关字段。
- `src/runtime/hooks.ts`：新增 hooks 类型与 Registry。
- `src/runtime/persistenceTypes.ts`：`PersistRequest` 增加 `opContext`（供插件使用）。
- `src/client/plugins/types.ts`：`PluginContext` 增加 `hooks`。
- `src/client/plugins/types.ts`：移除 `ObserveHandler`/`ObserveContext` 等 observe handler 类型。
- `src/core/query.ts`：移除 `explain` 字段（如存在）。

### atoma-runtime
- `src/runtime/Runtime.ts`：新增 `hooks`；删除 `observe`。
- `src/runtime/flows/ReadFlow.ts`：移除 `observe` 与 explain/emit 逻辑；改用 hooks。
- `src/runtime/flows/WriteFlow.ts`：移除 `observe`；增加 hooks 触发点。
- `src/store/Stores.ts`：触发 `hooks.emit.storeCreated(...)`。
- `src/runtime/registry/HookRegistry.ts`：新增实现。

### atoma-client
- `src/internal/createClient.ts`：
  - 不再注入 `new StoreObservability()`
  - PluginContext 传入 `hooks`
  - 不再安装 `DefaultObservePlugin`
- `src/plugins/PluginRegistry.ts`：移除 `observe` handler 的逻辑支持。

### atoma-observability
- 新增 `observabilityPlugin()`（替代 DefaultObservePlugin + StoreObservability wiring）。
- 复用 `ObservabilityRuntime` 作为内部实现。

### atoma-devtools
- 如需消费 debug 事件，改为由 observability 插件注入（或从 devtools registry 读取）。

---

## 八、迁移与验收

### 迁移要点
- explain 从 core 移除后，如需诊断能力，改由插件扩展提供。
- 旧 `query.explain` 不再生效。
- 依赖 `ObservabilityContext` 的协议/handler 全部删除。

### 验收清单
- 不加载 observability 插件时：核心读写正常，无 trace/explain/debug。
- 加载 observability 插件时：
  - debug 事件仍能产出
  - traceId/requestId 可由插件注入 ops meta（可选）
  - explain 如需支持，由插件扩展实现

---

## 九、与历史插件的衔接顺序

建议先完成 `ATOMA_HISTORY_PLUGIN_ADAPTATION_AND_MODEL_REVIEW.zh.md` 中的插件化 hooks 方案，确保 hooks 体系落地后，再执行本文的 observability 完全解耦改造。
