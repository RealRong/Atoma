# Runtime Change 体系最终设计（一步到位）

## 1. 设计原则

1. 一步到位重构：本次改动直接落到目标架构，不做分阶段迁移。
2. 不保留兼容层：不保留旧 API、旧命名、过渡导出、兼容别名。
3. 语义优先：`StoreChange` 是唯一状态变更语言，optimistic/replay/writeback 全部基于它。
4. 职责清晰：
    - `atoma-core`：领域算法（change 合并、反转、diff）。
    - `atoma-runtime`：执行编排（plan、commit、事件、一致性）。
    - `StoreState`：状态应用与索引同步，不承载写流程编排。

## 2. 最终架构（目标态）

### 2.1 变更算法下沉到 core

新增文件：

- `packages/atoma-core/src/store/changes.ts`

统一承载纯算法（无 runtime 依赖）：

1. `toChange`
2. `invertChanges`
3. `mergeChanges`
4. `diffMaps`

说明：

- 这些算法目前在 runtime 与 core/writeback 存在重复实现，统一后全仓只保留一套。
- 文件在 `store` 目录下，函数名不再重复 `Store` 前缀，保持短而清晰。

### 2.2 StoreState 收敛为双入口

`packages/atoma-types/src/runtime/store/state.ts` 最终接口：

```ts
type StoreState<T extends Entity = Entity> = Readonly<{
    snapshot: () => StoreSnapshot<T>
    subscribe: (listener: StoreListener) => () => void
    indexes: IndexesLike<T> | null
    apply: (changes: ReadonlyArray<StoreChange<T>>) => StoreDelta<T> | null
    writeback: (args: StoreWritebackArgs<T>) => StoreDelta<T> | null
}>
```

关键点：

- 删除 `mutate`。
- `getSnapshot` -> `snapshot`。
- `applyChanges` -> `apply`。
- `applyWriteback` -> `writeback`。

`packages/atoma-runtime/src/store/StoreState.ts` 同步实现以上命名与契约。

### 2.3 optimistic 直接走 apply

`packages/atoma-runtime/src/runtime/flows/write/types.ts`：

- `WritePlanEntry.optimistic` 改为与 `StoreChange` 对齐：
    - `id?: EntityId`
    - `before?: T`
    - `after?: T`

`packages/atoma-runtime/src/runtime/flows/write/planner/buildPlanFromChanges.ts`：

- 直接写入 `optimistic.before/after`。
- 不再使用 `next` 这种偏实现细节命名。

`packages/atoma-runtime/src/runtime/flows/write/commit/commitWrite.ts`：

1. `applyOptimistic`：`plan -> optimisticChanges -> handle.state.apply(...)`
2. `rollbackOptimistic`：`invertChanges(optimistic.changes)` 后再次 `apply(...)`
3. 变更合并使用 core 的 `mergeChanges`

结果：

- optimistic、rollback、replay 全部走同一变更入口，无命令式 draft 分叉路径。

## 3. API 与命名重做（最终命名）

## 3.1 StoreState API

- `getSnapshot` -> `snapshot`
- `applyChanges` -> `apply`
- `applyWriteback` -> `writeback`
- 删除：`mutate`

## 3.2 写流程函数

在 `packages/atoma-runtime/src/runtime/flows/write/commit/commitWrite.ts`：

- `applyOptimisticState` -> `applyOptimistic`
- `rollbackOptimisticState` -> `rollbackOptimistic`
- `resolveWriteResult` -> `resolveResult`

在 `packages/atoma-runtime/src/runtime/flows/write/planner/buildPlanFromChanges.ts`：

- `buildPlanFromChanges` -> `buildPlan`

说明：

- 路径已提供上下文（`write/planner`、`write/commit`），函数名按行业常见写法用短动词短语。

## 3.3 core change 函数命名

在 `packages/atoma-core/src/store/changes.ts`：

- `toChange`
- `invertChanges`
- `mergeChanges`
- `diffMaps`

说明：

- 避免冗长前缀（如 `StoreChangeBuilder`、`buildStoreDeltaFromMaps`）。
- 保持 “动作 + 对象” 的行业主流命名风格。

## 4. 文件归属（最终目录）

- `packages/atoma-core/src/store/changes.ts`：change 纯算法单一来源
- `packages/atoma-core/src/store/writeback.ts`：复用 `changes.ts`，不再自建一套聚合
- `packages/atoma-runtime/src/store/StoreState.ts`：状态应用壳层（调用 core 算法）
- `packages/atoma-runtime/src/runtime/flows/write/planner/buildPlan.ts`
- `packages/atoma-runtime/src/runtime/flows/write/commit/commitWrite.ts`
- `packages/atoma-runtime/src/runtime/flows/write/utils/changes.ts`：仅保留 flow 特有适配，通用算法移除

## 5. 明确删除项（无兼容保留）

1. 删除 `StoreState.mutate`（类型与实现）。
2. 删除旧命名 API（`getSnapshot`、`applyChanges`、`applyWriteback`）。
3. 删除 runtime 内部重复 change 算法实现（以 core 为唯一来源）。
4. 删除 `WritePlanEntry.optimistic.next`（统一为 `after`）。
5. 删除旧函数名导出，不保留 alias。

## 6. 一次性实施清单（单 PR）

1. 修改 `atoma-types/runtime/store/state.ts` 接口到目标态命名。
2. 新增 `atoma-core/store/changes.ts` 并替换全仓引用。
3. 改造 `buildPlanFromChanges` 为 `buildPlan`，补全 `optimistic.before/after`。
4. 改造 `commitWrite`：optimistic/rollback 改为基于 `state.apply`。
5. 删除 `mutate` 与所有调用点。
6. 全仓重命名落地并清理旧导出。

## 7. 验证标准

必须一次通过以下校验：

1. `pnpm --filter atoma-types run typecheck`
2. `pnpm --filter atoma-core run typecheck`
3. `pnpm --filter atoma-runtime run typecheck`
4. `pnpm --filter atoma-client run typecheck`
5. `pnpm --filter atoma-observability run typecheck`

关键行为断言：

1. optimistic 成功时 `changes` 与提交结果合并正确。
2. optimistic 失败时回滚后快照与索引恢复一致。
3. 同 id 多次变更（create/update/delete 组合）折叠正确。
4. `writeStart -> writeCommitted/writeFailed` 事件顺序不变。

## 8. 设计收益

1. 变更算法单一来源，重复逻辑消失。
2. runtime 写流程更短，状态入口更统一。
3. API 更短更清晰，命名符合行业常见语义。
4. 无兼容负担，后续维护成本更低。

