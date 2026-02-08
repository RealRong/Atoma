# Atoma 整体重构文档（总览）

更新时间：2026-02-08

## 1. 目标与约束

### 1.1 重构目标
- 统一架构风格：主流程使用 `class`，可复用逻辑下沉到 `utils` 或独立服务
- 统一模块边界：按子路径导入，避免大而全主入口聚合
- 收敛类型系统：减少 `any`，让上下文与协议字段命名一致
- 强化可维护性：降低单文件复杂度，减少重复参数与重复流程

### 1.2 执行约束
- 不做兼容层，不保留旧行为分支
- 以“代码可读性 + 结构清晰 + 类型稳定”为第一优先级
- 所有重构以 `pnpm typecheck` 通过为最低验收标准

---

## 2. 已完成重构（阶段性结果）

## 2.1 `atoma-runtime`（已完成主要结构化改造）

当前写流程目录已形成稳定分层：
- `packages/atoma-runtime/src/runtime/flows/write/commit/*`
- `packages/atoma-runtime/src/runtime/flows/write/services/*`
- `packages/atoma-runtime/src/runtime/flows/write/utils/*`

核心特征：
- 写主流程保留在 `WriteFlow`，提交阶段拆分为独立 commit flow
- `WriteCommitFlow`、`WriteOpsPlanner`、`WriteIntentFactory` 职责清晰
- 重复逻辑下沉到 `utils`（如 optimistic、batch、input prepare、result resolve）

## 2.2 `atoma-client`（已完成两轮优化）

### 关键改动
- `HandlerChain` 引入显式 terminal 语义，去掉异常控制流
- `LocalBackendPlugin` 改为基于 terminal 标记兜底
- `createClient` 拆分为装配函数，统一生命周期 disposer 管理
- 默认自动注入 `localBackendPlugin`（并做插件 `id` 去重）
- `PersistContext/ReadContext` 字段统一为 `storeName`
- schema 清理幽灵字段，输入从 `any` 收敛为 `unknown`

### 关键文件
- `packages/atoma-client/src/createClient.ts`
- `packages/atoma-client/src/plugins/HandlerChain.ts`
- `packages/atoma-client/src/defaults/LocalBackendPlugin.ts`
- `packages/atoma-client/src/plugins/PluginRuntimeIo.ts`
- `packages/atoma-client/src/schemas/createClient.ts`
- `packages/atoma-types/src/client/plugins/types.ts`

---

## 3. `atoma-core` 现状评估与优化方向

当前模块边界（`query/indexes/relations/store`）总体正确，但存在语义和结构层面的可优化点。

## 3.1 P0（优先，先修正确性）

### P0-1 关系投影的索引调用协议不一致
- 现象：`projector` 中以 `{ [field]: { eq: key } }` 调用 `collectCandidates`
- 问题：`StoreIndexes.collectCandidates` 期望 `FilterExpr(op)`，导致常退化为 `unsupported`
- 影响：关系查询本可走索引却频繁回退全扫描

涉及文件：
- `packages/atoma-core/src/relations/projector.ts`
- `packages/atoma-core/src/indexes/StoreIndexes.ts`

### P0-2 include.page 语义冲突
- `planner/projector` 会读取 `page.limit` 做 Top-N
- `RelationResolver` 却对 include query 的 `page` 直接抛错

涉及文件：
- `packages/atoma-core/src/relations/planner.ts`
- `packages/atoma-core/src/relations/RelationResolver.ts`

### P0-3 同字段条件无法合并
- `and` 下同字段条件（如 `gte + lte`）直接判定 unsupported
- 应支持同字段多条件合并，提升索引命中率

涉及文件：
- `packages/atoma-core/src/indexes/StoreIndexes.ts`

## 3.2 P1（结构化重构）

### P1-1 Query 主流程 class 化
当前 `query/engine/local.ts` 同时承担过滤/排序/分页/索引评估，建议拆为：
- `LocalQueryExecutor`（主流程 class）
- `filterEvaluator.ts`
- `sortEngine.ts`
- `pageEngine.ts`
- `selectionProjector.ts`
- `indexEvaluation.ts`

### P1-2 StoreIndexes 拆分职责
当前 `StoreIndexes` 同时负责：定义校验、索引工厂、候选规划、增量更新。
建议拆成：
- `IndexFactory`
- `IndexQueryPlanner`
- `IndexDeltaUpdater`
- `StoreIndexes`（仅作编排 facade）

### P1-3 Relations 逻辑复用提取
`planner/projector/resolver` 有 key 提取、query 合并、默认值回填重复。
建议提取：
- `relations/utils/key.ts`
- `relations/utils/includeQuery.ts`
- `relations/utils/defaultValue.ts`

