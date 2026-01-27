# 持久化解耦方案（服务端版本权威 + 本地内生版本）

本方案目标：将“本地内存状态（jotai + indexes）”与“持久化/外部副作用”彻底解耦，同时保持 **服务端版本权威**，并在纯本地/离线阶段维持可用的版本语义（不引入双版本字段）。

## 核心结论
- **本地内存状态是事实状态（source of truth for UI）**，独立于持久化。
- **持久化是可选副作用**（可以不存在、可延迟、可失败）。
- **服务端版本权威**：一旦连上服务端，`version` 必须以服务端返回为准。
- **本地内生版本**：仅用于纯本地/离线阶段维持写入链路，不引入双版本字段。

## 设计原则
1. **单向流**：先更新本地状态，再触发持久化（若存在）。
2. **本地版本只在离线有效**：线上成功写入后，服务端版本覆盖本地版本。
3. **持久化不改内存**：持久化只产出“外部回执”，不驱动内存写回。
4. **插件边界清晰**：writeStrategy 只处理副作用，不触碰本地状态。

## 概念划分

### 1) Local State Layer（本地内存层）
职责：
- 生成 optimistic state。
- 维护 jotai map + indexes。
- **离线阶段**生成版本：create=1，update/delete/upsert 递增，严格校验 baseVersion。

### 2) Persistence Layer（持久化副作用层）
职责：
- 执行外部副作用（HTTP / IndexedDB / SQLite / queue）。
- 返回“是否确认/失败”与服务端回执（serverVersion / data）。
- **不负责修改本地内存状态**。

## 行为模型（两种运行模式）

### A) 纯本地 / 离线模式
1. 本地内存更新（optimistic + patches）。
2. **本地内生版本更新**（保证 baseVersion 链条不断）。
3. 不触发持久化（或持久化为空实现）。
4. 本地状态即结果。

### B) 在线（接入 atoma-server）
1. 本地内存先更新（optimistic）。
2. 触发持久化副作用（HTTP write）。
3. 服务端返回 `serverVersion`（及可能完整 data）。
4. **用服务端版本覆盖本地版本**（若有 data 则用 data 覆盖本地对象）。

> 核心规则：**线上成功写入后，服务端版本覆盖本地版本**。本地版本不再作为权威。

## 与 atoma-server 的一致性
- atoma-server **严格依赖 baseVersion**（update/delete 必填；upsert strict 需要 baseVersion）。
- 因此：
  - 离线阶段生成的本地 version 只用于本地链路。
  - 在线时，必须以服务端返回的 serverVersion 为准，保持一致。

## 对现有链路的简化点

### 1) 移除“持久化写回”依赖
- `PersistResult` 不再携带 `writeback` 来驱动内存写回。
- `MutationFlow.finalizeWriteback` 简化为“仅处理服务端回执覆盖”。

### 2) 版本更新前置（仅离线）
- 在 local-only/离线阶段，由本地 mutation 直接更新版本。
- 不依赖后端回写。

### 3) 持久化只返回状态 + 回执
- `PersistResult` 简化为：
  - `status: confirmed | enqueued`
  - `error?: unknown`
  - `ack?: { serverVersion?: number; data?: unknown }`

### 4) 插件职责收敛
- 插件只处理外部持久化或队列策略，不再介入内存写回。

## 冲突处理原则（简化）
- 线上冲突由服务端判定（baseVersion 不一致）。
- 客户端只接收失败并回滚/提示，不做本地复杂合并。

## 风险与取舍
- 离线写入上线后可能冲突，需要上层处理重试/提示。
- 没有双版本字段，简单但牺牲“同时保留本地/服务端版本”的可观测性。

## 结论
该方案保持持久化解耦，同时坚持“服务端版本权威”。本地版本只服务于离线链路，不引入双版本字段，复杂度最低且与 atoma-server 语义兼容。
