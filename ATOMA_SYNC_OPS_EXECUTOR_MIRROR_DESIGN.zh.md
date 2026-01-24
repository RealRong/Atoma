# atoma-sync：Ops 执行能力与 Writeback 持久化（最终架构与 API 设计）

> 本文是一版“一步到位”的最终设计：不考虑向后兼容（当前无外部用户），只保留一套最优命名与职责划分。

## 1. 结论摘要
- `core/opsExecutor.ts` 不再是可被上层直接 import 的公共工具；它属于 **runtime 内部能力**。
- 插件（包含 `atoma-sync`）不再手工构造 `Meta`/做协议校验/直接执行 ops；统一使用 **高阶 Channel API**。
- durable mirror（落盘镜像）不属于 sync；它是 **runtime 的 writeback commit 能力**：一次调用完成“内存更新 +（若 Store 为 local durable）落盘”。

## 2. 核心原则（必须同时满足）
1) **单一 I/O 管线**：所有请求必须经过同一条可拦截 pipeline（用于 auth/trace/限流/重试/审计/mock）。
2) **Meta/Trace 自动化**：业务调用只传 `ObservabilityContext`/`AbortSignal`，不手工拼 `Meta`。
3) **协议校验集中化**：outgoing 校验、results 校验、错误归一化只保留一份实现。
4) **Writeback 一致性**：writeback 表示“服务端权威结果”，其落地（内存/落盘）由 runtime 统一完成；sync 不做存储语义。

## 3. 对外 API（最终命名，一套即可）

### 3.1 插件上下文：ClientPluginContext
> 插件只使用 `ctx.store / ctx.remote / ctx.writeback.commit` 发起业务动作；`ctx.io` 仅用于安装 middleware。

```ts
import type { Entity, PersistWriteback, StoreToken } from 'atoma/core'
import type { ObservabilityContext } from 'atoma/observability'
import type {
    ChangeBatch,
    Cursor,
    QueryParams,
    WriteAction,
    WriteItem,
    WriteOptions,
    WriteResultData,
} from 'atoma/protocol'

export type IoChannel = 'store' | 'remote'

// I/O pipeline 仅用于“拦截/注入”，不直接对业务插件暴露 execute 能力。
export type IoRequest = Readonly<{
    channel: IoChannel
    // 内部传递：最终会被执行的协议 ops + meta（由 runtime 统一构造）
    ops: import('atoma/protocol').Operation[]
    meta: import('atoma/protocol').Meta
    signal?: AbortSignal
    context?: ObservabilityContext
}>

export type IoResponse = Readonly<{
    results: import('atoma/protocol').OperationResult[]
    status?: number
}>

export type IoHandler = (req: IoRequest) => Promise<IoResponse>
export type IoMiddleware = (next: IoHandler) => IoHandler

export type ClientIo = Readonly<{
    use: (mw: IoMiddleware) => () => void
}>

export type ChannelQueryResult<T = unknown> = Readonly<{ items: T[]; pageInfo?: any }>

export type ChannelApi = Readonly<{
    query: <T = unknown>(args: {
        store: StoreToken
        params: QueryParams
        context?: ObservabilityContext
        signal?: AbortSignal
    }) => Promise<ChannelQueryResult<T>>

    write: (args: {
        store: StoreToken
        action: WriteAction
        items: WriteItem[]
        options?: WriteOptions
        context?: ObservabilityContext
        signal?: AbortSignal
    }) => Promise<WriteResultData>
}>

export type NotifyMessage = Readonly<{ resources?: string[]; traceId?: string }>

export type RemoteApi = ChannelApi & Readonly<{
    changes: Readonly<{
        pull: (args: {
            cursor: Cursor
            limit: number
            resources?: string[]
            context?: ObservabilityContext
            signal?: AbortSignal
        }) => Promise<ChangeBatch>
    }>

    subscribeNotify?: (args: {
        resources?: string[]
        onMessage: (msg: NotifyMessage) => void
        onError: (err: unknown) => void
        signal?: AbortSignal
    }) => { close: () => void }
}>

export type ClientPluginContext = Readonly<{
    io: ClientIo

    // 注意：ctx.store/ctx.remote 返回值已完成：
    // - op 构造与 opId 生成
    // - meta/trace/requestId 构造
    // - outgoing 校验 + results 校验
    // - 错误归一化（把协议错误映射为标准 Error）
    store: ChannelApi
    remote: RemoteApi

    // 唯一 writeback 落地入口：一次调用完成
    // 1) 内存态 apply（驱动 UI/索引更新）
    // 2) 若 Store 为 local durable：写入 durable backend（Writeback 模式，权威覆盖）
    writeback: Readonly<{
        commit: <T extends Entity>(
            storeName: StoreToken,
            writeback: PersistWriteback<T>,
            opts?: { context?: ObservabilityContext }
        ) => Promise<void>
    }>

    // 其它插件能力（保持现有职责）：
    acks: Readonly<{ ack: (idempotencyKey: string) => void; reject: (idempotencyKey: string, reason?: unknown) => void }>
    persistence: Readonly<{ register: (key: string, handler: any) => () => void }>
    onDispose: (fn: () => void) => () => void
}
```