## 3.3 P2（类型与命名收敛）
- 优先清理高密度 `any` 文件：
  - `query/engine/local.ts`
  - `relations/projector.ts`
  - `indexes/StoreIndexes.ts`
- 对外 API 对齐：`relations/builders.ts` 中 `variants` 建议补到 barrel 导出
- 清理未使用工具：如 `normalizeKey`

---

## 4. 建议落地顺序（atoma-core）

### 阶段 A：语义修正（P0）
1. 统一 `collectCandidates` 入参协议（FilterExpr 或明确 where 结构二选一）
2. 统一 include.page 策略（推荐：仅允许 `limit`，禁止 cursor/offset 分页）
3. 支持同字段条件合并

### 阶段 B：结构重排（P1）
1. query engine 拆分并引入 `LocalQueryExecutor`
2. indexes 分层：factory/planner/updater
3. relations 下沉复用函数

### 阶段 C：类型收敛（P2）
1. 清理主链路 `any`
2. 保持 `pnpm typecheck` 全绿
3. 补齐 barrel 导出与文档注释

---

## 5. 验收标准

- 架构标准
  - 主流程是否 `class` 化
  - 复用逻辑是否集中在 `utils`/独立 service
  - 是否消除跨模块命名不一致

- 质量标准
  - `pnpm --filter atoma-core run typecheck` 通过
  - `pnpm typecheck` 全仓通过
  - 无新增“隐式兼容分支”

---

## 6. 当前结论

- `runtime` 与 `client` 已完成核心重构目标，结构已进入可持续维护状态
- `core` 是下一阶段重点，建议先做 P0 修正再做 P1/P2 深化
- 按上述顺序推进可在不增加兼容包袱的前提下，快速得到“更清晰、可扩展、类型稳定”的核心层

---

## 7. Relation 专项问题补充（2026-02-08）

本节用于记录对 `atoma-core/relations` 与 `atoma-react/useRelations` 的专项审查结果，后续与 core 重构一起修复。

### 7.1 P0（确认存在缺陷，优先修复）

1. `hasMany` 的 `on-mount` 预取筛选逻辑方向错误
- 现象：首次挂载时可能把“新出现”的实体全部过滤掉，导致不发起预取；同时仍可能被标记为已完成。
- 影响：`hasMany` 关系在首屏可能长期为空。
- 相关文件：
  - `packages/atoma-react/src/hooks/internal/relationInclude.ts`
  - `packages/atoma-react/src/hooks/useRelations.ts`

2. `projector` 调用索引接口的入参形状不匹配
- 现象：传入的是 where-like 对象，而 `StoreIndexesLike.collectCandidates` 约定的是 `FilterExpr`。
- 影响：关系投影中的索引路径频繁退化为扫描路径。
- 相关文件：
  - `packages/atoma-core/src/relations/projector.ts`
  - `packages/atoma-core/src/indexes/StoreIndexes.ts`
  - `packages/atoma-types/src/core/indexes.ts`

3. include 分页语义冲突
- 现象：类型与 planner 允许并消费 `include.page.limit`（Top-N 语义），`RelationResolver` 却直接禁止 `page`。
- 影响：调用者行为不可预测，配置与运行时语义冲突。
- 相关文件：
  - `packages/atoma-types/src/core/relations.ts`
  - `packages/atoma-core/src/relations/planner.ts`
  - `packages/atoma-core/src/relations/RelationResolver.ts`

4. `maxConcurrency <= 0` 时预取会被静默跳过
- 现象：并发 worker 数变成 0，任务队列无人消费。
- 影响：关系预取失效但无明确失败信号。
- 相关文件：
  - `packages/atoma-core/src/relations/RelationResolver.ts`

### 7.2 P1（中优先级优化）

1. `compileRelationsMap` 输入校验不足
- `to` / `foreignKey` 等关键字段缺失时，存在被 `String(undefined)` 吞掉的风险。
- 建议：在 compile 阶段做严格 schema 校验，错误前置。
- 相关文件：`packages/atoma-core/src/relations/compile.ts`

2. `hasMany/hasOne` 在未显式 sort 时结果顺序不稳定
- limit 场景下会造成非确定性展示。
- 建议：引入稳定默认排序（例如 `id asc`）或明确文档说明。
- 相关文件：`packages/atoma-core/src/relations/projector.ts`

3. 多 key 场景可能重复合并目标项
- 建议在聚合阶段按目标主键去重。
- 相关文件：`packages/atoma-core/src/relations/projector.ts`

4. `runWithConcurrency` 实现可读性与边界控制一般
- 建议改为固定 worker 循环 + 显式边界保护（`limit = Math.max(1, floor(limit))`）。
- 相关文件：`packages/atoma-core/src/relations/RelationResolver.ts`

### 7.3 P2（规范与可维护性）

