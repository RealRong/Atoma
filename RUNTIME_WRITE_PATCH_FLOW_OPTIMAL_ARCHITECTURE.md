# Runtime 写入 Patch 链路最优架构（一步到位方案）

更新时间：2026-02-16

## 1. 目标

本方案聚焦 `atoma-runtime` 写入主链路的可读性与职责收敛，核心目标：

1. 去掉 `buildPatchFromState` 这类“二次推导 patch”逻辑。
2. 让 `runtime.engine.mutation.writeback` 成为 writeback patch 的唯一产出点。
3. `applyOptimistically` 的 `changedIds` 直接从 `plan` 收集，不再从 patch path 反推。
4. 上下游（StoreState / PluginContext / Sync）围绕同一套 writeback 结果语义对齐。

---

## 2. 当前链路与主要痛点

当前主链路：

1. `WriteFlow` 编排写入并发事件。
2. `WriteCommitFlow` 执行 optimistic -> execution.write -> writeback。
3. optimistic patch 在 `produceWithPatches` 里生成。
4. writeback patch 由 `buildPatchFromState` 在 runtime 层补算。

主要问题：

1. **职责分散**：writeback 的状态变化在 mutation 层发生，但 patch 在 runtime 层补算。
2. **心智负担高**：需要理解“先改状态，再回放 changedIds 生成 patch”的双阶段逻辑。
3. **changedIds 来源不直观**：optimistic changedIds 目前通过 patch 反推，不如直接来自 `plan` 清晰。
4. **上下游语义不统一**：`StoreState.applyWriteback`、`WriteCommitFlow.applyWritebackResult`、`PluginContext.applyWriteback` 对 writeback delta 的消费方式不同。

---

## 3. 最优职责模型（目标态）

### 3.1 core（事实层）

`atoma-core/store/writeback` 负责：

1. 应用 `StoreWritebackArgs`。
2. 返回 `before/after/changedIds`。
3. **同时返回 `patches/inversePatches`**（Map 根路径 patch）。

> 结论：writeback 的状态事实与 patch 事实必须同源产出。

### 3.2 runtime（编排层）

`WriteCommitFlow` 负责：

1. optimistic 提交（并拿到 optimistic patch）。
2. 调用 execution 写出。
3. 应用 writeback（直接消费 mutation.writeback 的 patch）。
4. 按规则合并 patch（`rawPatchPayload` 优先）。

`WriteFlow` 负责：

1. 事件发射。
2. 结果收敛。
3. 不参与 patch 推导。

### 3.3 client/plugin（消费层）

`PluginContext.runtime.stores.applyWriteback` 负责：

1. 传入 writeback args。
2. 可选返回 writeback delta（至少包含 changedIds，建议包含 patch）。
3. 由调用方决定是否继续发事件或记录历史。

---

## 4. 关键设计点（含你要求的 changedIds 策略）

### 4.1 applyOptimistically：changedIds 直接来自 plan

推荐策略：

1. `produceWithPatches` 继续用于产出 optimistic `afterState + patches`。
2. `changedIds` 通过 `collectChangedIdsFromPlan(plan)` 收集 `planEntry.optimistic.entityId`。

收益：

1. 语义直观：变更集合来自写计划，而非 patch 编码细节。
2. 去掉 path 解析逻辑，降低 brittle 代码。
3. 与业务意图对齐（写计划就是变更意图）。

### 4.2 writeback patch 由 mutation.writeback 直接产出

目标调整：

1. 扩展 `StoreWritebackResult`：加入 `patches` 与 `inversePatches` 字段（不新增复杂新类型）。
2. `WriteCommitFlow.applyWritebackResult` 直接读取 `writebackResult.patches`，删除 `buildPatchFromState`。

收益：

1. 一次计算拿齐 delta，去掉 runtime 二次回放。
2. writeback 行为的“状态结果 + patch 结果”天然一致。
3. 未来任何调用 writeback 的链路都可复用同一 delta 结构。

### 4.3 patch 合并规则（保持不变但文档化）

