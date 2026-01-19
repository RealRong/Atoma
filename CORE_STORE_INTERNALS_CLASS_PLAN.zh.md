以下文档整理 `src/core/store/internals` 的 class 化与职责整合建议，仅做结构规划，不涉及代码实现。

# Core Store Internals Class 化与职责整合方案

## 目标
- 收敛碎片化函数，形成可读性更强的组件边界
- 统一 handle/runtime 访问与错误路径
- 把“写入全链路”与“查询配置处理”收敛为少量可复用组件

## 现状问题
- handle 创建/注册/访问分散在 `runtime.ts`、`handleRegistry.ts`、`storeAccess.ts`
- 写入链路拆分在 `writePipeline.ts`、`writeback.ts`、`atomMap.ts`、`preserveReference.ts`、`hooks.ts`
- 查询参数处理与 matcher 构建分离在 `queryParams.ts` 与 `runtime.ts`

## 组件化建议

### 1) StoreHandleManager（统一 handle/runtime 访问）
**建议整合文件**
- `runtime.ts`（createStoreHandle / resolveObservabilityContext / buildQueryMatcherOptions）
- `handleRegistry.ts`（注册/附加/获取 handle 与 runtime）
- `storeAccess.ts`（get/require/subscribe/hydrate 等访问方法）

**核心职责**
- create/attach/get/require store handle
- register/get store runtime
- getSnapshot / subscribe / getIndexes / getMatcher / getRelations / getName
- hydrateStore（含 dataProcessor.writeback 的统一入口）
- resolveObservabilityContext

**目标效果**
- 消除重复的 handle 解析与错误提示路径
- 调用方只依赖单一组件接口，不再散落多个 util

**设计方案（细化）**
- 组件形态
  - `StoreHandleManager` 作为内部 class，统一提供 handle/runtime 的创建、注册、访问与派生能力
  - 以 `ClientRuntime` 或 store 创建流程为注入入口（避免全局隐式依赖）
- 统一入口方法（示意）
  - `createHandle(config): StoreHandle`
  - `attachHandle(store, handle): void`
  - `attachRuntime(store, runtime): void`
  - `getHandle(store): StoreHandle | null`
  - `requireHandle(store, tag): StoreHandle`
  - `getRuntime(store): CoreRuntime | null`
  - `getSnapshot(store, tag?): ReadonlyMap`
  - `subscribe(store, listener, tag?): () => void`
  - `getIndexes/getMatcher/getRelations/getName`
  - `hydrateStore(store, items, tag?)`
  - `resolveObservabilityContext(runtime, handle, options?)`
- 数据与错误策略
  - 所有“handle 缺失”错误由该组件统一生成与抛出
  - 统一 fallback：无 handle 时返回空 map / no-op subscribe / null matcher
- 与现有结构的关系
  - `StoreHandleManager` 内部复用 `handleRegistry` 的 WeakMap 机制
  - `storeAccess` 的所有函数改为该组件的方法或薄薄的导出代理（建议直接改为 class 实例调用）

**整合范围（建议合并/改造文件）**
- `src/core/store/internals/runtime.ts`
  - 保留 `buildQueryMatcherOptions` 可迁入 `StoreQueryPlanner`
  - `createStoreHandle` 与 `resolveObservabilityContext` 迁入 `StoreHandleManager`
- `src/core/store/internals/handleRegistry.ts`
  - 作为 `StoreHandleManager` 内部实现细节（不再被外部直接依赖）
- `src/core/store/internals/storeAccess.ts`
  - 全部功能迁入 `StoreHandleManager`（或保留薄代理）

**需要修改的文件（清单）**
- `src/core/store/internals/runtime.ts`：迁移 create/resolve 相关逻辑，避免重复
- `src/core/store/internals/handleRegistry.ts`：封装为组件内部实现
- `src/core/store/internals/storeAccess.ts`：改为 class 方法或代理
- 所有调用方：改为 `storeHandleManager.xxx()` 的统一入口

### 2) StoreWriteEngine（写入全链路）
**建议整合文件**
- `writePipeline.ts`（prepareForAdd/prepareForUpdate/ensureActionId/ignoreTicketRejections）
- `writeback.ts`（applyStoreWriteback）
- `atomMap.ts`（map diff + commit）
- `preserveReference.ts`（浅层引用复用）
- `hooks.ts`（before/after save）
- `dispatch.ts`（可并入，作为内部方法）

**核心职责**
- 写入准备：id 生成、merge、hooks、dataProcessor.inbound
- 写入落地：dataProcessor.writeback、map diff、index 更新
- 内部封装：map 差异计算、preserveReference、commit atom
- 统一处理 actionId 与票据容错

**目标效果**
- 让“写入”成为一个完整、内聚的组件
- 写入流程更可读、更容易扩展

### 3) StoreQueryPlanner（查询配置与 matcher）
**建议整合文件**
- `queryParams.ts`（normalizeAtomaServerQueryParams）
- `runtime.ts`（buildQueryMatcherOptions）

**核心职责**
- 规范化服务端查询参数
- 统一 matcher 配置构建

**目标效果**
- 查询相关处理收敛为单一入口
- 降低 query 与 runtime 的职责交叉

## 保留为函数的部分（建议）
- `idGenerator.ts`：无状态、小工具，可保留为 function，或内嵌到 StoreWriteEngine
- `dataProcessor.ts`：已是 class，作为写入引擎依赖即可

## 影响范围评估（不写代码）
- 主要影响 `src/core/store/internals/*`
- 对外 API 语义保持不变，内部组织结构调整
- 调用侧可改为依赖 `StoreHandleManager/StoreWriteEngine/StoreQueryPlanner` 三个组件

## 落地步骤（不写代码）
1) 先合并 handle/runtime 访问链路为 StoreHandleManager
2) 再收敛写入链路为 StoreWriteEngine
3) 最后整合 Query 处理为 StoreQueryPlanner