1. relation 区域 `any` 密度高
- 重点集中：
  - `packages/atoma-core/src/relations/projector.ts`
  - `packages/atoma-core/src/relations/planner.ts`
  - `packages/atoma-core/src/relations/compile.ts`
  - `packages/atoma-core/src/relations/RelationResolver.ts`
  - `packages/atoma-react/src/hooks/useRelations.ts`

2. 对外导出不完整
- `builders.ts` 中存在 `variants`，但 `relations/index.ts` 未导出。
- 相关文件：
  - `packages/atoma-core/src/relations/builders.ts`
  - `packages/atoma-core/src/relations/index.ts`

### 7.4 与总计划对齐的修复顺序

1. 先修 P0：保证 relation 行为正确性（预取触发、索引命中、分页语义一致、并发边界）。
2. 再做 P1：提高确定性与运行时稳定性。
3. 最后做 P2：收敛类型与导出规范，避免后续维护继续“漂移”。

---

## 8. Indexes / Query 专项问题补充（2026-02-08）

本节用于补充 `atoma-core/indexes` 与 `atoma-core/query` 的专项审查结果，后续可与 relation 问题合并修复。

### 8.1 P0（确认存在缺陷，优先修复）

1. `SubstringIndex` 删除空字符串值时可能残留脏索引
- 现象：`remove` 中通过 `if (!str) return` 判断文档值是否存在；当真实值为 `''` 时会被误判为不存在，导致该记录未从 `valueMap/reverseValueMap/gramMap` 清理。
- 影响：删除/更新后仍可能命中旧候选，出现“幽灵结果”。
- 相关文件：
  - `packages/atoma-core/src/indexes/implementations/SubstringIndex.ts`

2. 数值/日期过滤在“命中索引”与“不命中索引”时语义不一致
- 现象：`NumberDateIndex` 会把 `eq/in` 条件做数值归一化（如 `'1'` -> `1`，日期字符串 -> 时间戳），并返回 `exact`；`evaluateWithIndexes` 对 `exact` 候选会移除 filter，仅保留排序/分页。
- 影响：同一查询在“有索引”和“无索引”路径可能返回不同结果，属于行为级不一致。
- 相关文件：
  - `packages/atoma-core/src/indexes/implementations/NumberDateIndex.ts`
  - `packages/atoma-core/src/query/engine/local.ts`

### 8.2 P1（中优先级优化）

1. cursor token 未校验 sort 一致性
- 现象：cursor 里包含 `sort`，但执行时只使用 `values`，未校验 token.sort 与当前 query.sort 是否一致。
- 风险：跨查询复用旧 cursor 时，分页边界可能错误。
- 相关文件：
  - `packages/atoma-core/src/query/cursor.ts`
  - `packages/atoma-core/src/query/engine/local.ts`

2. `matchesFilter` 对未知 `op` 默认返回 `true`
- 现象：非法/拼写错误的过滤操作会被静默放行。
- 风险：调用方误配置时会返回过多数据，且问题不易被发现。
- 相关文件：
  - `packages/atoma-core/src/query/engine/local.ts`

3. `and` 下同字段条件无法合并（复核）
- 现象：`gte + lte` 等同字段组合当前直接走 unsupported。
- 影响：索引可命中场景被退化为全扫描，查询性能下降。
- 相关文件：
  - `packages/atoma-core/src/indexes/StoreIndexes.ts`

### 8.3 P2（规范与可维护性）

1. `indexes/query` 主链路 `any` 密度高
- 重点集中：
  - `packages/atoma-core/src/query/engine/local.ts`
  - `packages/atoma-core/src/indexes/StoreIndexes.ts`
  - `packages/atoma-core/src/indexes/implementations/TextIndex.ts`
  - `packages/atoma-core/src/indexes/base/IIndex.ts`

2. 索引快照仍存在类型强转
- 现象：`getIndexSnapshots` 通过 `(idx.config as any).type` 读取类型。
- 建议：将 `IIndex` 的 `config` 类型约束收敛到可直接读取 `type`。
- 相关文件：
  - `packages/atoma-core/src/indexes/StoreIndexes.ts`
  - `packages/atoma-core/src/indexes/base/IIndex.ts`

3. cache 写回策略判定过粗
- 现象：当前仅依据 `select` 来决定 `effectiveSkipStore`。
- 建议：将策略扩展为可组合判定（例如 include/cursor/partial projection 的显式策略）。
- 相关文件：
  - `packages/atoma-core/src/query/cachePolicy.ts`

### 8.4 与总计划对齐的修复顺序

1. 先修 P0：保证索引一致性与查询语义一致性（尤其是“索引路径 vs 非索引路径”结果一致）。
2. 再做 P1：补齐 cursor 防御与过滤器 fail-fast，减少隐性错误。
3. 最后做 P2：统一类型边界与策略表达，降低后续维护成本。
