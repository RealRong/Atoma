# P0-1：减少不必要的 Map 拷贝与中间态写回（`src/core`）

> 本文专注一个目标：在 **不改变语义** 的前提下，减少 `atom(Map)` 的额外 `set`/拷贝次数与 indexes 的重复增量更新，从而降低渲染抖动与 CPU 消耗。

---

## 1. 问题是什么（用代码定位，而不是抽象描述）

### 1.1 “中间态写回”指什么

以 `updateOne` 为例：当缓存缺失时，core 会先从 `dataSource.get` 补读并写回 atom，然后再发起真正的 update mutation。

- `src/core/store/ops/updateOne.ts:1`
  - cache miss → `dataSource.get` → `validateWithSchema` → `commitAtomMapUpdateDelta(...)`（**第 1 次 atom set + indexes 更新**）
  - 随后 dispatch `type='update'` → mutation Executor `committer.prepare(...)`（**第 2 次 atom set + indexes 更新**，乐观提交）

同类问题在批量写入中更明显：

- `src/core/store/ops/updateMany.ts:1`（cache miss → `bulkGet` → `bulkAdd` → `commitAtomMapUpdateDelta(...)` → 再逐条 dispatch）
- `src/core/store/ops/deleteMany.ts:1`（cache miss → `bulkGet` → `bulkAdd` → `commitAtomMapUpdateDelta(...)` → 再逐条 dispatch）

### 1.2 为什么这是性能问题

额外的中间态写回会带来：

1) **Map 拷贝成本**：`bulkAdd/add` 返回新的 `Map`，随数据量增大复制成本显著。
2) **indexes 重复更新**：`commitAtomMapUpdateDelta` 会调用 `indexes.applyChangedIds`，而 mutation commit 也会再次触发 indexes 更新。
3) **订阅者/渲染抖动**：atom set 会触发 Jotai 订阅链路，多一次写回就多一次通知（尤其在 React hooks 订阅下）。
4) **调试体验变差**：devtools/observability 会看到更多“无意义的缓存写入”，噪音增大。

---

## 2. 目标与约束（避免“优化把语义搞坏”）

### 2.1 必须保持的语义（invariants）

1) `update*`/`delete*` 在 cache miss 时：
   - direct 模式允许隐式补读（取决于 `allowImplicitFetchForWrite`）
   - outbox/queue 模式禁止隐式补读（当前已通过 `__atoma.allowImplicitFetchForWrite=false` 等机制实现）
2) **Reducer 的一致性规则不变**：
   - `update`：如果 id 不存在，应当失败（目前 reducer 对 missing 会 `onFail` 并跳过）
   - `forceRemove`：需要 baseVersion（来自缓存/服务端写回的 version）
3) “一次用户动作”的聚合能力不应被破坏：
   - Scheduler 按 `scope|origin|actionId|persistMode` 分段（`src/core/mutation/pipeline/Scheduler.ts:1`）
4) 不能把“补读”变成“持久化写入”：
   - 补读只应影响本地缓存（atom/indexes），不应触发 dataSource.put/bulkPut 或 outbox enqueue

### 2.2 优化的成功标准（可量化）

针对 cache miss 写入：

- 每次 `updateOne` cache miss：atom set 次数从 **2 → 1**
- 每次 `updateMany/deleteMany` cache miss：atom set 次数从 **1（补读）+ N（mutation segments） → N（mutation segments）**，并且 **补读不再单独触发一次**
- indexes 增量更新次数同步下降

---

## 3. 推荐方案（优先级最高）：引入“本地 Hydrate 操作”，合并到同一个 mutation segment

> 核心思路：把“补读写回缓存”从 `store ops` 的同步写回，改成一种 **只更新本地缓存、不会持久化** 的内部 mutation operation，并让它与后续写入在同一 segment 内一起被 Reducer/Executor 处理，从而 **只做一次 optimistic commit**。

### 3.1 新增内部操作类型：`hydrate`

在 `StoreDispatchEvent`（`src/core/types.ts:1`）增加一个仅内部使用的分支（示意）：

