# P0-1（A 语义版）：引入 `hydrate` 但保留“补读缓存”语义，并消除中间态写回

> 目标：在 **不改变现有对外语义**（尤其是 A：失败/撤销后仍保留补读到的 base 缓存）的前提下，消除 `update*/delete*` cache miss 路径中的 **中间态 atom set + indexes 重复更新**，降低渲染抖动与 CPU 消耗。

本文是对 `ATOMA_P0_1_MAP_COPY_OPTIMIZATION.zh.md` 的“更具体、可落地”版本，重点解决一个隐藏但关键的问题：

- 如果把补读写回（hydrate）合并进同一个 mutation segment，并按“原始 state”生成 patches，那么 **persist 失败 rollback** 与 **history undo** 的基准都会回到“补读前”，从而改变语义。
- 当前实现里，补读写回发生在 pipeline 之外，因此失败/撤销后 **补读缓存会被保留**。A 版本必须延续这一行为。

---

## 0. A 语义（必须保持的行为）

下面这些是“现有行为”，A 方案必须保持：

1) **persist 失败后**（Direct 或 local-first 的 direct 部分失败）：
   - 仍会保留刚补读到的 base 在本地缓存里（atom + indexes）。
2) **history undo 后**：
   - `updateOne` / `updateMany` 的撤销应回到“补读到的 base”（旧值），而不是把 item 整个删掉。
   - 这是因为现在的“补读写回”先于 update segment，因此 update 的 inverse patches 是相对“补读后状态”生成的。
3) **outbox/queue 模式**仍禁止隐式补读（`allowImplicitFetchForWrite=false`），本方案不改变该约束。

---

## 1. 现状热点与问题复述（只点关键）

以 `src/core/store/ops/updateOne.ts` 为例：

- cache miss：先 `dataSource.get` → `validateWithSchema` → `commitAtomMapUpdateDelta`（一次 atom set + indexes 增量更新）
- 随后 dispatch `type='update'`：进入 pipeline → `AtomCommitter.prepare` 再次 `store.set(atom, plan.nextState)`（第二次 atom set + indexes 更新）

这导致：

- 多一次 atom set → 多一次订阅通知（React/Jotai 订阅链路）
- indexes 也被重复增量更新

批量路径（`updateMany/deleteMany`）同样存在“补读后先写回一次”的额外开销。

---

## 2. 核心设计：`hydrate` 仍然存在，但它只影响“计划基准（baseState）”，不再单独写回 atom

### 2.1 新增内部 event type

在 `StoreDispatchEvent` 增加内部类型（对外仍是可见 type，但标注 internal-only）：

- `type: 'hydrate'`：单条补读结果
- `type: 'hydrateMany'`：批量补读结果

语义：

- 仅用于让同一 segment 的后续写入（update/remove/forceRemove/upsert）在 Reducer 里“看得见 base”
- **不产生持久化 side-effect**：persister 必须忽略
- **只在 draft 不存在该 id 时写入**（避免覆盖并发乐观写入的草稿/新值）

### 2.2 关键点：plan 的 patches/inversePatches 必须以 “补读后 baseState” 为基准

这是 A 语义的核心：

- 先把 hydrate 应用到一个“临时 baseState”（纯内存 Map，不触发 atom set）
- 再用 baseState 去 reduce 非 hydrate 操作，生成 patches/inversePatches

这样：

- history undo 的 inverse patches 会回到 baseState（保留补读缓存）
- persist 失败 rollback 也应回到 baseState（保留补读缓存）

---

## 3. 具体落地改动（按模块）

### 3.1 `src/core/types.ts`：新增 `hydrate` / `hydrateMany`

建议形状：

- `hydrate`：`{ type: 'hydrate'; data: PartialWithId<T> }`
- `hydrateMany`：`{ type: 'hydrateMany'; items: Array<PartialWithId<T>> }`

不建议加 `onSuccess/ticket`：

- hydrate 只是内部“铺底”，不应该改变外部 await/回调语义
- ticket 仍由真正的 write 操作承载即可

### 3.2 `src/core/mutation/pipeline/Scheduler.ts`：保证同一 tick 内多次 dispatch 的顺序稳定

为什么要做：

- 当前实现的 `enqueue()` 在真正入队前会 `await beforeDispatch middleware`，这会导致同一 tick 内连续 `dispatch(A); dispatch(B)` 的最终入队顺序**不稳定**（取决于两个 middleware Promise 的完成顺序）。
- 对 `hydrate → update/remove/forceRemove` 这种强顺序依赖来说，一旦反转就会出现 missing fail 或错误语义。

推荐方案（方案 1：先入队，再执行 middleware）：

- `enqueue()` 变为**纯同步入队**：立刻把 event push 到 `queueMap`，并 `flush()`。
- `drainLoop()` 在 `segmentByContext()` 之前，对每个 atom 的 events **按队列顺序串行**执行 `beforeDispatch`（允许 `await`），并处理：
  - reject：直接 settle ticket + onFail（不进入后续 pipeline）
  - transform：用 transform 后的 event 替换原 event
  - proceed：原样继续
- 在 middleware 之后再做 `normalizeOpContext()`，再按最终事件计算 segment。

这样做的好处：

- 语义清晰：**dispatch 调用顺序 = 系统处理顺序**（至少在同一 atom 队列内），不需要额外的“后补排序规则”来修复乱序。
- 兼容 async middleware（仍可 await），但不会破坏队列的顺序语义。

