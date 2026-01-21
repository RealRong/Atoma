# 彻底移除 core 的 Outbox：用 `CoreRuntime.persistence.persist` 拆分持久化职责

目标：把 **Outbox/SyncStore/outbox persistMode** 这些“同步领域概念”从 `atoma/core` 彻底移除；core 只负责：
- 本地状态与 mutation 计划/执行（plan/patch/ops 生成）
- 提供一个“持久化回调接口”把 side-effects 交给上层（client/sync/backend）

本方案是 **破坏式变更**（不做兼容层），以最优架构为目标。

---

## 1. 现状问题（为什么要拆）

当前 core 内存在“Outbox 作为持久化策略”的概念，主要体现在：
- `src/core/mutation/pipeline/Persist.ts`：决定 direct vs outbox，并在 outbox 模式下调用 `runtime.outbox.enqueueOps(...)`
- `src/core/types.ts`：`CoreRuntime` 暴露 `outbox?: OutboxWriter`，以及 `OutboxWriter/OutboxQueueMode` 类型
- `src/core/store/createSyncStoreView.ts`：`Store(...).Outbox` 视图写入时强制 `persistMode: 'outbox'`

这造成：
- core 被迫理解 “outbox / local-first / enqueueOps” 这些 **同步域** 语义
- client/sync 侧很难独立演进（core 改动会牵连 sync）
- “持久化策略”不够开放：未来新增策略（事务日志、批处理、延迟提交、离线多队列）会继续污染 core

---

## 2. 目标架构（拆分后的职责边界）

### 2.1 `atoma/core` 负责
- 生成 mutation 计划与对应 write ops（协议层 ops）
- 在本地应用 optimistic changes（patches/writeback）
- 将“如何持久化这些 ops”的决定下放给外部：**core 只调用 `CoreRuntime.persistence.persist`**

### 2.2 `atoma/client` / `atoma-sync` 负责
- 提供具体持久化策略实现：
  - direct：走 backend/opsClient
  - outbox：enqueue 到 `atoma-sync` 的 outbox store
  - local-first：先 direct 持久化到 local backend，再 enqueue
- 提供 `Store(...).Outbox` / `SyncStore` 这类“同步写入视图”（这属于 client 层的产品形态，不属于 core）

---

## 3. 设计：core 暴露 `CoreRuntime.persistence.persist` 接口（方案 B，最终方案）

核心原则：**core 不再出现 Outbox、SyncStore、persistMode: 'outbox' 等命名/类型。**

### 3.1 最小接口（推荐）

结论：选择 **方案 B**，在 core 中引入 `CoreRuntime.persistence.persist`（更利于扩展、测试注入与未来增加更多 persistence 能力）。

接口草案（语义重点，不是最终实现代码）：

```ts
export type PersistRequest<T> = {
  storeName: string
  ops: Operation[]
  // 可选：observability/trace 信息
  context?: ObservabilityContext

  // 可选：用于实现 local-first 或更高级策略的 hooks
  // - applyDirect?: (ops) => Promise<DirectPersistResult<T>>
  // - now?: () => number
}

export type PersistResult<T> =
  | { status: 'confirmed'; created?: T[]; writeback?: StoreWritebackArgs<T> }
  | { status: 'enqueued'; created?: T[]; writeback?: StoreWritebackArgs<T> }

export interface Persistence {
  persist<T>(req: PersistRequest<T>): Promise<PersistResult<T>>
}
```

关键点：
- `CoreRuntime.persistence.persist` 只接收 **ops**，不感知 outbox / queueMode
- 是否立即写远端、是否入队、是否先本地 durable，都由外部策略决定
- 返回 `PersistResult` 让 core 统一处理后续流程（例如确认态/回写）

### 3.2 core 不提供默认实现（必须外部注入）

结论：**core 不提供任何默认的 persistence 实现**，`CoreRuntime.persistence.persist` 必须由外部注入（例如 `atoma/client` 的 wiring 层）。

原因：
- 彻底保证 core 不耦合任何 backend/sync 语义（哪怕是 “direct” 也会引入默认依赖与默认行为）
- 避免 “没装 sync 但仍然隐式走网络/后端” 这类隐性副作用
- 更利于测试：不同测试场景可注入不同的 `Persistence`（成功/失败/入队/延迟确认）

因此：
- `atoma/client`（或上层应用）必须在创建 runtime 时提供 `persistence: Persistence`
- “direct / enqueue / local-first” 都是外部策略实现（可在 `atoma/client` 内组合实现）

---

## 4. pipeline 如何改（拆掉 Persist.ts 的策略判断）

### 4.1 删除“persistMode”的全链路传递

