# SyncEngine 设计文档（vNext 协议版）

本文定义一个独立的 `SyncEngine`（类似 `src/batch` 的 `BatchEngine`），用于承载 Atoma 的“离线 + 同步 + 订阅”子系统。它是 **内部实现**：不支持用户自定义中间件/随意插拔；但它遵循清晰、行业通用的同步抽象（outbox / change feed / cursor / idempotency），因此**用户若要自研 adapter**，只要实现等价的 transport/存储/回写边界，也能接入相同的契约。

设计前提：
- client/server 强绑定 **vNext 协议**（`#protocol/vnext`），尤其是 `OpsRequest/OpsResponse`、`WriteOp/WriteResultData`、`ChangesPullOp/ChangeBatch`、`StandardError`。
- 所有网络响应使用统一 envelope：`{ ok, data|error, meta }`；`meta.v` 必填。
- 核心追求：优雅、可读、易扩展、易维护、可推理；允许破坏性变更。

---

## 1. 目标与非目标

### 目标
- 独立子系统：把 sync 的状态、生命周期与错误处理从 `HTTPAdapter` 中彻底剥离。
- 固定、可推理的同步流程：明确“写入如何入队、何时推送、如何 ack/reject、如何推进 cursor、如何应用远端变化”。
- 明确边界：把“网络 I/O”、“协议解析”、“本地回写”、“持久化队列/游标”拆成可替换的内部组件。
- 面向未来：为基于 Yjs 的协作功能预留清晰的扩展位，避免把 CRDT 逻辑侵入 record sync。

### 非目标
- 不做可插拔中间件平台（不开放用户任意改顺序/短路语义）。
- 不试图兼容任意后端协议；官方实现只服务 Atoma/server 的 vNext 协议。

---

## 2. 行业抽象：Outbox + Change Feed + Cursor

SyncEngine 采用行业通用的“离线同步”抽象：

- **Outbox（本地待推送写队列）**：所有需要与服务端达成一致的写操作都先进入 outbox；网络可用时批量 push；服务端通过 **幂等键（idempotencyKey）** 去重。
- **Change Feed（远端变更流）**：客户端通过 pull（分页）或 subscribe（SSE 长连接）消费增量变更。
- **Cursor（单调递增游标）**：变更流以 cursor 作为 resume 点，保证“断线续传/至少一次投递”可实现且可推理。

这些概念都对应 vNext 协议类型：
- `WriteOp` + `WriteResultData`：outbox → 服务端（走 `/ops`）
- `ChangesPullOp` + `ChangeBatch`：pull changes（走 `/ops`）
- `ChangeBatch`：subscribe changes（SSE 事件体与 pull 完全一致）

> 注意：vNext 的 `Cursor` 是 **opaque string**，只能单调前进，推进点是 `ChangeBatch.nextCursor`。

---

## 3. 协议与路由（强绑定 vNext /ops）

SyncEngine 默认对接 Atoma/server 的两类路由（由 server 插件决定实际路径，语义固定）：
- `POST /ops`：统一执行 `WriteOp` 与 `ChangesPullOp`
- `GET /sync/subscribe-vnext`：SSE 事件流，事件体为 `ChangeBatch`

协议约束（可推理性核心）：
- `meta.v` 必填；请求级错误使用 envelope `ok:false`。
- `WriteOp` 里的每个 item **必须有稳定的 `idempotencyKey`**（离线重试复用同一 key）。
- `ChangeBatch.nextCursor` 是推进 cursor 的唯一权威字段；客户端只允许 **前进**。
- 操作级错误体现在 `OperationResult.ok=false`（envelope 仍可 `ok:true`）。

---

## 4. SyncEngine 的职责边界

SyncEngine 的核心职责：**编排与状态管理**，而不是“到处 applyPatches”。

建议把 SyncEngine 分解为 4 个内部组件（组合优于继承，全部内部实现）：

1) `OutboxStore`（持久化队列）
- 负责：入队、出队、标记 acked/rejected、崩溃恢复、去重。
- 状态：队列、批次游标、in-flight 标记（用于防止并发 push）。
- 实现：IndexedDB/SQLite/Memory（由 HTTPAdapter 选择适配器存储实现）。

2) `CursorStore`（持久化 cursor）
- 负责：读取/写入 lastCursor；只允许单调前进。
- 状态：`lastCursor`（持久化）。

3) `SyncTransport`（I/O 边界）
- 负责：与 Atoma/server 通信（`/ops` 执行 write/pull、SSE subscribe），处理重试/headers/trace（但不做业务编排）。
- 说明：官方实现可复用 `src/adapters/http/transport/*` 的统一 envelope 解析与 trace/header 规则。