- `type: 'hydrate'`
- `data: PartialWithId<T>`（或 `items: Array<PartialWithId<T>>`，二选一）
- 语义：把补读得到的实体写入 atom map，使得同一 segment 内后续的 `update/remove/forceRemove` 能看到 base
- 限制：**不产生持久化 side-effects**，persister 必须忽略

为什么用 mutation operation，而不是直接 `commitAtomMapUpdateDelta`：

- `Executor` 会一次性把 plan.nextState 写入 atom（`AtomCommitter.prepare`），避免中间态 atom set
- indexes 的更新也可合并（由同一次 `applyPatches/applyChangedIds` 完成）

### 3.2 Reducer 如何处理 `hydrate`

在 `src/core/mutation/pipeline/Reducer.ts:1` 增加分支（策略建议）：

- 仅当当前 map 中 **不存在该 id** 时才 set（避免覆盖用户本地更“新”的乐观写入）
  - cache miss 补读的目的只是提供 base，用于生成 patch/校验/删除 baseVersion
  - 覆盖已有值会引入竞态风险（例如并发 update 已把草稿写入）
- 如果你需要允许覆盖，也必须有版本/时间戳比较规则（更复杂，不建议 P0 做）

这样，后续 `update/remove` 在 Reducer 内部的 `draft.has(id)` 就能通过，不会因为 cache miss 直接失败。

### 3.3 Persister 必须忽略 `hydrate`

需要同时处理 direct 与 outbox：

- `src/core/mutation/pipeline/persisters/Direct.ts:1`
  - `applyOperations(...)` 不应把 `hydrate` 转成 bulkPut/bulkUpsert
  - `operationTypes` 中遇到 `hydrate`：跳过
- `src/core/mutation/pipeline/persisters/Outbox.ts:1`
  - 不应 enqueue 任意写 intent
  - `types` 中遇到 `hydrate`：跳过

### 3.4 Store ops 的改法（以 `updateOne` 为例）

现状：`updateOne` cache miss 会在 resolveBase 里直接写回 atom。

优化后：

1) cache miss → `dataSource.get` → transform/validate
2) **不写回 atom**
3) dispatch 两个 event（同一 opContext / 同一 persist mode）：
   - `hydrate(validFetched)`
   - `update(validObj)`

为什么可以 dispatch 两次还能保证合并：

- Scheduler 的 `flush` 采用 `queueMicrotask`（`src/core/mutation/pipeline/Scheduler.ts:1`），同一 tick 内 enqueue 的多个事件会被 drainLoop 合并处理。
- 若未显式传 `actionId`，Scheduler 会为同一 `(scope,origin)` 自动分配同一个 actionId，并在 drainLoop 结束时清理缓存。

### 3.5 批量 ops（`updateMany/deleteMany`）如何受益

批量场景的最佳收益点是“补读 N 个缺失 id”：

现状：`bulkGet(missing)` → `bulkAdd(toCache)` → `commitAtomMapUpdateDelta`（一次中间态写回）

优化后：

- `bulkGet(missing)` 得到 `toHydrate[]`
- 把每个缺失 id 变成 `hydrate` 事件（或单个 `hydrateMany` 事件）
- 随后继续 dispatch `update/remove/forceRemove` 事件

这样：

- 中间态 `commitAtomMapUpdateDelta` 完全移除
- 缓存补读写回成为 plan.nextState 的一部分，由一次 optimistic commit 生效

---

## 4. 备选方案（更简单但收益较小）

### 4.1 仅做“补读写回合并”为一次 commit（不引入新 op 类型）

思路：仍然写回 atom，但把 cache miss 的写回延迟到“即将 dispatch 前”，并尽量合并为一次 `commitAtomMapUpdateDelta`。

局限：

- 依然会有“补读写回 + mutation optimistic commit”两次 atom set（updateOne 仍是 2 次）
- 无法把 indexes 更新合并到 mutation commit

这个方案适合你不想改 Reducer/Persister 结构，但它不满足 P0-1 的核心指标（cache miss 场景 atom set 不能降到 1）。

