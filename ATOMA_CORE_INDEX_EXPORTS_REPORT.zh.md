# atoma-core index.ts 导出评估报告

日期：2026-01-30

## 结论摘要
- 当前 `packages/atoma-core/src/index.ts` 暴露范围明显偏大：除面向应用的类型与 `Core` 门面外，还导出了一批**运行时内部实现**（store internals、mutation pipeline、store ops 工厂等）。
- 这些“内部实现”主要**只被内部包使用**（尤其 `atoma-client`），但由于 `packages/atoma/src/core/index.ts` 直接 `export * from 'atoma-core'`，它们会**透出到最终 public API**。
- 少数导出**在仓库内没有任何外部使用**（仅 atoma-core 自身使用），属于潜在“过度导出”。

## 研究范围与方法
- 目标文件：`packages/atoma-core/src/index.ts`。
- 使用 `rg` 与脚本扫描 `import { … } from 'atoma-core'` 的直接使用点，并补充搜索 `Core` 对象的使用。
- 说明：通过 `Core.xxx` 间接使用的符号（如 `Core.query.executeLocalQuery`）不在“具名导入”统计中，已在下文单独列出。

## index.ts 当前导出构成（概要）
- `Core` 门面：`operation/query/relations/search` 子模块聚合。
- 具名导出（值）：
  - operation/query：`createActionId`、`createOpContext`、`normalizeOperationContext`、`executeLocalQuery`。
  - runtime/store internals：`createRuntimeIo`、`DataProcessor`、`createStoreHandle`、`StoreStateWriter`、`StoreWriteUtils`、`executeWriteOps`。
  - store ops 工厂：`createAddOne` / `createAddMany` / … / `createQueryOne`。
  - mutation：`MutationPipeline`。
- 具名导出（类型）：`Entity`、`StoreApi`、`Query`、`RelationIncludeInput`、`WithRelations`、`Runtime*` 等大量类型。

## 被哪些地方使用（按包汇总）
以下为“直接 import from 'atoma-core'”的统计结果（不含 `Core.xxx` 的间接调用）：

- `packages/atoma-react`：`Core`（值）+ 业务类型（`Entity`、`Query`、`RelationIncludeInput`、`WithRelations`、`PageInfo`、`FetchPolicy`、`FuzzySearchOptions/Result`、`StoreApi`、`StoreToken`、`IStore`）。
- `packages/atoma-history`：`Core`（值）+ `OperationContext` 类型。
- `packages/atoma-client`：大量类型 + 多个内部实现（`DataProcessor`、`MutationPipeline`、`createRuntimeIo`、`createActionId`、`createStoreHandle`、`StoreStateWriter`、`StoreWriteUtils`、`executeWriteOps`、所有 `create*` store ops）。
- `packages/atoma-backend-memory` / `packages/atoma-backend-indexeddb`：`executeLocalQuery`。
- `packages/atoma-sync`：`Entity`、`PersistRequest`、`PersistResult` 类型。
- `packages/atoma`：`Entity`、`StoreApi`、`StoreToken`（其 `src/core/index.ts` 进一步 `export *` 透出所有 atoma-core 导出）。

`Core` 门面对象的间接使用（`Core.query/relations/search/operation`）主要集中在：
- `packages/atoma-react/src/hooks/*`（本地查询、关系解析、模糊搜索）。
- `packages/atoma-history/src/HistoryManager.ts`（`Core.operation.createActionId`）。
- `packages/atoma-client/src/internal/runtime/StoreConfigResolver.ts`（关系构建）。

## 疑似“过度导出”的项目（建议收拢）
**A. 仅被内部包使用的实现（建议转为 internal 入口）**
- `DataProcessor`、`MutationPipeline`、`createRuntimeIo`：仅 `atoma-client` 使用。
- `createStoreHandle`、`StoreHandle`、`StoreStateWriter`、`StoreWriteUtils`：仅 `atoma-client` 使用（均为 store internals）。
- `createAddOne`…`createQueryOne`（store ops 工厂）：仅 `atoma-client` 使用。
- `executeWriteOps`：仅 `atoma-client` 使用（作为 http/persist 适配）。
- `executeLocalQuery`：被内部 runtime + 后端适配器使用（不一定需要暴露给最终用户 API）。

**B. 仓库内无外部使用的导出（建议移除或降级为 internal）**
- `createOpContext`、`normalizeOperationContext`：仅在 atoma-core 内部出现。
- `StoreCommit`、`StoreIndexes`、`QueryMatcherOptions`：未发现外部包使用（`StoreIndexes` 仅在文档/注释中出现）。

> 以上条目若仍要对外保留，建议明确其“内部 API”属性，以避免稳定性承诺。

## 是否需要“封装”与建议方案
**判断：需要。** 当前 `atoma-core` 的单一入口 (`src/index.ts`) 导出过多实现细节，且被 `packages/atoma/src/core/index.ts` 透出，等同于向最终用户公开内部实现。

**建议方向（不修改代码，仅建议）：**
1. **拆分公共/内部入口**
   - 保留 `src/index.ts` 作为**公共 API**（类型 + `Core` 门面 + 少量高层接口）。
   - 新增 `src/internal.ts` 或 `src/runtime/index.ts` 作为**内部 API**（DataProcessor、MutationPipeline、StoreWriteUtils、createStoreHandle、store ops 工厂等）。
   - 在 `packages/atoma-core/package.json` 的 `exports` 中新增 `"./internal"` 或 `"./runtime"`。
   - `atoma-client`、后端包改为从 internal 入口导入。

2. **约束 `packages/atoma/src/core/index.ts` 的透出范围**
   - 由 `export *` 改为**显式白名单导出**，避免内部实现泄漏到最终 public API。

3. **类型层面标注内部 API（可选）**
   - 对暂时无法拆分的导出加 `/** @internal */`，配合 `stripInternal` 控制对外 d.ts 输出。

## 可执行的后续清单（若要推进封装）
- 明确“公共 API”清单（供应用开发者 + atoma-react 使用）与“内部 API”清单（供 atoma-client/后端包使用）。
- 设计 `internal` 入口并迁移导入路径。
- 更新 `atoma` 包的 re-export 策略，避免暴露内部实现。

## 关键文件参考
- `packages/atoma-core/src/index.ts`
- `packages/atoma-core/package.json`
- `packages/atoma/src/core/index.ts`
- `packages/atoma-client/src/internal/runtime/ClientRuntime.ts`
- `packages/atoma-client/src/internal/runtime/ClientRuntimeStores.ts`
- `packages/atoma-client/src/internal/runtime/StoreWriteCoordinator.ts`
- `packages/atoma-react/src/hooks/useLocalQuery.ts`
- `packages/atoma-react/src/hooks/useRelations.ts`
- `packages/atoma-react/src/hooks/useFuzzySearch.ts`
- `packages/atoma-history/src/HistoryManager.ts`