4) `SyncApplier`（本地回写边界）
- 负责：把 `ChangeBatch`、write 的 ack/reject 结果映射为本地状态更新。
- 约束：**本地回写必须集中**（建议最终收口到一个 `StateWriter`），SyncEngine 只调用这个边界。

> 关键约束：SyncEngine 不直接依赖 `applyPatches/commitAtomMapUpdate` 这类实现细节；它只依赖 `SyncApplier`。

---

## 5. 对外（内部）API：少而强

SyncEngine 的 API 应该“少而强”，体现固定管线与清晰生命周期：

- `start()`：启动后台循环（push worker、subscribe 连接、网络监听等）
- `stop()`：停止后台活动（保留持久化状态）
- `dispose()`：释放资源（取消订阅、清理定时器、断开连接）
- `enqueueWrite(op)`：把写操作放入 outbox（使用 vNext `WriteOp` 的 item 语义）
- `flush()`：立即尝试 push（受并发/网络状态/退避控制）
- `pullNow()`：立即拉取一次变更（推进 cursor 并应用 changes）
- `subscribe()` / `setSubscribed(enabled)`：开启/关闭 SSE（由配置决定，行为固定）

可选（内部）事件回调（用于 observability，而非用户可编程管线）：
- `onStateChange`：如 `idle -> pushing -> backoff -> subscribed`（便于调试）
- `onPushResult/onPullResult`：便于 devtools 与日志记录

用户侧（HTTPAdapter config）最多暴露 `onRequest/onResponse/onError` 这类 transport 边界 hooks；SyncEngine 本身不暴露可插拔中间件。

---

## 6. 固定流程（可推理的状态机）

### 6.1 写入路径（Outbox → /ops Write → Ack/Reject）

1) `enqueueWrite(op)`：
- 生成 `idempotencyKey`（或要求调用方提供并保证稳定）
- 持久化写入 outbox（以 write item 为粒度或以 op 为粒度，内部自定）
- 触发 `scheduleFlush`（但不强制立即 push）

2) `flush()`：
- 若离线/退避中/已有 in-flight push：直接返回（保持可推理）
- 从 outbox 取一批 items，组装成 `WriteOp`（`action` + `items[]`）
- 通过 `/ops` 执行：`OpsRequest.ops=[WriteOp]`
- 处理响应 `WriteResultData.results[]`：
  - `ok:true`：标记 outbox item 已确认；并将 `data`（完整对象）交给 `SyncApplier` 应用版本/回写
  - `ok:false`：标记失败；交给 `SyncApplier` 进行冲突处理（利用 `error` 与 `current`）

保证：
- 至少一次投递（重试可能重复发送），由 `idempotencyKey` 在服务端去重达成幂等。
- 单设备顺序：同一 outbox 取出的 items 在一次 push 内保持顺序；跨批次顺序由 outbox 自身保证。

> vNext 写入成功结果包含 `entityId/version`，并允许携带完整 `data`（已在服务端实现）。

### 6.2 读取路径（Pull / Subscribe → Apply Changes → Advance Cursor）

Pull：
- `pullNow()` 使用 `CursorStore.get()` 获取起点
- 通过 `/ops` 执行 `ChangesPullOp`（`cursor/limit/resources?`）
- 响应 `ChangeBatch`：`{ nextCursor, changes[] }`
- 调用 `SyncApplier.applyChanges(changes)`
- `CursorStore.set(nextCursor)`（只前进）

Subscribe（SSE）：
- 以 `CursorStore.get()` 作为 resume 点建立 SSE（`/sync/subscribe-vnext?cursor=...`）
- 接收到事件 `ChangeBatch`：
  - `applyChanges(event.changes)`
  - `advanceCursor(max(event.nextCursor, lastCursor))`
- 处理 heartbeat/retry/maxHold：由 server 协议与 transport 共同保证连接可恢复

保证：
- 对 changes 的应用必须幂等或可容忍重复（SSE 重连与 pull 可能重叠）；cursor 单调前进是核心防线。

---

## 7. 错误模型与冲突策略（vNext 结构化错误）

### 网络错误
- 视为临时失败：进入退避（backoff），等待下一次 flush/pull/subscribe 重连。
- 不改变 outbox/cursor 的持久化状态（避免“失败推进”）。

### 协议/解析错误
- 视为不可恢复或需要升级：触发统一错误出口（observability + onError），并停止当前通道（例如关闭 subscribe，等待人工处理或版本升级）。

