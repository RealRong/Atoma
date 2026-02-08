# atoma-types / atoma-protocol 一步到位整合方案（2026-02-08）

## 1. 决策前提（明确）

- 当前项目**没有外部用户和兼容负担**。
- 本方案目标是：**一次性落到最优架构**，而不是渐进迁移。
- 因此前述“兼容壳包 / deprecate 过渡期 / 双入口并存”全部**不采用**。

---

## 2. 最终结论

### Q1：现在还需不需要 `atoma-protocol`？
- **不需要**保留为独立包。
- 它的价值（协议运行时工具）应直接并入 `atoma-types`。

### Q2：能否整合到 `atoma-types`？
- **能，而且应立即整合**。
- `atoma-types` 同时承载：
  - `protocol`：协议类型（type-only）
  - `protocol-tools`：协议运行时工具（原 `atoma-protocol` 的函数能力）

### Q3：还需要统一 `Protocol` 对象吗？
- **不需要**。
- 最优架构应避免 `Protocol.xxx.yyy` 这种“God Namespace”门面，改为**命名导入**：
  - `import { buildQueryOp, assertOperationResults } from 'atoma-types/protocol-tools'`

### Q4：`atoma-types` 里 protocol 能否拍平？
- **能，且建议同步完成**。
- 在无兼容约束前提下，直接整理为扁平文件结构，降低维护成本。

### Q5：core 为什么还 re-export/依赖 protocol？`import * as Types from core` 是否规范？
- `core -> protocol` 反向依赖属于分层不清，应一次性消除。
- `import type * as Types from '../core'` 可用但不优，统一改为显式命名导入。

---

## 3. 一步到位后的目标架构

```text
atoma-types
├─ shared              # 共享基础标量（EntityId/Version/CursorToken）
├─ core                # 领域核心类型（Entity/Store/Relations/Query）
├─ protocol            # 协议数据类型（Operation/Envelope/Error/Meta/Notify）
└─ protocol-tools      # 协议工具函数（build/validate/error/sse/http/ids）

atoma-protocol
└─ 删除（包、源码、构建、依赖、路径映射全部移除）
```

分层规则固定为：
- `shared -> core -> protocol -> protocol-tools`
- 禁止任何反向依赖（尤其 `core -> protocol`）

设计模式：
- **Functional Modules（函数模块化）**：按能力域导出函数
- **No Facade God Object（无统一巨型门面）**：不引入 `Protocol` 聚合对象
- **Type/Runtime 分离**：`protocol` 只放类型，`protocol-tools` 只放运行时函数

---

## 4. 一步到位改造清单（无兼容）

## 4.1 删除 `atoma-protocol` 包

直接删除：
- `packages/atoma-protocol/**`
- root `package.json` 中 `--filter atoma-protocol` 的 build/typecheck 链路
- `tsconfig.paths.root.json` 中 `atoma-protocol` path alias

并在全仓替换导入：
- `from 'atoma-protocol'` → `from 'atoma-types/protocol-tools'`

---

## 4.2 并入运行时工具到 `atoma-types`（重命名为 `protocol-tools`）

### 命名决策
- 采用：`protocol-tools`
- 不采用：`protocol-runtime`

原因：
- `runtime` 在本仓语义上更接近“执行时核心引擎”（`atoma-runtime`），容易与运行时层混淆。
- 该模块本质是无状态 helper/toolkit，`tools` 语义更精确。

### 导出策略（最优）
- **默认：命名导出 + 扁平导入**（推荐）
  - `import { buildQueryOp, assertOperationResults, createIdempotencyKey } from 'atoma-types/protocol-tools'`
- **可选：按域子入口导入**（大体量模块可用）
  - `atoma-types/protocol-tools/ops`
  - `atoma-types/protocol-tools/error`
  - `atoma-types/protocol-tools/sse`
  - `atoma-types/protocol-tools/http`
  - `atoma-types/protocol-tools/ids`

### 约束
- 禁止新增 `Protocol` 聚合对象。
- 禁止在业务代码使用 `Protocol.xxx` 风格。

---

## 4.3 拍平 `atoma-types/protocol`

将现有分层（`core/*`、`ops/*`、`transport/*`）直接扁平化为：
- `protocol/scalars.ts`
- `protocol/meta.ts`
- `protocol/error.ts`
- `protocol/envelope.ts`
- `protocol/query.ts`
- `protocol/changes.ts`
- `protocol/operation.ts`
- `protocol/notify.ts`
- `protocol/index.ts`

说明：
- 无兼容约束，不保留旧目录转发文件。
- 仓内所有引用统一按新结构调整。

---

## 4.4 修复 `core` 对 `protocol` 的反向依赖

