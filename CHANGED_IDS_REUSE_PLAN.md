# changedIds 复用优化方案（全仓）

## 目标

- 在不改变现有行为的前提下，减少 `changedIds` 相关重复逻辑
- 保持职责分离：`core` 负责通用数据变更语义，`runtime` 负责流程编排，`react` 保留 UI 语义
- 避免“万能工具函数”导致语义混杂
- 采用一步到位的目标架构（无需兼容层）

## 扫描结论（按包）

### atoma-core

- `packages/atoma-core/src/store/writeback.ts`
  - 已包含成熟的变更收集逻辑：`before/after/changedIds` 生成与净化
- `packages/atoma-core/src/indexes/Indexes.ts`
  - `applyPatches` 内有 patch 根路径提取逻辑
  - `applyChangedIds` 是索引增量更新入口

### atoma-runtime

- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
  - 存在 `collectChangedIdsForItems` 与多处局部 `Set<EntityId>` 拼装
- `packages/atoma-runtime/src/store/StoreFactory.ts`
  - `hydrate` 中存在与 `ReadFlow` 相似的 `preserve + changedIds + commit`
- `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts`
  - optimistic 分支也有 `changedIds`，但语义属于写流程策略，不应与读缓存共用
- `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
  - patch 根 id 提取与 `core/indexes` 相似，可考虑抽离

### atoma-react

- `packages/atoma-react/src/hooks/internal/relationInclude.ts`
  - `collectCurrentAndNewIds` 是关系预取增量语义，不是 store commit 语义
  - 不建议与 `changedIds` 抽象合并

### atoma-client / atoma-types / atoma-shared

- `atoma-client` 基本不承载 `changedIds` 计算
- `atoma-types` 主要是类型承载（`StoreChangedIds`）
- `atoma-shared` 暂无明确同语义函数，不建议硬塞跨域工具

## 抽离边界（建议）

## 1) 抽离：Store 变更收集（高优先级）

在 `atoma-core/store` 增加一个轻量域函数（命名示例：`collectChangedIdsFromItems` / `applyUpsertsWithChangedIds`），统一语义：

- 输入：`before`、`items`、`preserve`
- 输出：`after`（可选）、`changedIds`
- 约束：只处理“按 id upsert 到 map”的通用场景

优先替换位置：

- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
- `packages/atoma-runtime/src/store/StoreFactory.ts`（`hydrate`）

收益：

- 去掉 runtime 内重复循环与差分判断
- 保证 `preserveRef` 判等策略一致
- 降低未来行为漂移风险

## 2) 抽离：Patch 根 ID 提取（中优先级）

新增一个小函数（命名示例：`collectRootIdsFromPatches`），统一 `patch.path[0]` 解析。

复用位置：

- `packages/atoma-core/src/indexes/Indexes.ts`
- `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`

收益：

- 避免路径解析细节在两处漂移
- 让 patch->id 的语义单点维护

## 3) 不抽离：Optimistic changedIds（明确保留局部）

`packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts` 的 `changedIds` 与写策略强绑定（乐观更新/回滚），建议继续内联在写提交流程。

## 4) 不抽离：React 关系 newIds（明确保留局部）

`packages/atoma-react/src/hooks/internal/relationInclude.ts` 的 `newIds` 是关系预取触发条件，不应与 store `changedIds` 抽象合并。

## 落地顺序（建议）

1. 先抽 `core/store` 的 upsert+changedIds 通用函数
2. 替换 `ReadFlow` 的 `collectChangedIdsForItems` 与 `applyQueryWriteback` 内重复逻辑
3. 替换 `StoreFactory.hydrate` 的同类逻辑
4. 再抽 patch 根 id 收集函数，并替换 `Indexes` + `WriteFlow`
5. 最后做一次 `typecheck + tests` 验证行为不变

## 验收标准

- `atoma-runtime` 类型检查通过
- `atoma-core` 类型检查通过
- `ReadFlow`、`hydrate`、`Indexes`、`WriteFlow` 中重复 `changedIds` 采集逻辑显著减少
- optimistic 流程与 react relation 逻辑保持独立，不发生语义混淆

## 命名建议

- 函数命名短且语义清晰：
  - `collectChangedIdsFromItems`
  - `applyUpsertsWithChangedIds`
  - `collectRootIdsFromPatches`
- 避免泛化过度命名（如 `computeDiff` / `syncState` 这类语义不明确名称）