1. 正向 patch：`optimistic.patches + writeback.patches`
2. 逆向 patch：`writeback.inversePatches + optimistic.inversePatches`
3. `rawPatchPayload` 存在时优先覆盖（保留 `write.patches(...)` 输入语义）

---

## 5. 上下链路可继续优化点（补充）

### 5.1 StoreState.applyWriteback 建议返回结果

当前 `applyWriteback` 返回 `void`，导致上层拿不到 writeback delta。  
建议改为返回 `StoreWritebackResult | null`，并保持内部 commit 行为不变。

价值：

1. Plugin 或 runtime 可按需消费 patch / changedIds。
2. 减少 duplicate 逻辑（不再重复“先 writeback 再额外推导”）。

### 5.2 WriteCommitResult 可收敛字段

当前 `WriteFlow` 只消费 `output` 与 `patchPayload`。  
若 `beforeState/afterState/changedIds` 无外部用途，可从 `WriteCommitResult` 移除，减少噪音。

### 5.3 patch 写入路径（write.patches）可增强一致性说明

`write.patches(...)` 当前是“给定 patch 优先”。  
建议在文档明确：

1. raw patch 代表用户意图，优先用于 `writePatches` 事件。
2. 远端 writeback 若产生额外字段（如 version），是否并入 patch 需固定策略（建议默认不并入，保持可逆历史稳定）。

### 5.4 WriteEntryFactory / patchPlan 元数据生成可统一

当前 `createWriteItemMeta` 与 `patchPlan` 中 meta 生成是两套实现。  
建议复用同一生成入口，保证 idempotencyKey/clientTimeMs 语义一致。

### 5.5 错误语义统一

`transform returned empty`、`Item not found` 等错误信息分散。  
建议统一错误前缀与模板（便于调试与插件归类）。

---

## 6. 一步到位改造清单（按层）

### 6.1 atoma-types

1. `packages/atoma-types/src/core/writeback.ts`
   - 扩展 `StoreWritebackResult`：加入 `patches/inversePatches`。
2. `packages/atoma-types/src/runtime/engine/mutation.ts`
   - `writeback` 返回类型同步更新。
3. `packages/atoma-types/src/runtime/storeState.ts`
   - `applyWriteback` 返回 `StoreWritebackResult<T> | null`。

### 6.2 atoma-core

1. `packages/atoma-core/src/store/writeback.ts`
   - 在 writeback 主过程直接产出 patch（与状态更新同源）。
   - 保留 `preserveRef` 语义，保证引用稳定策略不变。

### 6.3 atoma-runtime

1. `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts`
   - 删除 `buildPatchFromState`。
   - `applyOptimistically` 改为 `changedIds` 直接由 `plan` 收集。
   - `applyWritebackResult` 直接消费 `writeback` 返回 patch。
2. `packages/atoma-runtime/src/store/StoreState.ts`
   - `applyWriteback` 返回 writeback 结果。
3. `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
   - 保持“只编排+事件”，不增加 patch 推导逻辑。

### 6.4 atoma-client / plugins（可选但建议）

1. `packages/atoma-client/src/plugins/PluginContext.ts`
   - `runtime.stores.applyWriteback` 可向上返回 delta（便于 sync/history 决策）。
2. `packages/plugins/atoma-sync/...`
   - 若需要观测 writeback patch，可直接消费 applyWriteback 返回值。

---

## 7. 命名与复杂度控制

遵循“少类型、短命名、语义直接”：

1. 保留 `ExecutionRoute`（不引入 `routeId`）。
2. 保留 `WritePatchPayload`（不再拆分多层 patch 类型）。
3. writeback 结果只扩展字段，不新增复杂包装对象。

---

## 8. 验收标准

1. `WriteCommitFlow` 中不存在 `buildPatchFromState`/path 反推 changedIds 逻辑。
2. writeback patch 来源唯一：`mutation.writeback`。
3. optimistic changedIds 来源唯一：`plan`。
4. `WriteFlow` 维持单一职责：编排 + emit。
5. `pnpm --filter atoma-runtime run typecheck` 与 `pnpm typecheck` 通过。