当前问题点：
- `core/query.ts` 使用 `import('../protocol')` 做类型别名
- `core/entity.ts` / `core/store.ts` / `core/indexes.ts` / `core/writeback.ts` 从 `protocol` 引 `EntityId`

一次性目标：
1. 将 `EntityId/Version/CursorToken` 放入 `shared/scalars.ts`
2. `core` 只依赖 `shared`（不依赖 `protocol`）
3. `Query/FilterExpr/SortRule/PageSpec/PageInfo` 以 `core` 为源定义
4. `protocol` 复用 `core` 的查询类型

---

## 4.5 规范化 `import * as Types from core`

在 `atoma-types/src` 内全部替换为显式命名导入：
- `import type { Entity, Query, StoreToken, StoreApi, OperationContext } from '../core'`

执行原则：
- 不保留 `Types.X` 命名空间写法。
- 大文件按类型域分组导入，但保持显式符号。

---

## 4.6 构建与依赖同步清理

同步修改：
- 11 个 `package.json` 中的 `atoma-protocol` 依赖删除
- 12 个 `tsup.config.ts` 的 `external: ['atoma-protocol']` 清理
- README 中提及独立 `atoma-protocol` 的描述改为 `atoma-types/protocol + atoma-types/protocol-tools`

---

## 5. 执行顺序（单分支一次完成）

1. 在 `atoma-types` 落 `protocol-tools` 与 `shared` 基础层
2. 全量迁移 `Protocol.*` 调用为命名导入（`atoma-types/protocol-tools`）
3. 拍平 `atoma-types/protocol` 并修正所有 import
4. 解除 `core -> protocol` 反向依赖
5. 清理 `import * as Types from '../core'`
6. 删除 `packages/atoma-protocol`
7. 清理构建脚本 / path alias / 依赖与文档
8. 最后一次性跑 `pnpm build` + `pnpm typecheck`

---

## 6. 验收标准（一步到位）

- 仓库中不存在 `packages/atoma-protocol`
- 全仓不存在 `from 'atoma-protocol'`
- 全仓不存在 `from 'atoma-types/protocol-runtime'`
- 全仓不再出现 `Protocol.` 调用风格
- `atoma-types/src/core/**` 不再引用 `../protocol`
- `import type * as Types from '../core'` 为 0
- `pnpm build`、`pnpm typecheck` 全绿
- README 不再描述 `atoma-protocol` 为独立共享包

---

## 7. runtime/engine 命名专项审查（camelCase + 简短 + 去 Engine 尾缀）

### 7.1 当前发现（`packages/atoma-types/src/runtime/engine`）

现有文件：
- `sharedTypes.ts`
- `indexEngine.ts`
- `queryEngine.ts`
- `relationEngine.ts`
- `mutationEngine.ts`
- `operationEngine.ts`
- `runtimeEngine.ts`

结论：
- 文件名整体已是 camelCase；
- 但存在明显冗余：目录已是 `engine/`，文件再带 `*Engine` 尾缀，语义重复；
- `sharedTypes.ts` 可进一步缩短。

### 7.2 一步到位重命名建议（文件级）

- `sharedTypes.ts` -> `shared.ts`
- `indexEngine.ts` -> `indexes.ts`
- `queryEngine.ts` -> `query.ts`
- `relationEngine.ts` -> `relations.ts`
- `mutationEngine.ts` -> `mutation.ts`
- `operationEngine.ts` -> `operation.ts`
- `runtimeEngine.ts` -> `api.ts`

命名规则：
- 目录语义优先：在 `engine/` 目录内不再重复 `Engine` 后缀；
- 多词保持 camelCase（本批建议大多可单词化）；
- 优先语义名词，避免技术词重复。

### 7.3 类型名优化建议（可与文件改名同步）

- `RuntimeIndexEngine` -> `RuntimeIndexes`
- `RuntimeQueryEngine` -> `RuntimeQuery`
- `RuntimeRelationEngine` -> `RuntimeRelations`
- `RuntimeMutationEngine` -> `RuntimeMutation`
- `RuntimeOperationEngine` -> `RuntimeOperation`
- `RuntimeEngine` 保留（聚合根类型名可以保留）

说明：
- 这里主要清理“局部接口名 + Engine”冗余；
- 顶层聚合类型 `RuntimeEngine` 作为公共概念可保留不动。

### 7.4 同步变更点（仅清单）

- `packages/atoma-types/src/runtime/index.ts`
  - 更新 `export type ... from './engine/*'` 路径
- `packages/atoma-types/src/runtime/runtimeTypes.ts`
  - `import type { RuntimeEngine } from './engine/runtimeEngine'` 改为新路径
