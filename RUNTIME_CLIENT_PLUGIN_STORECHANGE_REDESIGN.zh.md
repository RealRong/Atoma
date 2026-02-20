# Runtime / Client / Plugin StoreChange 统一重构方案（一步到位）

## 1. 背景与问题

当前链路已完成 `apply/revert/writeback` 与 `StoreState` 的一轮收敛，但仍有三类噪音：

1. 同一变更多次翻译：
   `intent -> StoreChange -> WriteEntry -> WriteItemResult -> writeback -> StoreChange`
2. `runtime/handle/context/route/signal` 在 read/write flow 内层层透传。
3. plugin contract 与 core 类型重复定义（`StoreActionOptions`、`WritebackData`），且每次调用重复 `ensureHandle`。

直接后果：

1. 流程阅读成本高，职责边界不够直观。
2. API 层级存在“语义重复但名字不同”的负担。
3. plugin 侧需要知道过多 runtime 内部细节（`handle`）。

---

## 2. 目标与硬约束

## 2.1 目标

1. `StoreChange` 成为 runtime/client/plugin 的唯一公开写语义。
2. `StoreHandle` 仅保留在 runtime 内部，不外溢到 plugin 和事件 payload。
3. 写流程拉直为可理解的三段：`prepare -> plan -> commit`。
4. 去掉重复类型与重复入口，命名更短更清晰。

## 2.2 硬约束

1. 一步到位，不做多阶段迁移。
2. 不保留兼容层、别名导出、双轨 API。
3. 只允许子路径导入，不使用 `atoma-types` 根导入。
4. 语义不变：`writeback` 入口继续保留（承载 `versionUpdates`）。

---

## 3. 最终架构（目标态）

## 3.1 公开层：以 StoreChange 为中心

公开写接口仅保留三类输入：

1. `apply(changes)`
2. `revert(changes)`
3. `writeback(args)`

其中：

1. `changes` 类型为 `ReadonlyArray<StoreChange<T>>`
2. `args` 类型为 `StoreWritebackArgs<T>`
3. `options` 统一为 `StoreOperationOptions`

`WriteEntry`、`WriteItemResult` 仅存在于 runtime 执行层内部。

## 3.2 Store 操作入口改为“先绑定 store，再执行”

将“每次调用都传 `storeName`”改为“先获取 `store` 作用域对象”。

### Runtime 侧（`atoma-types/runtime/store/catalog.ts`）

```ts
export type StoreOps<T extends Entity = Entity> = Readonly<{
    name: StoreToken
    store: Store<T>
    query: (query: Query<T>) => QueryResult<T>
    apply: (changes: ReadonlyArray<StoreChange<T>>, options?: StoreOperationOptions) => Promise<void>
    revert: (changes: ReadonlyArray<StoreChange<T>>, options?: StoreOperationOptions) => Promise<void>
    writeback: (args: StoreWritebackArgs<T>, options?: StoreOperationOptions) => Promise<StoreDelta<T> | null>
}>

export type StoreCatalog = Readonly<{
    use: <T extends Entity = Entity>(name: StoreToken, tag?: string) => StoreOps<T>
    list: () => Iterable<Store<Entity>>
}>
```

说明：

1. 删除 `ensureHandle` 暴露。
2. `use(name)` 内部绑定 handle，并可缓存 `StoreOps`。
3. `store` 字段保留给通用 CRUD；`apply/revert/writeback` 走 change 语义入口。

### Plugin 侧（`atoma-types/client/plugins/contracts.ts`）

```ts
export type PluginRuntime = Readonly<{
    id: Runtime['id']
    now: Runtime['now']
    stores: Readonly<{
        list: () => StoreToken[]
        use: <T extends Entity = Entity>(storeName: StoreToken) => StoreOps<T>
    }>
    action: Readonly<{
        createContext: (context?: Partial<ActionContext>) => ActionContext
    }>
    execution: Readonly<{
        apply: Runtime['execution']['apply']
        subscribe: Runtime['execution']['subscribe']
    }>
    snapshot: Readonly<{
        store: Runtime['debug']['snapshotStore']
        indexes: Runtime['debug']['snapshotIndexes']
    }>
}>
```

