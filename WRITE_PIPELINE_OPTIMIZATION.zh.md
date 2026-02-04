# 写入链路优化方案（去中间层版）

日期：2026-02-04

## 现状结论
- 已完成“只用 WriteOp/WriteItem”的写入链路重构。
- WriteFlow 负责：构建 WritePlan、执行持久化、基于 OperationResult 生成写回并应用。
- TranslatedWrite* 与 WritebackCollector 已删除。

## 进一步优化方向（按收益排序）

### 1) 去掉 PersistAck 与 applyPersistAck
**目标**：不再构建中间 ack 结构，直接基于 OperationResult 做写回。

**做法**：
- 在 WriteFlow 中直接解析 WriteItemResult：
  - upsert/create：用 itemRes.data 生成 upserts/created
  - versionUpdates：用 itemRes.version + entityId
  - delete：仅 versionUpdates 或显式 deletes（如需要）
- 删除 PersistAck 类型与 transformAck / applyPersistAck / resolveOutputFromAck。

**收益**：
- 类型与流程显著简化（少一套中间结构）。

### 2) 移除 RuntimePersistence.executeWriteOps
**目标**：让持久化只负责策略路由；执行 ops 直接走 runtime.io。

**做法**：
- HttpBackendPlugin 直接调用 runtime.io.executeOps。
- StrategyRegistry 仅保留 persist 路由（或彻底移除，见第 4 条）。

**收益**：
- 减少一层中间 API 与结果包装。

### 3) 精简 PersistRequest
**目标**：去掉冗余字段，降低耦合。

**可移除字段**：
- handle（WriteOp 已包含 resource）
- storeName（WriteOp 已包含 resource）
- opContext（若不需要插件/观测）

**收益**：
- 更接近“纯协议执行”，减少上下文依赖。

### 4) 不对外导出 WritePlan
**目标**：避免内部映射结构泄露为公共 API。

**做法**：
- 停止从 `runtime/persistence/index.ts` 导出 WritePlan。

**收益**：
- API 更清爽，减少维护面。

## 最终极简架构（参考）
- **保留**：WriteFlow → build WriteOp[] → runtime.io.executeOps → 直接写回
- **移除**：PersistAck / executeWriteOps / PersistRequest.handle/storeName/opContext

## 备注
- 如需严格写入顺序，可改为“连续相同 action+options 才合并”。
- 如需 per-item 不同 options，必须拆分 op（协议 options 仍是 op 级）。