**语义约束（强制）**
- 插件禁止直接执行 `Operation[]`（不暴露 `io.executeOps`）；只能通过 `ctx.store/ctx.remote`。
- 插件禁止手工构造 `Meta`；`Meta` 始终由 runtime 统一生成。
- 插件禁止实现 durable mirror；只能调用 `ctx.writeback.commit`。

### 3.2 Core/Runtime 内部能力（不对外导出）
> 目标：让 core/store 代码不接触 `Operation/Meta/ops` 概念。

runtime 内部只保留高阶 API（示意）：

```ts
// 仅示意：这是 runtime 内部模块，不从 packages/atoma/src/index.ts 导出。
export type RuntimeStoreApi = {
    query: <T extends Entity>(handle: StoreHandle<T>, params: QueryParams, context?: ObservabilityContext, signal?: AbortSignal) => Promise<{ items: unknown[]; pageInfo?: any }>
    write: <T extends Entity>(handle: StoreHandle<T>, args: { action: WriteAction; items: WriteItem[]; options?: WriteOptions }, context?: ObservabilityContext, signal?: AbortSignal) => Promise<WriteResultData>
}

export type RuntimeWritebackApi = {
    commit: <T extends Entity>(handle: StoreHandle<T>, writeback: PersistWriteback<T>, context?: ObservabilityContext) => Promise<void>
}
```

对应的实现细节（也是内部的）：
- 将现有 `core/opsExecutor.ts` 的能力内收为 runtime 私有模块（可以保留文件，但禁止上层直接 import）。
- runtime 负责：op 构造、meta/trace、校验、错误归一化、以及最终调用底层 `opsClient`。

## 4. atoma-sync 在最终架构下的形态（职责更薄）

### 4.1 RemoteTransport
- `pullChanges`：调用 `ctx.remote.changes.pull(...)`。
- `pushWrites`：调用 `ctx.remote.write(...)`（可由 remote API 内部实现批量分组/拆分写 op）。
- `subscribe`：调用 `ctx.remote.subscribeNotify?.(...)` 并在 remote API 内部完成 notify 解码。

### 4.2 WritebackApplier
- 只做“业务语义应用”，不做协议 glue：
  - pull：用 `ctx.remote.query(...)` 获取权威实体列表（按资源分组）；然后 `ctx.writeback.commit(resource, { upserts, deletes, versionUpdates })`。
  - ack/reject：先走 `ctx.acks.*`，再 `ctx.writeback.commit(...)`。
- 不再存在 `persistToMirror` 这种 sync 侧落盘逻辑。

## 5. durable writeback commit（内部实现要求，选定策略）
> 这里是一次性做对的关键：把“镜像”变成 runtime 的 writeback commit。

### 5.1 触发规则
- 当 Store backend 不是 `local durable`：`commit` 只做内存 apply。
- 当 Store backend 为 `local durable`：`commit` 必须同时完成内存 apply + durable commit。

### 5.2 数据一致性规则
- durable commit 写入的数据必须与内存态一致：
  - `upserts` 必须经过与内存态相同的 dataProcessor（writeback 模式）处理后再落盘。
  - `versionUpdates` 不得无意覆盖其它字段（只更新 version）。

### 5.3 写入语义（权威覆盖）
- 这是“服务端权威结果”，落盘必须是 **权威覆盖**，不执行乐观并发冲突策略。
- 删除不依赖调用方提供 baseVersion（runtime 内部负责处理/放宽约束）：
  - writeback delete = “如果存在则删除”，不因 baseVersion 缺失而失败。

### 5.4 原子性（每个 storeName）
- `commit(storeName, writeback)` 需要在单个 storeName 维度上尽可能原子：
  - 内存 apply 与 durable commit 以同一批数据完成，避免“内存已更新、落盘失败”的长期不一致。

## 6. 一步到位的禁止/删除项（无兼容层）
- 删除（或不再提供）插件侧的 `io.executeOps` 对外能力；只保留 `io.use`。
- 删除 sync 内的 mirror/persistToMirror；任何 durable 行为都由 `writeback.commit` 承担。
- 禁止 core/store 代码直接 import `core/opsExecutor.ts`；必须改为调用 runtime 的高阶 API。

