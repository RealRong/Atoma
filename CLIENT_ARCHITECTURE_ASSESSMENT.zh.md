# Atoma 客户端侧架构评估报告

> 评估范围：`atoma-client`、`atoma-runtime`、`atoma-core`、`plugins/*`、`atoma-react`  
> 评估方式：静态代码走读 + 调用链梳理 + 重复实现识别  
> 结论先行：**建议重构，且在“当前无用户”前提下，建议执行无兼容负担的结构性重构**

---

## 1. 执行摘要（TL;DR）

- 当前客户端体系的分层方向是正确的：`core`（算法）→ `runtime`（流程）→ `client`（插件组装）→ `plugins`（能力扩展）→ `react`（UI 订阅层）。
- 架构可用性较高，尤其是：查询/索引能力、Runtime Hook 机制、Sync 三 lane（push/pull/subscribe）设计。
- 主要问题不在“功能缺失”，而在“实现重复 + 复杂度集中”：
  - Backend 插件（memory/indexeddb/http）存在大面积同构逻辑。
  - `WriteFlow`、`useRelations` 体量过大，多职责耦合。
  - Relations 的 prefetch 与 projector 存在重复决策路径。
- 在“无用户、可无条件重构”前提下，建议采用 **先去重、再分层、后收敛 API** 的三阶段策略。

---

## 2. 当前客户端总体架构

## 2.1 分层视图

1. **门面层**：`atoma`
   - 仅导出 `createClient`，是非常薄的入口。
2. **组装层**：`atoma-client`
   - 负责插件注册、能力注册、`HandlerChain` 组装、`Runtime` 注入。
3. **运行层**：`atoma-runtime`
   - 负责读写流程（ReadFlow/WriteFlow）、持久化策略、hooks、store 管理、transform。
4. **核心引擎层**：`atoma-core`
   - 负责查询执行、索引候选、关系投影、store 辅助算法等纯逻辑。
5. **扩展层**：`plugins/*`
   - backend（memory/indexeddb/http）、sync、history、observability、devtools。
6. **UI 接入层**：`atoma-react`
   - 负责 query/relations 订阅与远程请求状态整合。

## 2.2 关键读写调用链

**读链路（简化）**

`useQuery` → `useStoreQuery/useRemoteQuery` → `store.query` → `Runtime.read.query` → `Runtime.io.query` → `read handler` → （常见通过 `queryViaOps`）→ `io.executeOps`。

**写链路（简化）**

`store.add/update/upsert/delete` → `Runtime.write.*` → prepare intent → optimistic commit → `persistence.persist` → plugin persist/io → writeback/finalize → hooks（history/observability/sync 可介入）。

---

## 3. 分包评估

## 3.1 `atoma-core`

**优点**

- 查询模块与索引模块分离较清晰，`evaluateWithIndexes` + `executeLocalQuery` 的组合合理。
- `StoreIndexes.collectCandidates` 的候选裁剪与 exactness 模型可支持后续优化。
- relations 提供 prefetch 与 projector 两类能力，基础能力完整。

**问题**

- relations 存在“双引擎并存”：`RelationResolver` 和 `projector` 在分支分组、键提取、索引/扫描选择上有重复。
- 决策逻辑分散，导致维护时需要同时修改 prefetch 与投影路径，回归风险高。

## 3.2 `atoma-runtime`

**优点**

- Runtime 把 IO、Persistence、Hooks、Transform、Stores 聚合为统一执行上下文，边界总体清晰。
- ReadFlow 的“远端失败回退本地”策略对可用性友好。
- 已有 `flows/write/{prepare,optimistic,finalize}` 子模块，说明架构有拆分意图。

**问题**

- `WriteFlow.ts`（581 行）仍是核心复杂度聚集点，承担 orchestration、异常回滚、hooks 触发、批量语义等多职责。
- `addMany/updateMany/deleteMany` 当前串行执行，吞吐和延迟模型可进一步优化（至少引入可控并发策略）。

## 3.3 `atoma-client`

**优点**

- `createClient` 完成插件注册/初始化/扩展注入，路径直观。
- `PluginRegistry` 优先级模型简单有效，适合中小规模插件生态。

**问题**

- `HandlerChain` 采用“缺少 terminal handler 时抛错”的机制，默认兜底逻辑（`LocalBackendPlugin`）依赖异常驱动控制流，可读性与可推理性一般。
- `createClient` 中组装逻辑逐步膨胀，后续继续扩展会增加修改热点。

## 3.4 `plugins/*`

**优点**

- 插件生态方向正确，backend/sync/history/observability 职责分工明确。
- sync 子系统工程化较成熟：模式切换、lane 编排、store 抽象、devtools 观测都比较完整。

**问题**

- backend 三件套存在明显重复：
  - `queryViaOps` 在 `http`/`memory`/`indexeddb` 插件中几乎一字不差。
  - persist 注册逻辑同构。
  - `memory` 与 `indexeddb` 的 `ops-client` 主流程高度同构（差异主要在存储介质 API）。
- sync 的 outbox/cursor 存储路径里，memory 与 idb 仍有重复状态迁移语义，可提炼共享 reducer。

## 3.5 `atoma-react`

**优点**

- `useQuery` 把本地缓存视图与远程状态合并，API 友好。
- `useRemoteQuery` 提供运行时级别缓存（WeakMap runtime cache），避免重复请求。

**问题**

