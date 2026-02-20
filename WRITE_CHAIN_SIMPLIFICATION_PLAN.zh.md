# Runtime 写入链路梳理与四点简化方案（一步到位）

日期：2026-02-20

当前落地状态：

1. 方案一已完成（`adapt + buildPlan` 合并为 `compileIntentToPlan`）。
2. 方案二已完成（`commitWrite` 直接消费 `optimisticChanges`）。
3. 方案三已完成（写结果按 index 对齐，`entryId` 仅用于诊断校验）。
4. 方案四已完成（`apply/revert` 改为本地回放，不再走 `execution.write`）。

## 0. 结论先行

1. 第 3 点可以做，但不能直接做。必须先把 `execution.write` 结果顺序契约改成强约束，并同步改所有执行器与协议映射。
2. 第 4 点可以做，而且建议做。`apply/revert` 更适合作为“本地 StoreChange 回放”入口，不应再走远端写入链路。

---

## 1. 当前整条链路梳理

## 1.1 Intent 写入主链路（create/update/upsert/delete）

1. `StoreFactory` 暴露的 `Store` API 将调用转发到 `runtime.write.*`。  
   入口见：`packages/atoma-runtime/src/store/StoreFactory.ts:89`
2. `WriteFlow` 创建 `WriteScope`（`handle/context/route/signal/createEntryId`）。  
   见：`packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:26`
3. `runIntent -> runInput(kind='intent')`。  
   见：`packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:197`
4. `compileIntentToPlan` 一次完成 prepare + outbound + 计划编译，直接产出 `WritePlan(entries + optimisticChanges)`。  
   见：`packages/atoma-runtime/src/runtime/flows/write/adapters/intentToPlan.ts:99`
6. `commitWrite`：
   - optimistic 阶段：直接 `state.apply(plan.optimisticChanges)`
   - 执行阶段：`runtime.execution.write({ entries: plan.entries })`
   - 结果阶段：按 index 对齐消费结果、构建 writeback、合并 changes  
   见：`packages/atoma-runtime/src/runtime/flows/write/commit/commitWrite.ts:159`
7. 事件：`writeStart/writeCommitted/writeFailed` 由 `WriteFlow` 发射。  
   见：`packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:54`

## 1.2 Replay 链路（apply/revert）

1. `StoreSession.apply/revert` 进入 `runtime.write.apply/revert`。  
   见：`packages/atoma-runtime/src/store/Stores.ts:70`
2. `WriteFlow.replay`：
   - `adaptReplayChanges` 做 forward/backward 方向处理
   - 直接 `handle.state.apply(...)` 本地回放
   - 不再调用 `execution.write` / `commitWrite`。  
   见：`packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:123`

## 1.3 Writeback 链路（独立于 WriteFlow）

1. `StoreSession.writeback`：`transform.writeback -> state.writeback`。  
   见：`packages/atoma-runtime/src/store/Stores.ts:82`
2. `ReadFlow` 远端 query 返回后也走 `transform.writeback + state.writeback`。  
   见：`packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:62`
3. `atoma-sync` 的回放/ack/reject 全走 `stores.use(...).writeback(...)`。  
   见：`packages/plugins/atoma-sync/src/applier/writeback-applier.ts:44`

---

## 2. 历史复杂度来源（已清理）

1. 模型重复翻译：`PlannedChange -> WritePlanEntry.optimistic -> StoreChange`（已移除）。
2. Replay 与 Intent 共用远端提交链路（已拆分，本地 replay 不再走 execution）。
3. `commitWrite.resolveResult` 依赖 `entryId` 映射（已改为按 index 消费）。
4. 执行器层无顺序契约（已补齐 results 与 entries 顺序对齐约束）。

---

## 3. 四点方案（已落地）

## 3.1 方案一：合并 `adapt + buildPlan` 为单一编译阶段

结果：已删除 `PlannedChange` 中间层。

当前入口：

```ts
compileIntentToPlan(runtime, input) -> {
    entries: WriteEntry[]
    optimisticChanges: StoreChange<T>[]
    output?: T
    primary?: { action: WriteEntry['action']; id?: EntityId }
}
```

已实现效果：

1. `WriteFlow` 不再分别调用 adapter/planner。
2. 意图归一、计划构建、outbound 校验在一个阶段完成。
3. `buildPlan.ts` 已删除。

## 3.2 方案二：移除 `optimistic` 二次转换

结果：`commitWrite` 直接消费 `optimisticChanges`，不再 `toOptimisticChanges(plan)`。

当前状态：

1. optimistic apply 直接 `state.apply(plan.optimisticChanges)`。
2. `WritePlanEntry/optimistic` 结构已移除。
3. `commitWrite` 只关心 `entries + optimisticChanges`。