同时删除 plugin 私有重复类型：

1. `StoreActionOptions`（改用 core `StoreOperationOptions`）
2. `WritebackData`（改用 core `StoreWritebackArgs`）

## 3.3 事件契约去 handle 化

`StoreEvents` payload 改为以 `storeName` 为主键，不再暴露 `handle`。

目标结构（`atoma-types/runtime/store/events.ts`）：

```ts
type WriteCommittedArgs<T extends Entity = Entity> = Readonly<{
    storeName: StoreToken
    context: ActionContext
    route?: ExecutionRoute
    writeEntries: ReadonlyArray<WriteEntry>
    result?: unknown
    changes?: ReadonlyArray<StoreChange<T>>
}>
```

同理调整：

1. `readStart`
2. `readFinish`
3. `writeStart`
4. `writeFailed`
5. `storeCreated`

收益：插件监听不再依赖 `args.handle.storeName`。

## 3.4 写流程拉直

`WriteFlow` 内部固定三段：

1. `prepare`：`intent/replay -> changes`，并完成 `outbound` 预处理与校验。
2. `plan`：纯函数，根据 prepared changes + policy 生成 `WritePlan`。
3. `commit`：执行写入、处理结果、合并 optimistic 与 transaction changes。

关键点：

1. `buildPlan` 变为纯构建，不再直接触达 `runtime.transform`。
2. outbound 空值错误在 `prepare` 统一抛出（避免 plan 层混杂 runtime 依赖）。
3. `commitWrite` 仅处理执行与回滚，不负责输入归一。

## 3.5 读流程降噪

`ReadFlow` 同步引入局部作用域对象（例如 `ReadScope`），内部 helper 不再重复传 `handle`。

---

## 4. 目录与文件改造清单

## 4.1 atoma-types

1. `packages/atoma-types/src/runtime/store/catalog.ts`
   - 新增 `StoreOps`
   - `StoreCatalog` 改为 `use + list`
   - 删除 `ensureHandle` 类型暴露
2. `packages/atoma-types/src/client/plugins/contracts.ts`
   - `stores` 改为 `list + use`
   - 删除 `StoreActionOptions`
   - 删除 `WritebackData`
   - 直接使用 `StoreOperationOptions`、`StoreWritebackArgs`
3. `packages/atoma-types/src/runtime/store/events.ts`
   - 所有 payload 改为 `storeName` 主键
   - 删除 payload 中的 `handle`
4. `packages/atoma-types/src/runtime/index.ts`
   - 导出更新，清理被删除类型

## 4.2 atoma-runtime

1. `packages/atoma-runtime/src/store/Stores.ts`
   - 引入 `use(name)`，内部缓存 `StoreOps`
   - `ensureHandle` 改为私有实现细节（不再出现在对外类型）
2. `packages/atoma-runtime/src/store/StoreFactory.ts`
   - 返回可供 `StoreOps` 复用的绑定对象
   - 避免在外层重复拼装 `handle -> read/write` 闭包
3. `packages/atoma-runtime/src/runtime/Runtime.ts`
   - `stores` 对外契约切换到新 `StoreCatalog`
4. `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
   - 明确拆分 `prepare/plan/commit`
   - 统一 `WriteScope`，减少参数透传
5. `packages/atoma-runtime/src/runtime/flows/write/types.ts`
   - `WriteCommitRequest` 改为持有 `scope`，不重复散列字段
6. `packages/atoma-runtime/src/runtime/flows/write/planner/buildPlan.ts`
   - 改为纯函数（仅基于 prepared 输入）
7. `packages/atoma-runtime/src/runtime/flows/write/commit/commitWrite.ts`
   - 仅处理执行、回滚、结果合并
8. `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
   - helper 改为闭包绑定 scope，减少 `handle` 显式传递
