# StoreHandle 替代现状说明

本文汇总：目前哪些 Store API/内部适配器已替代 StoreHandle、使用位置、以及是否仍需对外导出 StoreHandle 的结论与建议。

---

## 1) 目前用来替代 StoreHandle 的 API

已新增并使用的“受控访问”适配器（内部实现仍用 StoreHandle，但对外不暴露）：

- `getStoreSnapshot(store)`：读取当前 Map 快照
- `subscribeStore(store, listener)`：订阅变更（内部用 jotaiStore.sub）
- `getStoreIndexes(store)`：读取索引管理器
- `getStoreMatcher(store)`：读取 matcher 配置
- `getStoreRelations(store)`：读取关系工厂结果
- `getStoreRuntime(store)`：读取 runtime（resolveStore 等）
- `getStoreName(store)`：读取 storeName
- `hydrateStore(store, items)`：远端数据回填并更新 indexes

这些能力都集中在：
- `src/core/store/internals/storeAccess.ts`

React 层通过 `useStoreSnapshot/useStoreSelector` 订阅与选择，仍然锚定 Jotai atom：\n+内部实现依赖 `jotaiStore.sub` 与 `atom` 的快照读取，只是把这些细节封装在 storeAccess 中，避免直接暴露 StoreHandle。

---

## 2) 目前替代 API 的使用位置

### React hooks（已替代）
已从 hooks 中移除 `Core.store.getHandle` 直接依赖：
- `src/react/hooks/useAll.ts`
- `src/react/hooks/useValue.ts`
- `src/react/hooks/useMultiple.ts`
- `src/react/hooks/useStoreQuery.ts`
- `src/react/hooks/useFindMany.ts`
- `src/react/hooks/useRemoteFindMany.ts`
- `src/react/hooks/useLocalQuery.ts`
- `src/react/hooks/useRelations.ts`
- `src/react/hooks/internal/useStoreSelector.ts`

### devtools（已替代）
- `src/devtools/runtimeAdapter.ts`：用 `onStoreCreated + storeAccess` 获取快照/索引

### client 内部（部分替代）
- `src/client/internal/create/createClientRuntime.ts`：内部仍缓存 handle，但对外事件已改为 `onStoreCreated`
- `src/client/internal/create/createStore.ts`：通过 storeAccess 获取 handle
- `src/client/internal/controllers/SyncReplicatorApplier.ts`：通过 storeAccess 获取 handle
- `src/client/internal/controllers/HistoryController.ts`：通过 storeAccess 获取 handle

---

## 3) 目前仍使用 StoreHandle 的区域

StoreHandle 仍存在于 core 内部（主要是核心执行链路）：
- `src/core/types.ts`（类型定义、StoreDispatchEvent.handle）
- `src/core/storeHandleRegistry.ts`
- `src/core/ops/opsExecutor.ts`
- `src/core/mutation/pipeline/*`
- `src/core/store/create*View.ts`
- `src/core/store/ops/*`
- `src/core/store/internals/*`

这些属于 core 内部实现细节，暂时保留是合理的。

---

## 4) 是否还需要对外导出 StoreHandle？

**结论：不需要对外导出。**

理由：
- 对外暴露会破坏抽象边界（可直接触达 atom/jotaiStore/indexes）。
- hooks 与 devtools 已完成替代，不再需要 handle。
- client 与 core 内部仍可通过 storeAccess 或内部类型直接使用。

建议：
- 保持 `StoreHandle` 为 core 内部类型，不再从 `src/core/index.ts` 或 `src/index.ts` 对外导出（已完成）。
- 如果需要调试能力，新增只读 `StoreDebugView` 或 `DevtoolsSnapshot` 类型即可。

---

## 5) StoreHandle 还有必要吗？

**结论：内部仍有必要，对外没有必要。**

原因：
- StoreHandle 聚合了 atom/jotaiStore/indexes/hook/schema/transform 等内部运行态资源，便于 core pipeline 传递与优化。
- 多处核心执行路径（mutation/ops/store view）依赖它作为“store 运行时载体”。
- 只要保持内部使用、外部不暴露，就能兼顾性能与封装边界。

---

## 6) 后续收尾建议（可选）

- 将 `StoreHandle` 标注为 internal-only（仅在 core 内部导入）。
- `StoreDispatchEvent` 等类型可拆出 internal 类型，避免被外部引用。
- 如需对外调试能力，可提供 `StoreDebugView`，仅包含只读字段。
