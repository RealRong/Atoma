# StoreWriteback 与 Version 模型重构最终方案（一步到位）

## 1. 背景与问题

当前 `StoreWritebackArgs` 已承载三类写回语义：`upserts / deletes / versionUpdates`，这在功能上可用，但存在明显的架构边界问题：

1. `version` 字段处理被下沉到了 core 通用算法层，导致领域算法与运行时并发语义耦合。
2. 版本类型在多个关键契约仍使用裸 `number`，没有完全统一到 `Version` 标量。
3. 写回策略默认“覆盖写 version”，没有明确的单调性策略约束（可能产生旧回执回退版本风险）。
4. `StoreWritebackArgs` 内部可变数组/对象较多，与当前类型系统的只读风格不一致。

结论：

- `versionUpdates` 这个能力本身是必要的。
- 但它的“应用位置”和“类型契约严谨度”需要重构。

## 2. 目标与非目标

### 2.1 目标

1. 保留 `writeback` 作为统一回写入口，不拆分成多入口。
2. 保留 `versionUpdates`，覆盖 sync ack 仅版本回写场景。
3. 将 `version` 处理职责从 core 移至 runtime/store 层。
4. 全链路统一 `Version` 标量，消除裸 `number` 语义漂移。
5. 明确版本写回策略，避免乱序回执导致版本回退。

### 2.2 非目标

1. 不引入兼容别名、过渡导出、双轨 API。
2. 不新增第二套版本模型（仍保持单一 `Version` + CAS 体系）。
3. 不改变外部业务语义（写回仍然触发正常 delta/change 流）。

## 3. 设计原则

1. 分层单向：`shared -> core -> runtime -> client/plugin`。
2. core 只保留通用变更算法，不做业务字段特化（如 `version`）。
3. runtime 负责执行语义与元数据回写（version、回执、事件时序）。
4. 契约最小化：优先收紧类型，不轻易扩张参数面。
5. 一步到位：改名与语义收敛一次完成，不保留旧路径。

## 4. 现状诊断（链路视角）

### 4.1 类型层现状

1. `StoreWritebackArgs` 目前定义为：`upserts?: T[]; deletes?: EntityId[]; versionUpdates?: Array<{ id: EntityId; version: number }>`。
2. `Version` 已在 `shared/scalars` 定义，但上述契约未统一复用。

### 4.2 执行层现状

1. runtime 远程提交后会收集 `itemResult.version` 并写入 `versionUpdates`。
2. 本地无远端执行器时，会基于本地状态推导 `nextVersion`，同样通过 `versionUpdates` 写回。
3. sync ack 场景可能只携带版本，不携带完整实体；该场景强依赖 `versionUpdates`。

### 4.3 架构问题根因

1. `versionUpdates` 是“运行时回执元数据”，不属于 core 变更算法的稳定职责。
2. 当前 core 直接修改实体 `version` 字段，使 core 对实体结构形成隐式约束。

## 5. 目标架构（最终态）

### 5.1 回写契约保持单入口

`StoreWritebackArgs` 继续保留三类能力：

1. `upserts`：服务端返回实体或本地归一化后的实体写回。
2. `deletes`：删除回写。
3. `versionUpdates`：纯版本回执写回（可无实体数据）。

说明：

- 不建议删除 `versionUpdates`。
- 不建议拆成独立 `writeVersion` API（会增加调用面和时序分叉）。

### 5.2 职责边界调整

1. core
- 仅处理 `upserts/deletes` 对 map 的通用变更计算。
- 不再处理 `version` 字段特化逻辑。

2. runtime/store
- 在 `StoreState.writeback` 侧负责应用 `versionUpdates`。
- 版本更新策略在这里统一实现并可测试。

3. client/plugin
- 继续通过 `stores.use(name).writeback(args)` 触发回写。
- 不感知版本应用细节，只传标准化回执数据。

### 5.3 版本策略（强约束）

版本写回采用单调递增策略：

1. 当目标实体不存在：忽略该 `versionUpdate`（不创建空壳实体）。
2. 当 `incomingVersion <= currentVersion`：忽略（防回退）。
3. 仅当 `incomingVersion > currentVersion`：应用更新并产出 change。
4. `version` 非正数/非有限数：视为非法输入，按统一校验策略处理（忽略或抛错，需在契约中固定）。