### 业务冲突（write item rejected）
`WriteItemResult.ok=false` 提供：
- `error: StandardError`（强制）
- `current?: { value, version }`（可选）

SyncEngine 不定义具体“怎么解决冲突”的业务策略；它只负责把 reject 交给 `SyncApplier`（或 `StateWriter`）：
- 简单策略：丢弃本地写、回滚到服务端值、提示冲突事件
- 高级策略：基于 `current.version` 重放 patches（rebase）或发起一次 pull 获取最新再重试

> 关键：冲突策略必须是可推理且可测试的“单一权威实现”，不要散落在多处。

---

## 8. 可替换点（让用户自研 adapter“能适配”）

官方 SyncEngine 是内部实现，但为了保持“行业规范化、便于外部适配”，我们把可替换点设计为清晰的边界接口（可公开或保持 internal，取决于产品策略）：

- `SyncTransport`：只要能按 vNext 协议实现 `/ops` 的 write/pull 与 SSE subscribe，就能复用 SyncEngine 的编排逻辑（例如在非 HTTP 环境用自定义网络栈）。
- `OutboxStore/CursorStore`：只要能提供持久化与单调 cursor，就能满足离线恢复需求（IndexedDB/SQLite/文件系统皆可）。
- `SyncApplier`：只要能把 `ChangeBatch` 与 write ack/reject 映射为本地状态更新，就能接入任意状态容器（不仅限于当前 store 实现）。

这三者足以让“用户自写 adapter”对齐同一套契约，而无需开放中间件平台。

---

## 9. 与 BatchEngine / REST 的关系

- BatchEngine 解决“查询效率”；SyncEngine 解决“一致性与实时性”。两者应并列，避免互相渗透状态。
- 当 Sync 启用时：
  - 写操作优先进入 outbox（乐观/离线），由 SyncEngine 决定何时 push（走 `/ops` write）。
  - 读操作仍可走 REST 或 BatchQuery（由 HTTPAdapter 的固定路由决定），但远端 changes 会通过 SyncApplier 统一回写本地，减少主动读的压力。

---

## 10. 面向未来：Yjs 协作的扩展方式

Yjs 是另一类同步语义（CRDT 文档增量），不应塞进 record sync 的细节里。

推荐的优雅落点：
- 保持 `SyncEngine` 专注 **record-level sync**（outbox + change feed）。
- 新增并列的 `CollabEngine`（或 `YjsEngine`）：
  - 负责 provider 生命周期（ws/webrtc）、doc 更新流、持久化（可选）、权限与房间管理。
  - 对外（内部）同样暴露 `start/stop/dispose`，并与 SyncEngine 在 `HTTPAdapter` 组合根处并列装配。
- 若未来需要统一“实时能力总线”，再引入内部 `RealtimeCoordinator`，只做生命周期编排与 observability 汇总，不把两种协议混在一起。

---

## 11. 迁移策略（从旧 Sync 迁到 vNext SyncEngine）

现有实现里与 sync 相关的状态主要分散在：
- `src/adapters/http/syncHub.ts`
- `src/adapters/http/syncOrchestrator.ts`
- `src/adapters/http/adapter/HTTPAdapter.ts`（装配 + 部分回写/编排）

迁移建议（保持可验证）：
1) 先把 sync 的状态字段与生命周期从 `HTTPAdapter` 收口到 `SyncEngine`
2) 明确 outbox/cursor 的持久化接口（形成 `OutboxStore/CursorStore`）
3) 将旧的 `SyncPushRequest/SyncPullResponse/SyncSubscribeEvent` 彻底替换为 vNext 的 `/ops` + `ChangeBatch`
4) 最后把回写动作集中到 `SyncApplier/StateWriter`，消除散落的回写路径

验证：
- `npm run typecheck`
- `npm test`（重点覆盖 write/pull/subscribe 的 vNext 分支与冲突 reject 路径）

---

## 12. 结论

一个独立的 `SyncEngine` 是把 Atoma 的“离线 + 同步 + 订阅”从 `HTTPAdapter` 解耦出来的关键一步。vNext 统一 `/ops` 与 `ChangeBatch` 之后，写入与拉取的契约更稳定、实现路径更收敛，SyncEngine 可以用更少的代码覆盖 push/pull/subscribe 的全部语义，同时保持与未来协作系统的边界清晰。

---

## 13. 代码落地（当前仓库）

- 引擎入口：`src/sync/engine.ts`（`SyncEngine`）  
- 存储与游标：`src/sync/outbox.ts`、`src/sync/cursor.ts`  
- 类型与出口：`src/sync/types.ts`、`src/sync/index.ts`
