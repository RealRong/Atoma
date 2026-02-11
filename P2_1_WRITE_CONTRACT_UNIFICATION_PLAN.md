# P2.1 Operation v2 与写入合同统一方案（最终版）

> 目标：不做兼容迁移层，直接落地最优架构。  
> 结论：**内部统一 `WriteEntry` / `QuerySpec`，`Operation`（建议重命名 `RemoteOp`）只保留在传输边界。**

---

## 1. 最终架构决策（唯一推荐）

### 1.1 分层真相（Single Source of Truth）

- `atoma-core` / `atoma-runtime` / `sync queue` 内部：只流转领域合同。
  - 写：`WriteEntry[]`
  - 读：`QuerySpec`
- `Operation` 体系只属于协议传输层：
  - 建议命名：`RemoteOp`（替代泛化的 `Operation`）
  - 使用位置：`transport adapter` / `ops driver`
- 协议结构不再反向渗透到 runtime 主流程。

### 1.2 为什么这是最优

- 彻底消除“内部先组 `WriteOp`、随后 sync 再拆回 item”的重复流。
- 内部模型与网络模型解耦，避免协议字段驱动本地架构。
- 写入语义、回写语义、同步语义各自收敛到单一模型，维护成本最低。

---

## 2. Operation v2 合同定义

### 2.1 命名收敛

- `Operation` -> `RemoteOp`（推荐）
- `OperationKind` -> `RemoteOpKind`
- `OperationResult` -> `RemoteOpResult`

> 若短期不改名，也必须在文档与目录语义上明确：现有 `Operation` 是“远程协议操作”，不是“内部运行时操作”。

### 2.2 写入协议（v2）

- `WriteOp` 从 `action + items` 改为 `entries`：
  - `write: { resource, entries: WriteEntry[], options? }`
- `WriteEntry` 改为判别联合（每条 entry 自带 action）
  - `create | update | upsert | delete`
  - 每条必须包含 `entryId`（客户端生成，稳定对齐键）
  - 保留 `meta.idempotencyKey/clientTimeMs`

### 2.3 结果协议（v2）

- `WriteResultData.results` 使用 `WriteEntryResult[]`
- 对齐方式从 `index` 改为 `entryId`
- `opId` 仅用于 trace/debug，不再用于业务结果定位

---

## 3. 领域层与传输层职责边界

### 3.1 领域层（core/runtime/sync queue）

- 主模型：`WriteEntry[]`
- 不直接依赖 `RemoteOp`/`WriteOp`
- `PersistRequest` 仅暴露 `writeEntries`

### 3.2 传输层（transport/adapter）

- 唯一职责：
  - `WriteEntry[] -> WriteOp[]`（出站）
  - `RemoteOpResult -> WriteEntryResult`（入站映射）
- `ops-driver` 是唯一转换点，禁止在 runtime/sync 内新增并行转换函数

---

## 4. WriteOptions 重构原则

### 4.1 两层选项拆分

- 领域层选项：只保留真实影响本地行为的语义项
- 传输层选项：只保留协议请求控制项（如返回形态）

### 4.2 禁止混用

- runtime/core 不因 transport 选项分叉本地逻辑
- sync queue 不承载“协议展示型选项”

---

## 5. 保留 / 删除清单

### 5.1 保留

- `WriteEntry`（内部唯一写入合同）
- `WriteOp`（仅协议边界）
- `QueryOp` / `ChangesPullOp`（协议层）

### 5.2 删除或下沉

- `WriteIntent` 作为公共合同（删除）
- `WriteIntentOptions` 公共导出（删除）
- `OutboxWriteAction` / `OutboxWriteItem*` 平行模型（删除，复用协议写入实体）
- `mapWriteOpsToOutboxWrites` 这类拆装转换（删除）

---

## 6. 目标数据流（v2）

1. store API 产生写请求
2. runtime 组装 `WriteEntry[]`
3. strategy.persist(req.writeEntries)
4. queue/local-first 直接入 outbox（仍是 `WriteEntry`）
5. 仅在 transport adapter 处进行 `WriteEntry[] -> WriteOp[]`
6. 服务端返回结果后，按 `entryId` 回写与映射

> 关键约束：协议对象只在第 5 步出现。

---

## 7. 分阶段落地（无兼容，一次切换）

### Phase A：types 抽芯

1. 在 `protocol` 定义并导出 `WriteEntry` / `WriteEntryResult`（含 `entryId`）
2. `runtime/persistence.ts`：`writeOps` -> `writeEntries`
3. `sync/outbox.ts`：复用 `WriteEntry`，删除并行 outbox 写模型

验收：`pnpm --filter atoma-types typecheck`

### Phase B：runtime 收敛

1. `WriteOpsBuilder` -> `WriteEntriesBuilder`
2. `WriteCommitFlow` 全链路改为处理 `writeEntries`
3. 删除 runtime 对 `WriteIntent` 公共合同依赖

验收：`pnpm --filter atoma-runtime typecheck`

### Phase C：sync 去重

1. queue/local-first 直接消费 `req.writeEntries`
2. 删除 `mapWriteOpsToOutboxWrites`
3. outbox 索引保留 `resource/entityId/enqueuedAtMs`

验收：`pnpm --filter atoma-sync typecheck`

### Phase D：transport 适配定点化

1. 在 `ops-driver` 实现唯一协议适配
2. 构造 `WriteOp(entries)` 并处理结果回映射
3. 禁止其他层新增 `WriteOp` 构造逻辑

验收：`pnpm --filter atoma-sync typecheck`

### Phase E：全仓清理

1. 删除旧导出、旧命名、死代码
2. 同步 `AGENTS.md` 与架构文档
3. 全仓校验

验收：`pnpm typecheck`

---

## 8. 风险与控制

### 风险

1. `PersistRequest` 变更引发 strategy/plugin 连锁报错
2. `entryId` 对齐改造影响结果处理与错误回写
3. 旧测试依赖 `index` 对齐，需同步重写

### 控制

- 严格按 Phase 顺序推进（types -> runtime -> sync -> transport -> cleanup）
- 每阶段局部 typecheck，阶段完成后做全仓 typecheck
- 对 outbox 保留关键行为测试：去重、reserve、commit、rebase

---

## 9. DoD（完成定义）

满足以下全部条件即视为 P2.1 完成：

1. 内部流程（core/runtime/sync queue）仅使用 `WriteEntry[]`
2. `RemoteOp/WriteOp` 仅存在于传输边界
3. `WriteIntent` 不再作为公共类型
4. 写结果按 `entryId` 对齐，不依赖 `index`
5. 全仓 `pnpm typecheck` 通过

---

## 10. 一句话总结

**不是“删除 Operation”，而是“把 Operation 关进传输层”；内部只留领域合同。**
