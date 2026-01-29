# CoreRuntime API 重新设计（最终定型）

> 目标：职责清晰、语义一致、最少嵌套、可组合、易扩展。**不考虑兼容性**，以“行业规范 + 简洁”为最高优先级。

---

## 1. 设计目标

- **职责单一**：读写、持久化、观察、数据处理、存储注册分离。
- **语义一致**：同一概念只出现一次（例如 executeOps 不再同时存在于 opsClient 与 io）。
- **最少嵌套**：运行时只允许一层模块化命名（`runtime.xxx`）。
- **内部/外部边界清晰**：核心只暴露稳定的运行时能力，内部实现可替换。
- **可扩展**：插件/适配器可插入 persistence、observability、write pipeline。

---

## 2. 现状问题（摘要）

- `CoreRuntime` 混合了“运行时协调”和“内部存储句柄”等职责。
- `opsClient` 与 `io.executeOps` 语义重复。
- 写链路散落在 core/store/ops + runtime + engine 内部，边界不清。
- `dataProcessor`/`writeback` 语义没统一到“转换层”，导致多处重复。

---

## 3. 新版 CoreRuntime 总览（最终 API）

> **原则**：保持一层模块化，不再额外嵌套。

```ts
export type CoreRuntime = Readonly<{
    id: string
    now: () => number

    // Store 注册与解析（只负责“拿到 store/handle”）
    stores: StoreRegistry

    // 传输层（最底层 I/O）
    io: RuntimeIo

    // 写入协调器（聚合写流程）
    write: RuntimeWrite

    // mutation pipeline（票据、commit 事件、rollback）
    mutation: RuntimeMutation

    // 持久化层（策略/队列/适配器）
    persistence: RuntimePersistence

    // 观测
    observe: RuntimeObservability

    // 数据转换（序列化/验证/写回）
    transform: RuntimeTransform
}>
```

### 3.1 StoreRegistry

```ts
type StoreRegistry = Readonly<{
    resolve: (name: StoreToken) => IStore<any> | undefined
    ensure: (name: StoreToken) => IStore<any>
    list: () => Iterable<IStore<any>>
    onCreated: (listener: (store: IStore<any>) => void, options?: { replay?: boolean }) => () => void

    // internal-only（仅内部模块使用）
    resolveHandle: (name: StoreToken, tag?: string) => StoreHandle<any>
}>
```

说明：
- `resolve/ensure/list` 是唯一公开入口。
- `resolveHandle` 明确标记 internal-only，避免把 handle registry 暴露给业务。

### 3.2 RuntimeIo

```ts
type RuntimeIo = Readonly<{
    executeOps: (args: { ops: Operation[]; signal?: AbortSignal; context?: ObservabilityContext }) => Promise<OperationResult[]>
    query: <T extends Entity>(handle: StoreHandle<T>, query: Query, context?: ObservabilityContext, signal?: AbortSignal) => Promise<{ data: unknown[]; pageInfo?: any; explain?: any }>
    write: <T extends Entity>(handle: StoreHandle<T>, args: { action: WriteAction; items: WriteItem[]; options?: WriteOptions }, context?: ObservabilityContext, signal?: AbortSignal) => Promise<WriteResultData>
}>
```

说明：
- **移除 opsClient**，统一到 `io.executeOps`。
- `query/write` 永远使用 handle，避免多余的 store 解析。

### 3.3 RuntimeWrite