---

## 5. 风险与边界情况（必须提前写在文档里）

### 5.1 Hydrate 覆盖问题（竞态）

如果 `hydrate` 无条件 set，会出现：

- 先有乐观 update 写入了 draft
- 随后 cache miss 补读 hydrate 把旧值覆盖回来

因此建议：hydrate 仅对“当前不存在该 id”的情况写入。

### 5.2 “补读失败”与错误语义

当 `bulkGet/get` 返回 undefined：

- 仍应按现有语义返回 “not found”（updateMany/deleteMany 会记录 per-item error）
- hydrate 不应掩盖该错误

### 5.3 outbox/queue 模式

outbox（尤其 queue 模式）本就禁止隐式补读：

- 该优化主要针对 direct 或 local-first（允许补读）路径
- outbox 相关代码不应因为引入 hydrate 而变复杂：直接不走补读即可

---

## 6. 验证与度量（建议你在落地前先加观测点）

### 6.1 需要采集的指标（建议仅在 debug/explain 下启用）

按 storeName 维度统计：

- `atomSetCount`：`jotaiStore.set(handle.atom, ...)` 次数
- `indexUpdateCount`：`indexes.applyChangedIds/applyPatches/applyMapDiff` 次数
- `cacheMissFetchCount`：写入路径发生 `dataSource.get/bulkGet` 的次数与规模
- `mutationSegmentSize`：每个 segment 的 operation 数量

推荐挂点：

- `commitAtomMapUpdateDelta`（`src/core/store/internals/cacheWriter.ts:1`）
- `AtomCommitter.prepare/commit/rollback`（`src/core/mutation/AtomCommitter.ts:1`）
- `Executor.run` 的生命周期（`src/core/mutation/pipeline/Executor.ts:1`）

### 6.2 回归测试建议（Vitest）

重点覆盖：

- updateOne cache miss：不再出现中间态写回（可通过 spy jotaiStore.set 次数）
- updateMany/deleteMany cache miss：仍能成功更新/删除；并且 per-item not found 与重复 id 语义不变
- hydrate 不会触发持久化：
  - direct：不应调用 dataSource.bulkPut/bulkUpsert
  - outbox：不应 enqueue
- 与 history 的交互：最终 committed patches 仍正确（hydrate 本身是否产生 patches取决于实现，建议不影响用户可见 history，必要时在 HistoryController 里过滤 hydrate 的 patch）

---

## 7. 分阶段落地建议（降低一次性改动风险）

### Phase A（结构准备）

- 明确 `hydrate` 是 internal-only：不对外暴露到 public API（即使从 `#core` 可用，也应在文档中标注 internal）
- 在 persister 里实现“忽略 hydrate”的逻辑

### Phase B（先改 `updateOne`）

- `updateOne` 是最清晰的双写场景（2 次 atom set）
- 先把它降到 1 次，验证观测指标与行为一致性

### Phase C（再改 `updateMany/deleteMany`）

- 引入 `hydrateMany`（单 event 带 items）可以减少事件数量与 Scheduler 压力
- 或保持 hydrate 多事件，但要关注 segment size 与 microtask drain 时长

---

## 8. 相关代码入口（快速跳转）

- `src/core/store/ops/updateOne.ts`：典型双写热点
- `src/core/store/ops/updateMany.ts`：批量 cache miss 写回热点
- `src/core/store/ops/deleteMany.ts`：批量 cache miss 写回热点
- `src/core/store/internals/cacheWriter.ts`：atom set + indexes 增量更新入口
- `src/core/mutation/pipeline/Scheduler.ts`：分段/合批与 auto actionId
- `src/core/mutation/pipeline/Reducer.ts`：新增 hydrate 分支的落点
- `src/core/mutation/pipeline/persisters/Direct.ts`：忽略 hydrate
- `src/core/mutation/pipeline/persisters/Outbox.ts`：忽略 hydrate
- `src/core/mutation/AtomCommitter.ts`：optimistic commit 的唯一写入点

