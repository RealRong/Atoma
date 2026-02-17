# entityId -> id 全库统一改造与优化方案（一步到位）

## 1. 目标与决策

- 目标：将全库领域主键字段命名统一为 `id`，不再保留 `entityId`。
- 范围：`core/runtime/client/protocol/sync/server/plugins` 全链路。
- 策略：一次性替换，不保留兼容别名、不保留双写字段、不做过渡导出。
- 约束：`entryId/opId/idempotencyKey/requestId/actionId` 等“非实体主键”保持原语义，不纳入改名。

---

## 2. 目标命名模型（改造后）

### 2.1 核心写回模型

- `StoreWritebackArgs.versionUpdates`：
  - 从：`Array<{ entityId: EntityId; version: number }>`
  - 改为：`Array<{ id: EntityId; version: number }>`

### 2.2 写协议与结果模型（runtime/protocol）

- `WriteItemCreate/Update/Upsert/Delete`：
  - 从：`item.entityId`
  - 改为：`item.id`
- `WriteItemResult(ok)`：
  - 从：`{ entryId, ok: true, entityId, version, ... }`
  - 改为：`{ entryId, ok: true, id, version, ... }`

### 2.3 变更流与错误细节

- `Change`：
  - 从：`{ resource, entityId, kind, version, changedAtMs }`
  - 改为：`{ resource, id, kind, version, changedAtMs }`
- `ConflictErrorDetails/NotFoundErrorDetails`：
  - 从：`entityId`
  - 改为：`id`

### 2.4 Sync Outbox 语义

- `OutboxStore.commit(...).rebase[]`：
  - 从：`{ resource, entityId, baseVersion, ... }`
  - 改为：`{ resource, id, baseVersion, ... }`
- 持久化字段（IndexedDB）：
  - 从：`entityId`
  - 改为：`id`

### 2.5 runtime 内部计划态

- `WritePlanEntry.optimistic.entityId`：
  - 改为 `optimistic.id`（与 `StoreChange.id`、`Entity.id` 对齐）。

---

## 3. 改动清单（按包）

## 3.1 atoma-types（公共契约，优先改）

- `packages/atoma-types/src/core/writeback.ts`
- `packages/atoma-types/src/client/plugins/contracts.ts`
- `packages/atoma-types/src/runtime/persistence.ts`
- `packages/atoma-types/src/protocol/operation.ts`
- `packages/atoma-types/src/protocol/changes.ts`
- `packages/atoma-types/src/protocol/error.ts`
- `packages/atoma-types/src/sync/outbox.ts`
- `packages/atoma-types/src/protocol-tools/ops/validate/write.ts`
- `packages/atoma-types/src/protocol-tools/ops/validate/result.ts`

优化点：
- 校验器报错字段路径同步切换到 `item.id`/`id`，避免新旧词汇混用。
- 协议层与 runtime 层字段对齐后，可减少 transport 层语义转换成本。

## 3.2 runtime/core/client（本地执行链路）

- `packages/atoma-core/src/store/writeback.ts`
- `packages/atoma-runtime/src/runtime/flows/write/types.ts`
- `packages/atoma-runtime/src/runtime/flows/write/planner/buildPlanFromChanges.ts`
- `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts`
- `packages/atoma-client/src/execution/registerLocalRoute.ts`
- `packages/plugins/atoma-sync/src/applier/writeback-applier.ts`
- `packages/atoma-client/src/plugins/PluginContext.ts`（透传结构字段名跟随 types）

优化点：
- 写入计划、写回、结果回放统一 `id` 后，commit 流内可减少“字段翻译式局部变量”。

## 3.3 sync/transport/storage（跨端同步链路）

- `packages/plugins/atoma-sync/src/transport/operation-driver.ts`
- `packages/plugins/atoma-sync/src/lanes/push-lane.ts`
- `packages/plugins/atoma-sync/src/storage/outbox-store.ts`
- `packages/plugins/atoma-sync/src/internal/kv-store.ts`

优化点：
- outbox rebase 键统一为 `resource + id`，语义更短、更直接。
- IndexedDB 索引键名统一后，避免 store 层与协议层术语不一致。

## 3.4 server/backend（远端执行与回包）

- `packages/atoma-server/src/ops/opsExecutor/write.ts`
- `packages/atoma-server/src/ops/opsExecutor/index.ts`
- `packages/atoma-server/src/adapters/prisma/PrismaAdapter.ts`
- `packages/atoma-server/src/adapters/typeorm/TypeormAdapter.ts`
- `packages/plugins/atoma-backend-shared/src/operation-client-core.ts`
- `packages/plugins/atoma-backend-memory/src/operation-client.ts`

优化点：
- server 侧错误详情和 write result 与协议直接一致，减少映射和认知负担。

## 3.5 文档与设计稿

- `OPERATION_CONTEXT_OPTIMIZATION_PLAN.md`（示例字段同步）
- 其他出现 `entityId` 的设计文档按需同步更新。

---

## 4. 实施顺序（推荐）

1. **先改 atoma-types 契约**（一次性切换到 `id`）。
2. **并行改 runtime/core/client/sync/server 实现**，直到全量编译通过。
3. **处理持久化 schema**（outbox `entityId -> id`）并升级 DB 版本。
4. **更新 protocol-tools 校验与错误文案**，确保输出字段一致。
5. **清理文档与注释残留词汇**。

说明：本方案不做兼容层，因此必须在同一变更集中完成主链路收敛。

---

## 5. 持久化与破坏性变更策略

- IndexedDB outbox 结构变更需要升级 `DB_VERSION`。
- 由于仓库策略为“无兼容包袱，一步到位”，建议：
  - 直接重建 outbox object store（接受旧离线队列丢弃）。
  - 在 release note 明确该行为。

---

## 6. 风险与控制

- 风险 1：协议破坏性变更（外部调用方若仍发 `entityId` 会失败）。
  - 控制：同版本同步发布 SDK + server，文档只保留 `id`。
- 风险 2：本地离线 outbox 旧数据不可读。
  - 控制：升级说明明确“升级后重建队列”。
- 风险 3：错误详情字段变更影响监控面板筛选。
  - 控制：同步调整 observability 字段提取规则（`entityId -> id`）。

---

## 7. 完成标准（验收门槛）

- 代码层不再出现 `entityId` 字段名（类型、实现、校验、协议）：
  - 建议门禁：`rg -n "\\bentityId\\b" packages -g"*.ts"` 结果应为 0。
- 全 workspace 类型检查通过：
  - `pnpm typecheck`
- 全 workspace 构建通过：
  - `pnpm build`
- Sync 推拉、写回、冲突回放链路冒烟通过（重点关注 write result 与 outbox rebase）。

---

## 8. 预期收益

- 命名统一：`Entity.id / StoreChange.id / WriteItem.id / Change.id` 一致。
- 降低认知成本：去掉“同义双词（id/entityId）”切换。
- 降低维护成本：减少适配层字段映射与重复校验分支。
- 与仓库“无兼容保留、一次收敛”的架构原则完全一致。