9. `packages/atoma-runtime/src/runtime/registry/StoreEventRegistry.ts`
   - 调整 emit payload 结构以匹配新 events 类型

## 4.3 atoma-client / plugins

1. `packages/atoma-client/src/plugins/PluginContext.ts`
   - `runtime.stores.use(name)` 作为唯一写操作入口
   - 内部缓存 store session，避免重复 `ensureHandle`
2. `packages/plugins/atoma-history/src/plugin.ts`
   - `ctx.runtime.stores.use(storeName).apply/revert`
   - 事件读取 `args.storeName`，不再依赖 `args.handle.storeName`
3. `packages/plugins/atoma-history/src/history-manager.ts`
   - 入参类型同步新 `PluginRuntime` store 接口
4. `packages/plugins/atoma-sync/src/applier/writeback-applier.ts`
   - `runtime.stores.use(resource).writeback(args)`
   - 删除 `as any` 结构性兜底

---

## 5. API 设计细节（命名与职责）

## 5.1 命名

1. `use(name)`：表示绑定并复用 store 上下文。
2. `StoreOps`：强调“操作集合”，避免重复前缀。
3. `prepare/plan/commit`：流程动词，符合行业常见写法。

## 5.2 职责边界

1. core：变更算法与 mutation 基础能力。
2. runtime：执行编排、transform、事件发射、状态提交。
3. client/plugin：调用 runtime 能力，不持有 handle，不管理执行细节。

## 5.3 writeback 保留原则

`writeback` 不与 `apply` 合并，原因：

1. 支持 `versionUpdates` 这种非纯 change 回写。
2. sync ack/reject/pull 直接映射到 writeback 模型，语义清晰。

---

## 6. 一次性实施顺序（单方向落地）

1. 先改 `atoma-types` 契约。
2. 再改 `atoma-runtime` 内部实现与事件 payload。
3. 再改 `atoma-client` 的 `PluginContext`。
4. 最后改 history/sync 插件调用。
5. 清理旧 API/旧类型/旧导出。

说明：不插入过渡别名；每一步直接落到最终命名。

---

## 7. 明确删除项

1. `StoreCatalog.ensureHandle`（公开类型层面删除）。
2. plugin contracts 的 `StoreActionOptions`。
3. plugin contracts 的 `WritebackData`。
4. `stores.apply(storeName, ...)` / `stores.revert(storeName, ...)` / `stores.writeback(storeName, ...)` 旧形态。
5. 所有事件 payload 的 `handle` 字段。
6. 写流程中与 `prepare/plan/commit` 分层冲突的辅助透传函数签名。

---

## 8. 验证与验收标准

## 8.1 命令验证

1. `pnpm --filter atoma-types run typecheck`
2. `pnpm --filter atoma-runtime run typecheck`
3. `pnpm --filter atoma-client run typecheck`
4. `pnpm --filter atoma-history run typecheck`
5. `pnpm --filter atoma-sync run typecheck`
6. `pnpm typecheck`

## 8.2 行为验收

1. history 插件 undo/redo 行为不变，事件可正常记录变更。
2. sync ack/reject/pull 仍通过 `writeback` 正确更新本地与版本号。
3. optimistic 成功/失败回滚语义不变。
4. 多 store 并发下 `stores.use(name)` 不产生错误复用（按 storeName 隔离）。
5. 事件回调不再依赖 `handle` 仍可完成原有功能。

---

## 9. 预期收益

1. `StoreChange` 成为真正单一写语义，跨层一致。
2. runtime/client/plugin 的调用噪音显著下降。
3. 类型系统去重，减少维护与理解成本。
4. 写流程更易测试：prepare、plan、commit 可以分别断言。
5. 后续扩展（批量 replay、审计、同步策略）只需围绕 StoreOps 扩展，不再扩散 handle 细节。