推荐：

- runtime 内部采取“忽略非法版本 + 记录 debug 事件”，避免同步链路因脏数据中断。

### 5.4 一致性语义

1. optimistic 变更与 version 回写仍通过 `mergeChanges` 收敛。
2. 版本写回产生的 change 保持可观测（历史、调试、订阅都可见）。
3. 事件顺序保持：`writeStart -> writeCommitted/writeFailed`，不新增阶段。

## 6. 类型模型最终建议

### 6.1 收敛后的核心类型

1. 新增（或内联）`VersionUpdate` 概念：`{ id: EntityId; version: Version }`。
2. `StoreWritebackArgs.versionUpdates` 改为只读数组与只读元素。
3. `WriteManyItemErr.current.version`、`Base.version` 等位置统一改为 `Version`。

### 6.2 只读化约束

1. `StoreWritebackArgs` 内部集合全部使用只读语义。
2. runtime 内部如需变更，显式复制后处理，不污染输入引用。

### 6.3 命名与语义

1. 保留 `versionUpdates` 命名，不改成泛化 `metadata`（避免过度抽象）。
2. `version` 仍叫 `version`，不引入 `revision/etag` 新术语，保持全仓词根稳定。

## 7. 一次性实施计划（无兼容保留）

### 7.1 Step 1：类型层收敛（atoma-types）

1. 收紧 `StoreWritebackArgs` 类型（`Version` + `ReadonlyArray`）。
2. 清理同类裸 `number` 版本字段，统一到 `Version`。
3. 更新 runtime/core/client/sync 受影响类型导出。

### 7.2 Step 2：核心算法边界收敛（atoma-core）

1. 从 core `writeback` 中移除 `versionUpdates` 的字段特化写入。
2. 保持 core 只负责 `upserts/deletes` 的 delta 计算。

### 7.3 Step 3：运行时回写落位（atoma-runtime）

1. 在 `StoreState.writeback` 中串联：先应用数据写回，再应用版本写回。
2. 版本写回按单调策略执行，合并成统一 delta 输出。
3. 保证索引刷新、订阅通知、变更合并语义不变。

### 7.4 Step 4：写链路调用点更新（runtime flows）

1. `commit/apply` 内 `versionUpdates` 容器类型统一为 `Version`。
2. 本地推导版本与远端 ack 版本均遵循同一校验策略。
3. 保持 `writeback` 入口不变，避免外层 API 扩散。

### 7.5 Step 5：sync/plugin 与外围契约清理

1. sync ack applier 的版本数据类型统一。
2. 清理 `as any` 风险点，确保回执写回受类型约束。
3. 事件与调试输出补充版本忽略原因（可选但推荐）。

### 7.6 Step 6：文档与规范更新

1. 更新 runtime/change/writeback 设计文档中的版本责任说明。
2. 在架构规范中显式写入：`version` 回写属于 runtime，不属于 core。

## 8. 验证方案

### 8.1 类型与构建

1. `pnpm --filter atoma-types run typecheck`
2. `pnpm --filter atoma-core run typecheck`
3. `pnpm --filter atoma-runtime run typecheck`
4. `pnpm --filter atoma-client run typecheck`
5. `pnpm --filter atoma-sync run typecheck`（若脚本存在）
6. `pnpm typecheck`

### 8.2 行为矩阵（必须覆盖）

1. 仅 `upserts`。
2. 仅 `deletes`。
3. 仅 `versionUpdates`。
4. `upserts + versionUpdates` 同 id 混合。
5. `versionUpdates` 乱序回执（旧版本晚到）。
6. `versionUpdates` 指向不存在实体。
7. optimistic 成功/失败与版本回写并存。
8. sync ack 只返回 version。

### 8.3 不变量检查

1. 版本不回退。
2. 同一输入在重复执行下幂等。
3. delta/change 可解释且顺序稳定。
4. 索引与快照一致。

## 9. 风险与处置

