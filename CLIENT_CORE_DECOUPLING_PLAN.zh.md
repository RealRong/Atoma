# Client/Core 耦合优化实现文档（三点落地）

本文整理并落地三项建议，目标是在保持现有架构优点（单一上下文、调用链清晰）的前提下，进一步降低隐式耦合、强化边界、提升多实例安全性与可维护性。

---

## 1) StoreHandle 进一步私有化（对外只暴露 Store/StoreView）

### 目标
- 防止上层拿到 handle 后直接访问 `atom/jotaiStore/indexes` 等低层能力，避免绕过 runtime。
- 强化“store 级 API”与“运行时能力”的边界。

### 现状
- `StoreHandle` 在 core 类型中对外可见，React hooks/注册表等可以间接拿到 handle。

### 方案
- 将 `StoreHandle` 限制为 core 内部类型：
  - `src/core/types.ts` 中把 `StoreHandle` 改为内部导出（或仅在 `src/core/*` 内部使用）。
  - 对外 API（`src/index.ts`/`src/core/index.ts`）不再导出 `StoreHandle`。
- 增加 core 内部“只读/受控适配器”，供 React hooks/工具使用：
  - `Core.store.getSnapshot(store)`：返回当前 Map 快照（内部读取 atom）
  - `Core.store.subscribe(store, listener)`：订阅变更（内部使用 jotaiStore.sub）
  - `Core.store.getIndexes(store)` / `Core.store.getMatcher(store)` / `Core.store.getRelations(store)`
  - `Core.store.getStoreName(store)` / `Core.store.getRuntime(store)`
  - `Core.store.hydrate(store, items)`：写入远端结果并更新 indexes
- 暴露更窄的只读/调试接口（如需要）：
  - 为 devtools/诊断提供 `StoreDebugView`（只读能力，禁止写入）。

### 影响范围
- `src/core/types.ts`
- `src/core/index.ts`
- `src/react/hooks/*`（如依赖 `StoreApi`/内部 handle 的地方需改为基于 store API）
- `src/devtools/*`（如直接依赖 handle）

### 验收标准
- 业务层无法直接访问 `StoreHandle` 的字段。
- 所有 store 操作必须走公开 API / runtime 入口。

### React hooks 拆法（补充方案）
目标：hooks 不再直接拿 handle，仅依赖 store API + core 适配器。

- 统一入参类型：
  - 统一使用 `StoreApi`（兼容 Outbox view）。
- 读取/订阅改为适配器：
  - `useAll/useOne/useMany/useStoreQuery`：用 `Core.store.getSnapshot/subscribe` 替代 `getHandle` + `useAtomValue`。
  - `useLocalQuery`：通过 `Core.store.getMatcher(store)` 获取 matcher（无 store 则走纯 query）。
  - `useFindMany`：本地查询走 `getSnapshot + getIndexes/getMatcher`。
- 远端回填改为受控写入：
  - `useRemoteFindMany`：改用 `Core.store.hydrate(store, items)`，不再直接写 atom。
- 关系解析改为 store API：
  - `useRelations`：通过 `getSnapshot`/`subscribe` 获取 map 与 live 更新，`getRuntime` 取 `resolveStore`。

可选优化：将 hooks 内部订阅机制升级为 `useSyncExternalStore`，彻底隔离 jotai 细节。

---

## 2) 弱化/移除全局 registry（Symbol.for + globalThis）

### 目标
- 减少隐式全局耦合，提升多 runtime/多实例安全性。
- 避免跨 bundle 或多加载环境产生意外共享。

### 现状
- `handleRegistry` 使用 `Symbol.for` + `globalThis` 维护全局 WeakMap。

### 方案
- 方案 A（推荐）：将 registry 迁移为 runtime 私有缓存
  - 由 `ClientRuntime` 持有 `store -> handle` 映射，`createStoreView` 明确注入。
- 方案 B（折中）：保留 registry，但改为“可选且 scoped”
  - 仅用于 devtools 或诊断时启用，默认不挂 global。

### 影响范围
- `src/core/store/internals/handleRegistry.ts`
- `src/core/store/createStoreView.ts`
- `src/client/internal/create/createClientRuntime.ts`

### 验收标准
- 默认路径下不依赖全局 registry。
- 多 runtime 实例互不污染。

---

## 3) ClientRuntime 接口收敛为最小能力集（能力可选化）

### 目标
- 保持 core 只依赖最小 runtime 能力，减少“设计性耦合”的体积。
- 便于做多种 runtime 实现（如轻量 mock、测试 runtime）。

### 现状
- `ClientRuntime` 同时承载 ops/mutation/outbox/observability/resolveStore 等多职责。

### 方案
- 将 `ClientRuntime` 分层/切分：
  - `CoreRuntime`: 必需能力（`opsClient`、`mutation`、`createObservabilityContext`、`jotaiStore`）
  - `ClientRuntime`: 在 `CoreRuntime` 上追加 `Store/SyncStore/listStores/devtools` 等 client 专属能力
- core 仅依赖 `CoreRuntime`（类型上收紧）。

### 影响范围
- `src/core/types.ts`（拆分类型）
- `src/client/types/runtime.ts`（扩展类型）
- `src/client/internal/*`（runtime 组装）

### 验收标准
- core 侧函数签名不依赖 client 专属能力。
- `ClientRuntime` 仍可保持对外不变，内部实现分层。

---

## 总结
- 这三点并不改变当前架构的核心优势，只是**进一步收紧边界**与**减少隐式耦合**。
- 优先级建议：
  1) StoreHandle 私有化（收益最大、风险可控）
  2) registry 去全局化（提升多实例安全性）
  3) runtime 分层（长期演进与测试友好）
