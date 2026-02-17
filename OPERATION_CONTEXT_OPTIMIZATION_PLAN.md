# ActionContext 优化方案（命名 / 参数 / Plugin API）

更新时间：2026-02-17

## 1. 结论

`OperationContext` 这条能力需要保留，但应一步到位收敛到 `ActionContext` 方案。

目标：

1. 核心类型统一为 `ActionContext`，字段 `actionId` 统一改为 `id`。
2. 不引入 `ActionContextInput`，外部输入统一 `Partial<ActionContext>`。
3. 全链路参数名统一 `context`（禁用 `opContext/ctx`）。
4. PluginContext stores API 调整为：`storeName` 第一参数，数据第二参数，控制项第三参数。
5. `stores.query` 采用 `query(storeName, query)`，不使用 options 包裹单参数。
6. `applyWriteback` 采用 `applyWriteback(storeName, data, options?)`，与行业常见三段式保持一致。

---

## 2. 现状链路（已确认）

### 2.1 入口与创建

- `StoreOperationOptions` 当前字段为 `opContext?: OperationContext`（待收敛）
  - `packages/atoma-types/src/core/store.ts:40`
- 写入入口创建上下文
  - `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:47`
- 创建函数位于 core
  - `packages/atoma-core/src/operation.ts:6`

### 2.2 传播路径

- WriteFlow -> adapters/planner/transform -> execution.write
  - `packages/atoma-runtime/src/runtime/flows/write/adapters/intentToChanges.ts:78`
  - `packages/atoma-runtime/src/runtime/flows/write/planner/buildPlanFromChanges.ts:105`
  - `packages/atoma-runtime/src/runtime/transform/TransformPipeline.ts:117`
  - `packages/atoma-types/src/runtime/persistence.ts:110`

### 2.3 消费方

- history：按“动作 id + scope”聚合撤销单元
  - `packages/plugins/atoma-history/src/history-manager.ts:137`
- observability：写入 trace 绑定动作 id
  - `packages/plugins/atoma-observability/src/plugin.ts:242`
- backend-shared：把 context 映射到协议 `meta`
  - `packages/plugins/atoma-backend-shared/src/buildOperationExecutor.ts:188`

---

## 3. 目标命名与类型（终局）

```ts
export type ActionOrigin =
    | 'user'
    | 'history'
    | 'sync'
    | 'system'
    | (string & {})

export type ActionContext = Readonly<{
    id: string
    scope: string
    origin: ActionOrigin
    label?: string
    timestamp: number
}>
```

创建 API：

```ts
createActionContext(
    context?: Partial<ActionContext>,
    options?: { defaultScope?: string; defaultOrigin?: ActionOrigin; now?: () => number }
): ActionContext
```

约束：

- 不新增 `ActionContextInput`。
- 所有“可选输入”统一 `Partial<ActionContext>`。
- 所有内部落地对象必须是完整 `ActionContext`。

---

## 4. PluginContext API 设计（最优）

## 4.1 设计原则

统一采用固定参数位次：

- 第一参数：目标（`storeName`）
- 第二参数：核心数据（`query` / `changes` / `writeback data`）
- 第三参数：必要语义参数（例如 `direction`）
- 最后参数：控制项（`options`，可选）

这样调用最短、语义最清楚，也最符合常见 SDK 风格。

## 4.2 推荐签名

```ts
type StoreActionOptions = Readonly<{
    context?: Partial<ActionContext>
}>

type WritebackData<T extends Entity> = Readonly<{
    upserts: T[]
    deletes: EntityId[]
    versionUpdates?: Array<{ entityId: EntityId; version: number }>
}>

type PluginRuntimeStores = Readonly<{
    list: () => StoreToken[]
    ensure: <T extends Entity>(storeName: StoreToken) => Store<T>

    query: <T extends Entity>(
        storeName: StoreToken,
        query: Query<T>
    ) => QueryResult<T>

    applyChanges: <T extends Entity>(
        storeName: StoreToken,
        changes: ReadonlyArray<StoreChange<T>>,
        direction: ChangeDirection,
        options?: StoreActionOptions
    ) => Promise<void>

    applyWriteback: <T extends Entity>(
        storeName: StoreToken,
        data: WritebackData<T>,
        options?: StoreActionOptions
    ) => Promise<StoreDelta<T> | null>
}>
```

说明：

- `StoreToken` 已是 `string` 语义别名，保留即可；不需要额外改成裸 `string`。
- `query` 第二参数直接传 `Query<T>`，避免 `options.query` 这种单字段包裹。
- `applyWriteback(storeName, data, options?)` 比 `{ storeName, ... }` 更利于阅读和扩展。
- `applyChanges` 把 `direction` 提升为独立参数，避免把核心语义藏在 `options` 里。

## 4.3 其他 API 同步建议