1. 风险：版本策略改变可能影响历史行为。
- 处置：先落地行为矩阵测试，以“单调不回退”为明确新规范。

2. 风险：从 core 挪到 runtime 后，delta 合并顺序出错。
- 处置：固定“数据写回 -> 版本写回 -> mergeChanges”顺序，并用回归用例锁定。

3. 风险：sync 侧仍有弱类型输入。
- 处置：以类型收紧为准，不再接受隐式 `any` 透传。

## 10. 最终决策

1. `versionUpdates`：保留。
2. `StoreWritebackArgs`：保留单入口，不新增额外参数。
3. `version` 职责位置：runtime/store（非 core）。
4. 版本策略：单调递增（仅接收更大版本）。
5. 重构策略：一步到位，不保留兼容。

## 11. 预期收益

1. 边界清晰：core 回归纯算法，runtime 承担运行时语义。
2. 可读性提升：看到 `version` 就能定位到 runtime 层。
3. 正确性提升：防止乱序 ack 造成版本回退。
4. 维护成本降低：类型一致、路径单一、术语稳定。

## 12. 全链路复审补充（version / atoma-server / atoma-backend-atoma-server）

本节基于代码复审，对 `version` 实际流转路径做精确还原，并给出修正后的最终方案。

### 12.1 客户端后端插件链路（现状）

1. `atoma-backend-atoma-server` 当前仅做薄封装，直接复用 `buildOperationExecutor`。
2. `buildOperationExecutor` 在写路径调用 `buildWriteEntries`，由后者把 runtime 写入条目转换为 protocol 写入条目。
3. `buildWriteEntry` 会读取 `handle.state.snapshot()` 并补齐 `baseVersion/expectedVersion`。

结论：`atoma-backend-atoma-server` 目前并未形成“version 专属边界”，version 语义仍在 `atoma-backend-shared`。

### 12.2 runtime/core 链路（现状）

1. runtime `prepareUpdate/prepareDelete` 会从实体读 `version` 并写入 `baseVersion`。
2. runtime 本地提交 (`applyLocalWrites`) 会推导 `nextVersion`，并通过 `versionUpdates` 再次写回状态。
3. runtime 远端提交 (`commit`) 会读取 `WriteItemResult.version` 并转成 `versionUpdates`。
4. core `writeback` 直接对实体对象做 `version` 字段写入。

结论：runtime 与 core 当前都在直接触碰 version，且 core 已发生字段特化污染。

### 12.3 sync 链路（现状）

1. `SyncWrites` 直接把 runtime `writeEntries` 入 outbox。
2. `operation-driver` 转 protocol 时强制要求 `update/delete` 必须有 `baseVersion`。
3. push ack 会用 `result.version` 做 outbox `rebase(baseVersion)`。
4. `WritebackApplier` 会把 ack 版本通过 `versionUpdates` 回写 runtime store。

结论：sync 目前把 version 当作基础语义，深度耦合 runtime 与 protocol。

### 12.4 atoma-server 链路（现状）

1. protocol 写模型要求 `update/delete` 带 `baseVersion`，写结果要求返回 `version`。
2. `writeSemantics` 对 `create/update/upsert/delete` 全路径要求或生成 `version`，并把 `serverVersion` 用于 replay/sync。
3. ORM adapter（Prisma/TypeORM）都以内置 version 规则执行 CAS/LWW 语义。

结论：`version` 在服务端是强语义，不是可选装饰字段。

## 13. 决策修正（覆盖第 10 节）

在你明确“version 是 atoma-server 强绑定语义”的前提下，最终建议修正为：

1. **runtime 不触碰 version。**
2. **core 不触碰 version。**
3. **version 只在 atoma-backend-atoma-server（及其服务端协议链）内生效。**

即：前文“version 放 runtime/store”的结论在该前提下不再最优，本节结论覆盖第 10 节。

## 14. 最优目标态（无兼容，一步到位）

### 14.1 语义边界

1. runtime/core：
- 只承担通用状态语义（entity data + change/delta）。
- 不读写 `entity.version`，不产出/消费 `baseVersion/expectedVersion/versionUpdates`。