## 3.3 方案三：结果按 index 对齐，移除 `entryId -> result` map

结论：已完成。

必须新增硬契约（`atoma-types/runtime` 与 `atoma-types/protocol` 同步）：

1. 当返回 `results` 时，`results.length === request.entries.length`。
2. `results[i]` 对应 `request.entries[i]`。
3. `entryId` 保留为观测/调试字段，但不再作为主匹配键。

已落地要点：

1. 类型契约已改：`results` 与 `entries` 强制按 index 对齐。
2. 执行器/同步驱动已改为按 index 消费。
3. `commitWrite.resolveResult` 已移除 map 逻辑。

## 3.4 方案四：`apply/revert` 改为本地回放入口

结论：已执行完成。

目标语义：

1. `apply(changes)`：本地正向应用 `StoreChange[]`。
2. `revert(changes)`：本地逆向应用 `StoreChange[]`。
3. 不触发 `execution.write`，不依赖 route/signal。

理由：

1. 当前仓内唯一调用方是 history（undo/redo），其语义就是本地回放。  
   见：`packages/plugins/atoma-history/src/plugin.ts:56`
2. 远端回放已经有独立 `writeback` 链路，职责清晰。  
   见：`packages/plugins/atoma-sync/src/applier/writeback-applier.ts:44`

建议同步调整：

1. `runtime.write.apply/revert` 从 `WriteFlow` 移出，改为本地 replay 服务。
2. `StoreSession.apply/revert` 直接调用 replay 服务。
3. `StoreOperationOptions` 在 replay 入口仅保留 `context`（可新增 `ReplayOptions`）。

---

## 4. API 与命名重做（配套）

1. 保留 `apply/revert` 对外命名，不改成 `replay`。  
   原因：API 语义直观，调用方（history）无需认知方向枚举。
2. 内部实现也保持 `apply/revert` 词汇，方向只在局部变量中表达（例如 `direction`）。
3. 若执行方案三，`entryId` 降级为诊断字段，不再承担核心匹配语义。

---

## 5. 变更清单（按包）

## 5.1 atoma-types

1. `packages/atoma-types/src/runtime/persistence.ts`
   - 为 `WriteOutput.results` 增加顺序对齐契约说明。
2. `packages/atoma-types/src/protocol/operation.ts`
   - 为 `WriteResultData.results` 增加顺序对齐契约说明。
3. `packages/atoma-types/src/runtime/write.ts`
   - `apply/revert` 语义改为本地回放；必要时引入 `ReplayOptions`。
4. `packages/atoma-types/src/runtime/store/catalog.ts`
   - `StoreSession.apply/revert` 同步 replay 语义。

## 5.2 atoma-runtime

1. `packages/atoma-runtime/src/runtime/flows/write/adapters/intentToPlan.ts`
   - 已合并 `adapt + buildPlan`，统一编译入口。
2. `packages/atoma-runtime/src/runtime/flows/write/planner/buildPlan.ts`
   - 已删除。
3. `packages/atoma-runtime/src/runtime/flows/write/commit/commitWrite.ts`
   - 已直接消费 `optimisticChanges`；按 index 处理结果。
4. `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
   - 已删除 replay 远端提交流程，replay 走本地回放。
5. `packages/atoma-runtime/src/store/Stores.ts`
   - `apply/revert` 已为本地 replay 语义。

## 5.3 plugins / client / executor

1. `packages/plugins/atoma-backend-shared/src/buildOperationExecutor.ts`
   - 确保返回结果按输入顺序对齐。
2. `packages/plugins/atoma-sync/src/transport/operation-driver.ts`
   - 去 `entryId -> result` map，改为按 index 处理。
3. `packages/atoma-client/src/execution/registerLocalRoute.ts`
   - 保持顺序语义（当前已满足）。

---

## 6. 实施顺序（已完成）

1. 先改类型契约（runtime/protocol/write API）。
2. 再改执行器实现，保证顺序约束真实成立。
3. 再改 runtime `commitWrite` 与 compile 结构。
4. 最后改 `apply/revert` 为本地 replay，并清理 `WriteFlow` replay 分支。
5. 删除旧模型和冗余代码，不保留兼容分支。

---

## 7. 验收标准

1. Intent 写链路只保留：`compile -> commit` 两段。
2. `commitWrite` 中不存在 `entryId -> result` map。
3. `apply/revert` 不再调用 `execution.write`。
4. `history undo/redo` 行为不变；`sync` 回放继续走 `writeback`。
5. `pnpm --filter atoma-runtime run typecheck` 与相关插件 typecheck 全通过。