```ts
type RuntimeWrite = Readonly<{
    resolveStrategy: <T extends Entity>(handle: StoreHandle<T>, options?: StoreOperationOptions) => WriteStrategy | undefined
    allowImplicitFetch: (strategy?: WriteStrategy) => boolean

    prepareAdd: <T extends Entity>(handle: StoreHandle<T>, item: Partial<T>, ctx?: OperationContext) => Promise<PartialWithId<T>>
    prepareUpdate: <T extends Entity>(handle: StoreHandle<T>, base: PartialWithId<T>, patch: PartialWithId<T>, ctx?: OperationContext) => Promise<PartialWithId<T>>

    dispatch: <T extends Entity>(event: StoreDispatchEvent<T>) => void
    applyWriteback: <T extends Entity>(handle: StoreHandle<T>, writeback: PersistWriteback<T>) => Promise<void>

    ensureActionId: (ctx?: OperationContext) => OperationContext | undefined
    ignoreTicketRejections: (ticket: WriteTicket) => void

    // hooks 辅助
    runBeforeSave: <T>(hooks: LifecycleHooks<T> | undefined, item: PartialWithId<T>, action: 'add' | 'update') => Promise<PartialWithId<T>>
    runAfterSave: <T>(hooks: LifecycleHooks<T> | undefined, item: PartialWithId<T>, action: 'add' | 'update') => Promise<void>
}>
```

说明：
- 写流程在 **runtime 内聚**，core/store/ops 只调用 `runtime.write`。
- writeback 的“内存合并”只由 `applyWriteback` 负责。

### 3.4 RuntimeMutation

```ts
type RuntimeMutation = Readonly<{
    begin: () => { ticket: WriteTicket }
    await: (ticket: WriteTicket, options?: StoreOperationOptions) => Promise<void>
    subscribeCommit: (listener: (commit: StoreCommit) => void) => () => void
    ack: (payload: PersistAck<any>) => void
    reject: (payload: PersistAck<any>) => void
}>
```

说明：
- 明确“票据 + commit 事件 + ack/reject”作为 mutation 的唯一职责。

### 3.5 RuntimePersistence

```ts
type RuntimePersistence = Readonly<{
    register: (key: WriteStrategy, handler: PersistHandler) => () => void
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}>
```

说明：
- persistence 不关心写流程，只关心“如何持久化”。

### 3.6 RuntimeObservability

```ts
type RuntimeObservability = Readonly<{
    createContext: (storeName: StoreToken, args?: { traceId?: string; explain?: boolean }) => ObservabilityContext
    registerStore?: (args: { storeName: StoreToken; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => void
}>
```

### 3.7 RuntimeTransform

```ts
type RuntimeTransform = Readonly<{
    inbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    writeback: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
    outbound: <T extends Entity>(handle: StoreHandle<T>, data: T, ctx?: OperationContext) => Promise<T | undefined>
}>
```

说明：
- `dataProcessor` 统一改名为 `transform`，更符合行业语义。

---

## 4. 职责边界（核心原则）

- **core/store/ops**：只调用 `runtime.write` + `runtime.io` + `runtime.transform`。
- **MutationPipeline**：只处理 “patch/rollback/ack”，不直接写 store。
- **StoreStateWriter**：只处理 handle 的 map/index 更新。
- **StoreWriteUtils**：只处理纯函数（无 runtime 依赖）。

---

## 5. 关键链路说明

### 5.1 写入链路

```
store.add/update => runtime.write.prepareX => runtime.write.dispatch
=> mutation pipeline => persistence.persist
=> ack/writeback => runtime.write.applyWriteback
```

### 5.2 查询链路

```
io.query => runtime.transform.writeback => StoreStateWriter.commit
```

### 5.3 插件写回链路

```
plugin.commit.writeback => runtime.write.applyWriteback
```

---

## 6. 命名规范（最终）

- `io`：只表示“协议/传输层”。
- `write`：只表示“写入协调流程”。
- `mutation`：只表示“票据/commit/rollback”。
- `persistence`：只表示“持久化策略”。
- `transform`：只表示“数据处理/序列化”。
- `stores`：只表示“store registry/handle”。

---

## 7. 旧 API → 新 API（语义映射）

- `opsClient` → `io.executeOps`
- `dataProcessor` → `transform`
- `storeWrite` → `write`
- `handles` / `toStoreKey` → `stores.resolveHandle`
- `mutation.acks.{ack,reject}` → `mutation.{ack,reject}`

---

## 8. 结论

这套 API 具备：
- 清晰的职责边界
- 一层结构、语义稳定
- 可替换/可插入的实现点（write/persistence/observe/transform）

它是 **最终定型版本**，可以直接重构替换现有实现。
