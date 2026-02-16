# StoreState `commit` 重构方案（一步到位）

更新时间：2026-02-16

## 1. 问题定义

当前 `commit({ before, after, changedIds? })` 的主要问题：

1. `before` 由调用方传入，状态容器内部职责外泄。
2. `changedIds` 可选，语义不稳定（有时是真实集合，有时只是 hint）。
3. 调用点必须手工拼 `before/after`，主流程可读性差。
4. optimistic / writeback / read cache 三条链路都在重复“算 after -> 再提交”的样板逻辑。

---

## 2. 目标（最优形态）

把 `StoreState` 从“提交快照容器”改成“状态变更执行器”：

1. 调用方只描述“怎么改”（recipe / writeback / patches）。
2. `StoreState` 内部统一完成：
   - 状态变更
   - patch 产出
   - changedIds 计算
   - indexes 更新
   - snapshot 提交 + 通知

结论：外部不再直接传 `before/after`。

---

## 3. 目标 API（替换 `commit`）

## 3.1 类型收敛

在 `packages/atoma-types/src/core/writeback.ts` 引入统一 delta 术语（并删除旧术语）：

```ts
export type StoreDelta<T extends Entity> = Readonly<{
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: ReadonlySet<EntityId>
    patches: Patch[]
    inversePatches: Patch[]
}>
```

> 一步到位：`StoreWritebackResult` 全量替换为 `StoreDelta`，不保留兼容别名。

## 3.2 StoreState 对外方法

`packages/atoma-types/src/runtime/storeState.ts` 目标形态：

```ts
export type StoreState<T extends Entity = Entity> = Readonly<{
    getSnapshot: () => StoreSnapshot<T>
    subscribe: (listener: StoreListener) => () => void
    indexes: IndexesLike<T> | null
    mutate: (recipe: (draft: Map<EntityId, T>) => void) => StoreDelta<T> | null
    applyWriteback: (args: StoreWritebackArgs<T>) => StoreDelta<T> | null
    applyPatches: (patches: Patch[]) => StoreDelta<T> | null
}>
```

说明：

1. 删除 `commit`。
2. 删除 `setSnapshot`（当前链路无必要公开入口）。
3. 新增 `mutate/applyPatches`，让 rollback 与局部状态回放不再依赖 `before/after` 手工提交。

---

## 4. 运行时实现方案

## 4.1 SimpleStoreState 内部结构

文件：`packages/atoma-runtime/src/store/StoreState.ts`

新增私有方法（仅内部）：

1. `applyDelta(delta: StoreDelta<T>): void`
2. `collectChangedIdsFromPatches(patches: Patch[], inversePatches: Patch[]): Set<EntityId>`

实现原则：

1. `mutate` 使用 `produceWithPatches(this.snapshot, recipe)`。
2. changedIds 直接由 patch path 根节点收集（`path[0]`）。
3. `applyDelta` 统一做 indexes 与 snapshot 提交。

## 4.2 writeback 复用

`applyWriteback(args)` 继续调用 `engine.mutation.writeback`，然后走 `applyDelta`：

1. core 负责 writeback 业务规则与 patch 产出。
2. state 只负责应用 delta。

## 4.3 patch 回放

`applyPatches(patches)` 使用 `applyPatches(snapshot, patches)` + `produceWithPatches` 同步产出 inverse：

1. rollback 直接用 `optimistic.inversePatches`。
2. 未来 history/devtools 可直接复用统一入口。

---

## 5. 调用链改造点

## 5.1 WriteCommitFlow

文件：`packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts`

调整：

1. `applyOptimisticState` 改为调用 `handle.state.mutate(recipe)`，不再本地 `commit`。
2. optimistic rollback 改为 `handle.state.applyPatches(optimistic.inversePatches)`。
3. writeback 阶段改为 `handle.state.applyWriteback(args)`，直接拿 delta。

收益：写链路只保留编排，不再管理快照细节。

## 5.2 ReadFlow

文件：`packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`

当前所有 `handle.state.commit({...})` 调用替换为 `handle.state.mutate(...)`：

1. query writeback upsert
2. getMany cache fill
3. getAll replace/upsert

收益：读链路不再手工拼 `before/after/changedIds`。

## 5.3 StoreFactory hydrate

文件：`packages/atoma-runtime/src/store/StoreFactory.ts`

`hydrate` 中的 `commit` 改为 `mutate`。

---

## 6. core 层同步调整

文件：`packages/atoma-core/src/store/writeback.ts`

要求保持：

1. writeback 的状态变化与 patch 在同一变更过程产出（`produceWithPatches`）。
2. 返回统一 `StoreDelta`。

---

## 7. 命名收敛（一步到位）

1. `StoreWritebackResult` -> `StoreDelta`（全量替换）。
2. `commit` 删除，不保留兼容 API。
3. state 层统一使用 `mutate/applyWriteback/applyPatches` 三个动作名。

---

## 8. 落地顺序（建议按一次 PR 完成）

1. **types 先改**：定义 `StoreDelta`，更新 `StoreState` 接口。
2. **runtime state 实现**：`SimpleStoreState` 实现新 API，删除 `commit/setSnapshot`。
3. **runtime flows 改造**：WriteCommitFlow / ReadFlow / StoreFactory 全部切换新 API。
4. **core 对齐**：writeback 返回类型改为 `StoreDelta`。
5. **全仓编译检查**：消除所有旧 `commit` 调用。

---

## 9. 验收标准

1. 全仓无 `handle.state.commit(` 调用。
2. 全仓无 `StoreWritebackResult` 术语。
3. 写链路 patch 只在变更过程中产出（optimistic + writeback）。
4. rollback 不依赖 `before/after` 手工提交。
5. 通过：
   - `pnpm --filter atoma-runtime run typecheck`
   - `pnpm --filter atoma-core run typecheck`
   - `pnpm --filter atoma-types run typecheck`
   - `pnpm typecheck`