- 在 `PluginRuntime` 增加：

```ts
action: Readonly<{
    createContext: (context?: Partial<ActionContext>) => ActionContext
}>
```

让插件直接通过 runtime 造 context，避免插件绕到 core 自行 import。

---

## 5. 行为语义调整

## 5.1 批量写入默认共享 context.id

目标：一次 `addMany/updateMany/upsertMany/deleteMany` 默认共享同一个 `id`。  
收益：

- history 聚合更自然（一次调用 = 一次动作）
- trace 聚合更稳定
- 日志/回放更容易关联

规则：

- 若用户传 `options.context`，整批共用
- 若未传，批量入口生成一次默认 context 并透传

## 5.2 协议 meta 映射

保持简单映射：

- `meta.clientTimeMs = context.timestamp`
- `meta.requestId = context.id`
- `meta.traceId = context.id`

---

## 6. 命名统一规范

全仓统一：

- 类型：`ActionContext` / `ActionOrigin`
- 字段：`id`（替代 `actionId`）
- 参数：`context`
- 禁用：`opContext`、`ctx`

示例：

- `createContext(options?.context)`
- `runtime.transform.inbound(handle, data, context)`
- `events.emit.writeStart({ ..., context })`

---

## 7. 文件级改造清单

### P0（核心链路）

1. `packages/atoma-types/src/core/operation.ts`
   - `OperationContext` -> `ActionContext`
   - `OperationOrigin` -> `ActionOrigin`
   - 字段 `actionId` -> `id`
2. `packages/atoma-types/src/core/store.ts`
   - `StoreOperationOptions.opContext` -> `context?: Partial<ActionContext>`
3. `packages/atoma-types/src/runtime/engine/operation.ts`
   - `createContext` 入参使用 `Partial<ActionContext>`
4. `packages/atoma-types/src/runtime/persistence.ts`
   - `WriteRequest.opContext` -> `context`
5. `packages/atoma-core/src/operation.ts`
   - `createOperationContext` -> `createActionContext`
   - 入参改为 `Partial<ActionContext>`
6. `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
   - 全量 `opContext` -> `context`
   - context 创建注入 `now: runtime.now`
   - `*Many` 共享同一 `context.id`
7. `packages/atoma-runtime/src/runtime/flows/write/*`
   - 全量 `opContext` -> `context`
8. `packages/atoma-runtime/src/runtime/transform/TransformPipeline.ts`
   - `opContext` 参数与 stage context 字段统一改 `context`

### P1（PluginContext 与插件）

1. `packages/atoma-types/src/client/plugins/contracts.ts`
   - stores API 全量改签名：`storeName` 第一参数，数据第二参数，必要语义参数后置，`options` 末位可选
   - `query(storeName, query)`
   - `applyChanges(storeName, changes, direction, options?)`
   - `applyWriteback(storeName, data, options?)`
2. `packages/atoma-client/src/plugins/PluginContext.ts`
   - 实现上述签名
   - 暴露 `runtime.action.createContext`
3. `packages/plugins/atoma-history/src/*`
   - 调用方式同步至新 stores API
   - `actionId` 字段使用改为 `id`
4. `packages/plugins/atoma-observability/src/plugin.ts`
   - 事件读取 `context.id`
5. `packages/plugins/atoma-backend-shared/src/buildOperationExecutor.ts`
   - `request.context.id/timestamp` 映射 meta

### P2（文档）

- `README.md` / `README.zh.md` 与架构文档统一更新为 `ActionContext` + `id`

---

## 8. 兼容策略

按仓库“无兼容负担”原则：

- 不保留 `OperationContext` / `opContext` / `actionId` 别名
- 不保留双字段并存
- 一次性替换到位

---

## 9. 验证清单

1. `pnpm --filter atoma-types run typecheck`
2. `pnpm --filter atoma-core run typecheck`
3. `pnpm --filter atoma-runtime run typecheck`
4. `pnpm --filter atoma-client run typecheck`
5. `pnpm --filter atoma-history run typecheck`
6. `pnpm --filter atoma-observability run typecheck`
7. `pnpm --filter atoma-backend-shared run typecheck`
8. `pnpm typecheck`

验收标准：

- 无 `opContext`/`actionId` 遗留
- 插件 API 统一为固定参数位次（`storeName -> data -> semantic args -> options?`）
- 写入、undo/redo、observability 链路行为一致
- 批量写入默认共享 `context.id`

---

## 10. 最终建议

这次优化应一次完成四件事：

1. 命名终局：`ActionContext` + `id`
2. 输入收敛：统一 `Partial<ActionContext>`
3. Plugin API 收敛：`storeName + data + options`
4. 语义收敛：批量共享 `context.id`

这样上下游（runtime / plugin / backend）会形成一套稳定且低噪音的上下文协议。