关于 `hydrate/hydrateMany` 是否走 middleware：

- 可以明确把它们视为 internal-only event，并在 Scheduler 中**默认跳过 beforeDispatch**（直接 proceed），以避免第三方 middleware 因未知 type 而 reject/transform，减少耦合与噪音。
- 即便跳过，仍应走同一套 `normalizeOpContext` 与 segment 逻辑，确保与后续写入合并在同一个 segment 内。

### 3.3 `src/core/mutation/pipeline/types.ts`：给 Plan 增加 `baseState`（可选）

新增字段（可选）：

- `baseState?: Map<EntityId, T>`

含义：

- 本次 plan 的“逻辑基准状态”
- 默认未设置时等同于当前 store.get(atom) 的快照

### 3.4 `src/core/mutation/pipeline/Executor.ts`（或 DefaultPlanner）：生成 plan 前先计算 `baseState`

推荐放在 planner（因为 Scheduler 先 plan 再执行）：

1) 输入：`operations` + `currentState`（store.get(atom)）
2) 先把所有 hydrate/hydrateMany 应用到 `baseState`（只在缺失 id 时 set）
3) 过滤掉 hydrate 事件，得到 `writeOps`
4) `Reducer.reduce(writeOps, baseState)` 得到 plan
5) 返回 `{ ...plan, baseState }`

### 3.5 `src/core/mutation/AtomCommitter.ts`：prepare/rollback 使用 `plan.baseState ?? originalState`

Executor 里把 `originalState` 设为：

- `const originalState = plan.baseState ?? store.get(atom)`

这样：

- optimistic commit：从 baseState → nextState（一次 atom set）
- persist 失败：rollback 回 baseState（保留补读缓存）
- history undo：inversePatches 回 baseState（保留补读缓存）

> 重要：indexes 的 applyPatches(before, after, patches) 这里的 before 是 baseState，但 indexes 当前其实对应“补读前 state”。这在当前 indexes 实现下是可接受的（remove 对不存在 id 是幂等的），最终会把 nextState 的实体正确 add 进去；回滚同理。

### 3.6 `src/core/mutation/pipeline/persisters/*`：显式忽略 hydrate

虽然“未知 operationTypes”目前会自然落空，但建议显式处理，防止未来维护误用：

- Direct：遇到 `hydrate/hydrateMany` 直接 continue
- Outbox：同样 continue，避免 enqueue 任意 intent

### 3.7 `src/core/store/ops/*`：移除 cache miss 的 `commitAtomMapUpdateDelta`，改为 dispatch hydrate

#### `updateOne`

- cache miss：`get` → validate → **不写回 atom**
- 在 dispatch update 前先 dispatch `hydrate(validFetched)`

#### `updateMany`

- miss：`bulkGet(missing)` → validate → 构造 `toHydrate[]` + `baseById`
- 先 dispatch 一次 `hydrateMany(toHydrate)`
- 再 dispatch N 个 `update`（同一 actionId / 同一 persist）

#### `deleteMany`

- miss：`bulkGet(missing)` → validate → 构造 `toHydrate[]`
- 对 `force`：允许通过补读拿到 version（不要再依赖 `jotaiStore.get(atom).has(id)`）
- 先 dispatch `hydrateMany(toHydrate)`
- 再 dispatch N 个 `remove/forceRemove`
- 对补读仍不存在的 id：按现有语义填充 results 为 not found

---

## 4. 语义校验清单（A 版必须通过）

1) `updateOne` cache miss：
   - 成功：只发生一次 atom set（optimistic commit）
   - 失败（persist error）：atom 最终应包含“补读 base”（而不是回到缺失）
   - undo：回到“补读 base”
2) `updateMany/deleteMany` cache miss：
   - 不再出现“补读写回的额外一次 atom set”
   - 仍保持 per-item not found / duplicate id 行为
3) `forceRemove`：
   - 对缓存缺失但允许隐式补读的情况，仍能拿到 baseVersion 并正确持久化（direct）/入队（outbox local-first 情况下 direct 部分）
4) outbox/queue：
   - 禁止隐式补读的约束不变（仍直接报错/返回 per-item error）

---

## 5. 度量与测试建议（落地前就写好）

### 5.1 指标挂点（debug/explain 下）

- atom set 次数：`jotaiStore.set(handle.atom, ...)`
- indexes 更新次数：
  - `indexes.applyPatches`
  - `indexes.applyChangedIds`
  - `indexes.applyMapDiff`

### 5.2 Vitest 回归测试（推荐新增）

至少覆盖：

- updateOne miss：spy `jotaiStore.set` 次数（从 2 → 1），并断言 persist 失败后 store 仍包含 base
- undo 语义：updateOne miss 后 undo，断言回到 base（不是删除）
- deleteMany force miss：允许隐式补读时仍能成功（并且不要求预先 fetch）

---

## 6. 分阶段落地（降低风险）

1) 先做 Scheduler 调整为“先入队、后 middleware”（对全局顺序语义有益）
2) 加类型 `hydrate/hydrateMany` + persister 显式忽略（不改行为）
3) planner/baseState（仍不改 store ops，不上线）
4) 逐个迁移 `updateOne` → `updateMany` → `deleteMany`
5) 加观测 + 回归测试后再开启默认路径