- 所有使用 `Runtime*Engine` 的类型引用位点
  - 同步替换为新类型名（若采用 7.3）

### 7.5 验收口径（命名专项）

- `packages/atoma-types/src/runtime/engine` 下文件名不再出现 `*Engine.ts`
- 文件名总量不增加、整体更短
- 目录内命名风格统一（camelCase / 单词化优先）
- 全仓类型检查通过

---

## 8. 为什么这是当前最优解

- 在“无用户、无兼容负担”条件下，任何过渡层都是技术债。
- 一次性完成可避免二次重构、双路径维护和团队认知分裂。
- 函数模块化 + 命名导出比统一 `Protocol` 门面更易维护、更利于 tree-shaking。
- 结果是更少包、更清晰层次、更低长期维护成本。

---

## 9. atoma-types 内部其他可同步优化（补充）

> 该节是在 `runtime/engine` 之外，对 `atoma-types` 其余目录做的二次审查；以下项均可在“一步到位改造”中同步完成。

### 9.1 文件命名再收敛（camelCase + 简短）

当前额外可优化点：
- `packages/atoma-types/src/runtime/runtimeTypes.ts` -> `packages/atoma-types/src/runtime/api.ts`
- `packages/atoma-types/src/runtime/persistenceTypes.ts` -> `packages/atoma-types/src/runtime/persistence.ts`
- `packages/atoma-types/src/runtime/handleTypes.ts` -> `packages/atoma-types/src/runtime/handle.ts`
- `packages/atoma-types/src/client/plugins/types.ts` -> `packages/atoma-types/src/client/plugins/contracts.ts`
- `packages/atoma-types/src/client/drivers/types.ts` -> `packages/atoma-types/src/client/drivers/envelope.ts`
- `packages/atoma-types/src/core/queryMatcher.ts` -> `packages/atoma-types/src/core/matcher.ts`

原则：
- 在语义目录内去掉冗余后缀（`*Types`、`*Engine`）；
- 文件名优先表达“领域语义”而非“文件属性”。

### 9.2 重复类型收敛（避免多份近似协议壳）

发现：
- `client/backend.ts` 与 `client/drivers/types.ts` 都在描述 ops 请求/响应壳。

建议：
- 合并为单一文件（建议 `client/ops.ts` 或 `client/envelope.ts`），统一导出：
  - `ExecuteOpsInput`
  - `ExecuteOpsOutput`
  - `OpsClientLike`
  - `OperationEnvelope`
  - `ResultEnvelope`
- 删除 `client/drivers/` 目录（当前仅 1 个 `types.ts`，层级收益很低）。

### 9.3 类型命名冲突与语义对齐

发现：
- `core/query.ts` 有 `QueryResult<T>`；
- `client/plugins/types.ts` 也有 `QueryResult`（但语义是插件读链路返回）。

建议：
- 将插件侧 `QueryResult` 更名为 `PluginReadResult`（或 `ReadResultEnvelope`），避免与 core 语义冲突。
- 同步检查并清理“同名不同义”的类型（尤其 `Result*`、`Schema*`、`Context*`）。

### 9.4 Schema 类型重复抽象

发现：
- `client/schema.ts` 的 `AtomaStoreSchema` 与 `runtime/schema.ts` 的 `RuntimeStoreSchema` 结构高度相似。

建议：
- 抽公共基类（例如 `shared/schema.ts`）：`StoreSchemaBase<T>`；
- `AtomaStoreSchema` 与 `RuntimeStoreSchema` 基于该基类扩展，避免平行演化。

### 9.5 `any`/宽类型治理（同步清理）

当前扫描结果（`packages/atoma-types/src`）：
- `any` 出现约 **70** 处；
- `import type * as Types from '../core|../../core'` 出现 **17** 处。

建议优先清理位点：
- `devtools/index.ts`：`get/register` 的 `any` 改为 `unknown` + 泛型
- `observability/index.ts`：`lastQueryPlan/paramsSummary` 的 `any` 收敛
- `core/events.ts`：`emit(..., data?: any)` 改 `unknown`
- `core/indexes.ts`：`getLastQueryPlan: () => any` 改为显式 `QueryPlan | unknown`
- `runtime/runtimeTypes.ts`：`pageInfo?: any` 改为显式类型

### 9.6 sync 类型层再收敛

发现：
- `sync/index.ts` 体积较大（约 270 行），且仍有 `import('../protocol')` 内联引用；
- 多处 `entityId/baseVersion` 仍使用 `string/number`，未复用统一标量。

建议：
- 拆分为：`sync/outbox.ts`、`sync/transport.ts`、`sync/config.ts`、`sync/events.ts`；
- 消除内联 `import('../protocol')`，改显式 type import；
- 在引入 `shared/scalars.ts` 后，统一使用 `EntityId/Version`。