- `useRelations.ts`（366 行）承担 prefetch 去重、snapshot/live 分层、跨 store 订阅、投影合并，多职责耦合明显。
- `useQuery` 内部同时处理 fetchPolicy、result mode、relations，策略组合复杂，后续加能力（如 staleTime、suspense）会变得脆弱。

---

## 4. 关键问题清单与优先级

## P0（应先做）

1. **Backend 同构实现去重**（收益最高，风险可控）
   - 抽出共享 `ops-client-core`（纯逻辑）+ `StorageAdapter`（memory/idb/http gateway）。
   - 抽出共享 `queryViaOps`/`persistViaOps` helper，三插件只保留配置差异。

2. **WriteFlow 结构化拆分**
   - 拆为 `WriteCommandService`（入口）、`OptimisticService`、`PersistCoordinator`、`WriteFinalizeService`。
   - 明确每层输入输出 DTO，减少隐式耦合。

## P1（第二阶段）

3. **Relations 执行路径统一**
   - 引入 `RelationQueryPlanner`（生成 lookup plan）。
   - `PrefetchExecutor` 与 `Projector` 共享同一计划结构，避免重复分支决策。

4. **React Hooks 纵向拆分**
   - `useRelationsPrefetch` / `useRelationsProjection` / `useRelationSubscriptions`。
   - `useQuery` 中 fetchPolicy 逻辑抽为独立策略对象（可测试）。

## P2（第三阶段）

5. **HandlerChain 明确 terminal 语义**
   - 支持显式 terminal handler 或默认 no-op terminal，避免异常驱动流程。

6. **Sync 存储语义收敛**
   - 抽出 outbox 状态机 reducer（pending/in_flight/ack/retry/rebase）共享给 memory/idb。

---

## 5. 是否需要重构（结论）

**结论：需要，且建议做结构性重构。**

原因：

- 现阶段主要成本在维护复杂度和重复实现，而非单点 bug。
- 继续在当前形态迭代会放大重复代码和认知负担。
- 当前明确“无用户”，意味着可以接受 API break 和目录重排，这是完成一次“干净重构”的最佳窗口。

---

## 6. 无用户前提下的重构路线图（可无条件执行）

## 阶段 A：去重与基础稳态（1~2 周）

- 提取 backend 共享 core：
  - `packages/plugins/atoma-backend-shared`（建议新包）。
  - 封装 `executeQuery/executeWrite/queryViaOps/persistViaOps`。
- 保留旧插件导出名不变，但内部全部走 shared core。
- 补充最小回归用例（backend 行为一致性、错误语义一致性）。

## 阶段 B：运行时内核解耦（2~3 周）

- 重构 `WriteFlow` 为 orchestrator + services。
- 把 hook 触发与状态回滚边界显式化（统一错误模型）。
- 引入可控并发批处理接口（默认仍串行，支持策略切换）。

## 阶段 C：关系与 React 层收敛（2~3 周）

- 构建统一 relation planner，prefetch/projector 共用计划。
- 拆分 `useRelations`，减少 effect 交织与缓存状态耦合。
- 将 fetchPolicy 策略下沉成纯函数模块，增强可测性。

---

## 7. 风险与收益评估

**收益**

- 预计减少 backend 重复代码 30%~50%。
- 降低核心改动的联动回归面，提升新人理解速度。
- 为后续能力（离线策略、更多 fetch policy、跨端 backend）留出稳定扩展点。

**风险**

- 结构重排期间短期内合并冲突和回归风险上升。
- 若一次性大爆改，定位问题成本会放大。

**控制建议**

- 按阶段落地，每阶段先“行为对齐”再“接口简化”。
- 给关键链路补 golden tests（读写结果、冲突语义、hook 次序、sync outbox 状态迁移）。

---

## 8. 关键证据文件（抽样）

- 客户端组装：
  - `packages/atoma-client/src/createClient.ts`
  - `packages/atoma-client/src/plugins/HandlerChain.ts`
  - `packages/atoma-client/src/defaults/LocalBackendPlugin.ts`
- Runtime：
  - `packages/atoma-runtime/src/runtime/Runtime.ts`
  - `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
  - `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
- Core：
  - `packages/atoma-core/src/query/engine/local.ts`
  - `packages/atoma-core/src/indexes/StoreIndexes.ts`
  - `packages/atoma-core/src/relations/RelationResolver.ts`
  - `packages/atoma-core/src/relations/projector.ts`
- Plugins：
  - `packages/plugins/atoma-backend-memory/src/plugin.ts`
  - `packages/plugins/atoma-backend-indexeddb/src/plugin.ts`
  - `packages/plugins/atoma-backend-http/src/plugin.ts`
  - `packages/plugins/atoma-sync/src/plugin.ts`
  - `packages/plugins/atoma-sync/src/engine/sync-engine.ts`
  - `packages/plugins/atoma-sync/src/storage/outbox-store.ts`
- React：
  - `packages/atoma-react/src/hooks/useQuery.ts`
  - `packages/atoma-react/src/hooks/useRemoteQuery.ts`
  - `packages/atoma-react/src/hooks/useRelations.ts`

---

## 9. 最终建议（一句话）

在当前“无用户、可无条件重构”的窗口期，建议立即启动 **以去重为先、以 Runtime/Relations 解耦为核心** 的分阶段重构；这是当前性价比最高、长期收益最大的技术决策。