2. atoma-backend-atoma-server：
- 独占维护 version 语义：请求注入、结果解析、冲突处理、版本推进、重试重放策略。
- 独占维护“本地版本视图”（Version Store / Version Cache）。

3. atoma-server：
- 保持现有 version 语义与协议约束不变。

### 14.2 类型边界

1. `atoma-types/runtime` 写入契约去 version 化：
- `WriteEntry.update/delete/upsert` 不暴露 `baseVersion/expectedVersion`。
- `WriteItemResult.ok` 不强制 `version` 字段。

2. `atoma-types/core` 去 version 化：
- `StoreWritebackArgs` 去掉 `versionUpdates`。
- `Base.version` 从 core 公共基类中移除。

3. `atoma-types/protocol` 保持 version 语义（这是 atoma-server 协议域，不是 runtime 域）。

### 14.3 组件职责重排

1. `atoma-backend-shared` 收敛为“通用执行骨架”，不承担 atoma-server version 规则。
2. 将 `buildWriteEntry`（含 base/expected 推导）下沉到 `atoma-backend-atoma-server`。
3. 若 memory/indexeddb 仍需模拟 atoma-server：
- 要么迁移为 atoma-server 语义实现的一部分。
- 要么独立声明其并发语义，不再复用 atoma-server 的 version 规则。

## 15. sync 专项重构（关键）

如果 version 从 runtime 脱钩，sync 必须同步收敛，否则会断链。

### 15.1 outbox 模型

1. outbox 存储“版本无关的写意图”，不存 `baseVersion`。
2. push 时由 `atoma-backend-atoma-server` 的 Version Coordinator 动态注入 `baseVersion/expectedVersion`。

### 15.2 rebase 模型

1. ack 后不再回写 outbox 条目的 `baseVersion`。
2. 改为更新 Version Store（`resource + id -> latestServerVersion`）。
3. 后续重试由 Version Store 重新计算写入基线版本。

### 15.3 写回模型

1. `WritebackApplier` 不再通过 runtime `versionUpdates` 回写版本。
2. runtime 只回写业务数据（upserts/deletes）。
3. 版本状态由 backend 插件私有维护（可持久化）。

## 16. 一次性落地顺序（建议执行清单）

1. `atoma-types` 先切边界：
- runtime/core 去 version 字段。
- protocol 保持不变。

2. `atoma-core`：
- 删除 `writeback` 中 version 特化。

3. `atoma-runtime`：
- 删除 prepare/apply/commit 中所有 version 推导与 `versionUpdates` 流程。
- `StoreState.writeback` 仅处理 upserts/deletes。

4. `atoma-backend-atoma-server`：
- 新增 Version Coordinator（注入请求版本、消费响应版本、处理冲突与幂等）。
- 承接原 `buildWriteEntry` 的 version 逻辑。

5. `atoma-backend-shared`：
- 去除 atoma-server 专属 version 逻辑，只保留通用 op 执行框架。

6. `atoma-sync`：
- outbox/rebase/applier 全链路改为“版本由 backend 侧维护”。

7. 清理：
- `atoma-shared` 中通用 `version` helper 如仅服务 backend 语义，迁移到 backend 域。

## 17. 校验标准（新增）

1. 结构性校验：
- runtime/core 代码中不再出现 `baseVersion/expectedVersion/versionUpdates`。
- runtime 不再读取或写入 `entity.version`。

2. 行为校验：
- atoma-server 后端下：CAS/LWW 行为与当前一致。
- sync 重试下：不出现版本回退、不会因旧 outbox 条目导致永久冲突。
- 非 atoma-server 后端下：runtime 可运行且不携带 version 假设。

3. 回归校验：
- `writeStart -> writeCommitted/writeFailed` 事件时序不变。
- optimistic/rollback 与最终状态一致性不变。

## 18. 最终结论（本次复审）

1. 若你把 version 定义为 atoma-server 专属语义，runtime 不该触碰。
2. 当前实现存在跨层污染，最佳解是把 version 全量收敛到 `atoma-backend-atoma-server` 链路。
3. 这会牵引 sync/outbox 一并重构；但在“无用户、无兼容成本”前提下，这是最干净、长期成本最低的架构。