### 9.7 根导出与命名空间策略

发现：
- `src/index.ts` 使用 `export type * as Core/Runtime/Client/...` 命名空间导出。

建议：
- 维持子路径导出为主（`atoma-types/core` 等），降低根命名空间依赖；
- 如保留根命名空间导出，仅作为辅助入口，不作为内部代码默认风格。

### 9.8 补充验收项（可并入总验收）

- `atoma-types/src/runtime/**` 与 `atoma-types/src/client/**` 不再出现 `*Types.ts`
- `client/drivers/` 目录移除或不再承载仅有单文件的层级
- `any` 使用数量显著下降（建议下降到 < 20，且都为有意识边界点）
- `import type * as Types from '../core|../../core'` 清零
- 不存在同名不同义的 `QueryResult` / `ResultEnvelope` 类型

---

## 10. `protocol-tools` 最终导出 API 白名单（函数级）

> 目标：给出可直接落地的“最终公开接口”，避免后续再次膨胀为 `Protocol` 大门面。

### 10.1 导出设计原则（硬约束）

- 只允许 `named export`，禁止 `default export`。
- 禁止统一门面对象（`Protocol` / `protocolTools`）。
- 禁止空壳导出（如当前 `collab` 这种无实现占位）。
- 主入口只放高频稳定 API；其余通过子入口导出。
- 工具函数命名要显式表达语义，避免过短通用词（如裸 `create`、`error`）。

### 10.2 主入口白名单（`atoma-types/protocol-tools`）

推荐主入口仅导出以下稳定 API：

- **ops 构建**
  - `buildRequestMeta`
  - `withTraceMeta`
  - `buildWriteOp`
  - `buildQueryOp`
  - `buildChangesPullOp`
- **ops meta**
  - `ensureWriteItemMeta`
  - `newWriteItemMeta`
- **ops 校验**
  - `assertMeta`
  - `assertOpsRequest`
  - `assertOperation`
  - `assertOutgoingOps`
  - `assertOperationResult`
  - `assertOperationResults`
  - `assertQuery`
  - `assertFilterExpr`
  - `assertQueryResultData`
  - `assertWriteResultData`
- **error 工具**
  - `createProtocolError`（由现 `createError` 统一命名）
  - `wrapProtocolError`（由现 `wrap` 统一命名）
  - `withErrorTrace`（由现 `withTrace` 统一命名）
  - `withErrorDetails`（由现 `withDetails` 统一命名）
- **envelope 工具**
  - `composeEnvelopeOk`（由现 `ok` 统一命名）
  - `composeEnvelopeError`（由现 `error` 统一命名）
  - `parseEnvelope`
  - `ensureMeta`
- **sse 工具**
  - `SSE_EVENT_NOTIFY`
  - `sseComment`
  - `sseRetry`
  - `sseEvent`
  - `sseNotify`
  - `parseNotifyMessage`
  - `parseNotifyMessageJson`
- **http 常量**
  - `HTTP_PATH_OPS`
  - `HTTP_PATH_SYNC_SUBSCRIBE`
- **id 工具**
  - `createIdempotencyKey`
  - `createOpId`

### 10.3 子入口白名单（按域拆分）

建议提供以下子入口（用于按需导入，减少主入口膨胀）：

- `atoma-types/protocol-tools/ops`
- `atoma-types/protocol-tools/error`
- `atoma-types/protocol-tools/envelope`
- `atoma-types/protocol-tools/sse`
- `atoma-types/protocol-tools/http`
- `atoma-types/protocol-tools/ids`

约束：
- 子入口导出名与主入口保持一致，不做二次别名。
- 新增 API 必须先进入子入口，再评估是否提升到主入口白名单。

### 10.4 明确不导出的内容（黑名单）

- 不导出：`Protocol` 聚合对象
- 不导出：`collab` 空对象占位
- 不导出：仅内部复用的辅助函数（如 `isPlainObject`、`readString` 之类）
- 不导出：语义重复 API（例如 `create` 与 `createError` 并存）

### 10.5 使用示例（目标风格）

- 推荐：
  - `import { buildQueryOp, assertOperationResults, createOpId } from 'atoma-types/protocol-tools'`
- 大模块按域导入：
  - `import { parseNotifyMessage, SSE_EVENT_NOTIFY } from 'atoma-types/protocol-tools/sse'`

### 10.6 验收补充（API 面）

- 全仓不再出现 `Protocol.` 访问链
- `protocol-tools` 主入口导出集合与本节白名单一致
- `protocol-tools` 子入口仅包含对应域 API
- 无空壳导出、无重复语义导出
