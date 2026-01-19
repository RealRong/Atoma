以下文档整理 runtime 相关模块可 class 化的优化建议，仅做结构规划，不涉及代码实现。

# Runtime Class 化优化方案

## 目标
- 降低“到处函数调用 + 闭包共享状态”的复杂度
- 强化模块边界与职责可读性
- 让 runtime 由若干可复用组件组成，便于扩展与测试

## 现状问题概览
- `createClientRuntime` 内部堆叠多个闭包、临时函数与共享状态（cache、listeners、observability、outbox 等）
- controller 层（Sync/History/Replicator）大量 helper function 交织，难以一眼理解生命周期
- 函数与状态耦合方式不统一，阅读成本高

## 优先级建议
### 高收益（建议优先 class 化）
1) `src/client/internal/create/createClientRuntime.ts`
   - 典型“状态 + 行为”聚合体，适合拆成 runtime class + 子组件 class
   - 降低 runtimeRef 依赖与闭包链条
2) `src/client/internal/controllers/SyncController.ts`
   - 已具备 class 形态（状态、生命周期、私有 helper），class 化可显著提高清晰度
3) `src/client/internal/controllers/SyncReplicatorApplier.ts`
   - 内部状态与 helper 较多（opSeq、execute/query/write/persist）
   - class 化有助于封装执行细节，减少分散函数

### 中等收益（可选）
4) `src/client/internal/controllers/HistoryController.ts`
   - 体量不大，class 化主要提升一致性与后续扩展空间
5) `src/client/internal/create/buildClient.ts`
   - 可抽成 ClientBuilder class，但收益有限，可能增加抽象层级

### 低收益（暂不建议）
6) `src/client/internal/create/createStore.ts`
   - 逻辑短、一次性执行，class 化会增加噪音

## 建议拆分结构（高层设计）
### 1) ClientRuntime 本体 class
职责聚合，但将细分职责交给子组件处理：
- `StoreRegistry`
  - store 缓存
  - `Store(name)` / `SyncStore(name)`
  - `listStores` / `onStoreCreated`
- `ObservabilityRegistry`
  - `registerStoreObservability`
  - `createObservabilityContext`
  - runtime 级 observability cache
- `OutboxRuntimeManager`
  - `installOutboxRuntime`
  - `outbox` getter
- `InternalOps`
  - `getStoreSnapshot`
  - `applyWriteback`
  - `dispatchPatches`

### 2) Controller class
统一形式：构造函数注入 runtime + config，对外暴露稳定 API
- `SyncController`
  - start/stop/pull/push/status
  - engine 构建/缓存/销毁
  - devtools 状态管理
- `SyncReplicatorApplier`
  - executeOps/query/write/persist
  - apply pull/ack/reject
- `HistoryController`（可选）
  - history API + devtools

## 影响范围（文档级别评估）
- 主要集中在 `src/client/internal/create/*` 与 `src/client/internal/controllers/*`
- 对外 API 不变，改变内部结构与文件组织
- 类型层需要与 class 实例化方式匹配（runtime internal 类型更新）

## 分阶段实施建议（不写代码）
1) 先把 `createClientRuntime` 收敛为 runtime class + 子组件 class
2) class 化 `SyncController`
3) class 化 `SyncReplicatorApplier`
4) 视需要统一 `HistoryController` 与 `buildClient` 风格

## 非目标
- 不引入兼容层
- 不改变对外 API 语义
- 不改动 store 或 core 的既有调用链