要彻底清掉 core 的 Outbox 概念，必须移除：
- `persistMode: 'direct' | 'outbox'` 类型与字段
- `StoreDispatchEvent.persist` / `writeConfig.persistMode` 等
- `derivePersistModeFromOperations` / “禁止混合 persistMode” 逻辑

原因：persistMode 是“策略选择”，应该由 store view/上层注入的 persistor 决定，而不是在 core 内部拼装选择。

### 4.2 新的执行顺序（建议）

core mutation flow 可以简化为：
1) build local plan（计算 patches/inversePatches、生成 write ops）
2) apply optimistic state（本地立即可见）
3) 调用 `runtime.persistence.persist({ ops, storeName, context })`
4) 根据 `PersistResult`：
   - `confirmed`：应用 writeback/version updates（如果有）
   - `enqueued`：不做远端确认回写（或只做 local-first 已确认部分的回写）

这样 core 完全不需要理解“队列/重试/ack/reject/rebase”等同步概念。

---

## 5. `Store(...).Outbox` / `SyncStore` 放哪里

结论：**不应在 core**。

原因：
- `SyncStore` 只是一个“把写入策略换成 enqueue/local-first”的 store view 产品形态
- 它依赖 client wiring（sync 配置、outbox store、锁、cursor、diagnostics）

建议归属：
- `atoma/client`（或 `src/client/**`）负责暴露 `Store(...).Outbox`
- `atoma-sync` 负责提供 outbox/cursor/lock 的存储实现（`createStores` / `DefaultOutboxStore`）

---

## 6. 迁移落地：需要改哪些文件（高层清单）

下面是“彻底移除 core Outbox 概念”必经改动点（不含细节实现）：

### 6.1 core：删除 Outbox 类型与 runtime 字段，新增 `CoreRuntime.persistence`
- `src/core/types.ts`
  - 删除：`OutboxWriter`、`OutboxQueueMode`
  - 删除：`CoreRuntime.outbox?: OutboxWriter`
  - 新增：`Persistence` / `PersistRequest` / `PersistResult` 等相关类型，并在 `CoreRuntime` 上新增 `persistence: Persistence`

### 6.2 core：删除 Persist.ts 的策略分支，改为调用 `runtime.persistence.persist`
- `src/core/mutation/pipeline/Persist.ts`
  - 删除 outbox 分支与 `enqueueOps` 调用
  - 改为：`runtime.persistence.persist(...)`
  - 保留/复用 `executeWriteOps` 作为 direct persistor 的实现基础（可移到 core 内单独模块）

### 6.3 core：移除 persistMode 的传播
受影响范围很大（典型包括）：
- `src/core/store/internals/storeWriteEngine.ts`（`StoreWriteConfig.persistMode`）
- `src/core/store/createStoreView.ts`（writeConfig）
- `src/core/store/createSyncStoreView.ts`（整体应移出 core 或删除）
- `src/core/mutation/pipeline/*`（`MutationProgram/WriteIntents/LocalPlan` 等传递 persistMode 的地方）
- 各 store ops（`src/core/store/ops/*.ts`）构造 dispatch event 时携带的 `persist` 字段

### 6.4 client：用 persistor 组合实现 Outbox/SyncStore
- 把 `createSyncStoreView` 移到 `src/client/...`（或重写为 client 内部工具）
- client runtime 在创建 StoreView 时选择使用：
  - direct persistor（默认）
  - outbox persistor（enqueue 到 `atoma-sync` stores.outbox）
  - local-first persistor（direct + enqueue）

### 6.5 atoma-sync：保留 outbox store 实现，但不要求 core 感知
- `packages/atoma-sync/src/store.ts` 继续存在（OutboxStore/CursorStore）
- outbox 的 queueMode、inFlight/rebase/ack/reject 仍完全属于 sync 领域

---

## 7. 注意事项（避免拆分后再次耦合）

- core 不要出现任何 sync 词汇：`Outbox/SyncStore/queue/local-first` 都不应该在 core 目录里出现
- persistor 的返回值要足够表达“确认/入队”这两类现实结果，但不要泄漏“队列细节”
- 如果需要“坏 op 防御/validate”，放在策略侧（例如 outbox enqueue 时校验），不要放回 core

---

## 8. 推荐的分阶段实施（破坏式一次到位的最小路径）

1) 先把 `persistMode/outbox` 从 core pipeline 中抹掉：只留下 `runtime.persistence.persist(ops)`
2) 把 `SyncStore` 从 core 移到 client（或删除后在 client 重建）
3) 在 client 实现两种 persistor：
   - directPersistor（复用 core 的 executeWriteOps）
   - enqueuePersistor（调用 atoma-sync outbox.enqueueOps）
   - localFirstPersistor（direct + enqueue）
4) 在 client wiring 层决定“哪个 store view 用哪个 persistor”

完成后：core 变得更小、更纯；sync/outbox 完全归 sync 领域包管理。
