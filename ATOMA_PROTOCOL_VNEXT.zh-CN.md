# Atoma Protocol vNext（统一 REST / Batch / Sync 的操作协议）

本文提出 Atoma 协议的 vNext 版本：以 **统一的“操作（Operation）抽象”** 覆盖 REST、Batch 与 Sync，并在所有端点上统一使用同一套响应外壳（envelope）与错误模型（StandardError）。  
目标是：**最优雅的抽象、跨端稳定契约、易实现/易扩展/易维护**。库尚未发布，允许破坏性变更，建议尽早一次性收敛。

> 定位：这是 Atoma 官方 client/server 的权威协议。它不追求兼容任意后端，但使用行业通用语义（outbox/change feed/cursor/idempotency、JSON Patch、结构化错误），因此第三方也能“按规范自研 adapter”对接同一套契约。

---

## 1. 总原则（必须遵守）

1) **统一外壳**：所有 HTTP 响应都使用同一种 envelope：`ok/data/error/meta`。  
2) **统一操作模型**：REST/Batch/Sync 的“业务语义”都表示为 `Operation`/`OperationResult`。  
3) **统一标量**：`EntityId/Cursor/Version` 必须是跨端稳定、易实现的基础类型。  
4) **单一权威推进点**：cursor/version 只能单调前进，推进字段必须唯一且语义明确。  
5) **错误可推理**：错误必须结构化，必须表达“是否可重试”，必须可链式表达 cause。  
6) **Patch 行业标准化**：使用 RFC 6902 JSON Patch（或其明确子集），避免自定义 path 表达。  
7) **版本显式化**：所有请求/响应必须携带 `meta.v`，允许未来演进且兼容策略可控。

---

## 2. 通用基础类型（跨端稳定）

为降低跨语言/跨存储实现复杂度，vNext 建议：

- `EntityId`: `string`  
  - 说明：统一成字符串最省心（数据库 numeric id 由 server/client 自行 stringify）。
- `Cursor`: `string`（opaque）  
  - 说明：不要暴露为 number；cursor 可能变成 keyset、多分片合并等，opaque 才可演进。
- `Version`: `number`  
  - 说明：实体版本单调递增。

时间字段统一用：
- `clientTimeMs?: number`
- `serverTimeMs?: number`

---

## 3. Meta（统一元信息）

`Meta` 是所有请求与响应的共同部分，用于版本、追踪、告警与诊断。

建议结构：
- `v: number`（必填）
- `traceId?: string`
- `requestId?: string`
- `deviceId?: string`
- `clientTimeMs?: number`
- `serverTimeMs?: number`
- `warnings?: Array<{ code: string; message: string; details?: unknown }>`

约束：
- `traceId/requestId` **只允许在一个地方出现**：建议统一放在 `meta`，HTTP header 仅作为传输层镜像（可选），不要 header/body/details 多处重复。

---

## 4. StandardError（统一错误模型）

### 4.1 错误结构（vNext 建议）

- `code: string`（稳定机器码）
- `message: string`（人类可读）
- `kind: ErrorKind`（分类，用于分流处理与测试）
- `retryable?: boolean`（是否可重试）
- `details?: ErrorDetails`（结构化详情，按 kind 分型）
- `cause?: StandardError`（链式错误）

> 不建议在协议里传 stack；如需调试信息，可由 server 在开发环境通过 `warnings` 或日志系统输出。

### 4.2 ErrorKind（示意）
- `validation`：输入不合法
- `auth`：鉴权失败/无权限
- `limits`：限流/超限
- `conflict`：版本冲突/并发写冲突
- `not_found`：资源不存在
- `adapter`：后端 adapter 错误
- `internal`：服务端内部错误

### 4.3 details 分型（建议）
为保证优雅与可维护性，`details` 应按 `kind` 建立 union（示意）：
- `validation`: `{ field?: string; path?: string; reason?: string }`
- `limits`: `{ max?: number; actual?: number; windowMs?: number }`
- `conflict`: `{ resource: string; entityId: EntityId; currentVersion?: Version; hint?: 'rebase' | 'server-wins' | 'manual' }`
- `not_found`: `{ resource: string; entityId?: EntityId }`
- 兜底扩展：`{ [k: string]: unknown }`

---

## 5. ResponseEnvelope（统一响应外壳）

所有 HTTP 响应都必须满足：

- 成功：`{ ok: true; data: T; meta: Meta }`
- 失败：`{ ok: false; error: StandardError; meta: Meta }`

约束：
- **请求级错误**（无法解析 body、鉴权拒绝整个请求、协议版本不支持等）用外壳 `ok:false`。
- **操作级错误**（batch 内单个 op 失败）应体现在 `OperationResult.ok:false`，外壳仍可 `ok:true`。

---

## 6. Operation 模型（统一 REST / Batch / Sync）

### 6.1 顶层请求/响应

所有“操作执行型”端点都使用以下结构：

- 请求：`OpsRequest = { meta: Meta; ops: Operation[] }`
- 响应：`OpsResponse = Envelope<{ results: OperationResult[] }>`

> REST 只是 “ops 的单操作”形态：传统 `GET /resource` 也可以映射为 `OpsRequest.ops=[QueryOp]`；是否保留 REST 路由属于 server 层路由选择，协议语义不变。

### 6.2 Operation（建议）

共同字段：
- `opId: string`（必填、请求内唯一，用于观测与回放）
- `kind: OperationKind`
- `meta?: Meta`（可选；如缺省则继承 `OpsRequest.meta`）

`OperationKind` 建议至少包含：
- `query`：查询
- `write`：写入（create/update/patch/delete 的统一抽象）
- `changes.pull`：拉取变更（Sync Pull）

> `changes.subscribe` 通过 SSE 传输，仍可视为一种“操作”，但它的响应是事件流（见第 8 节）。

---

## 7. Query / Write / ChangesPull 的具体形态（vNext 草案）

### 7.1 QueryOp

`QueryOp = { opId; kind:'query'; query: { resource: string; params: QueryParams } }`

其中 `QueryParams` 建议复用并收敛为单一权威类型（现有 `QueryParams` 可作为基线），但要保证：
- 字段命名稳定
- 分页语义明确（cursor/limit/order）
- `select` 的表达可跨端实现

`QueryResultData = { items: unknown[]; pageInfo?: PageInfo }`

`QueryResult = { opId; ok:true; data: QueryResultData } | { opId; ok:false; error: StandardError }`

### 7.2 WriteOp（统一 create/update/patch/delete）

`WriteOp = { opId; kind:'write'; write: { resource: string; action: WriteAction; items: WriteItem[]; options?: WriteOptions } }`

`WriteAction`：
- `create` | `update` | `patch` | `delete`

`WriteItem`（建议按 action 分型）：
- create：`{ entityId?: EntityId; value: unknown; meta?: { idempotencyKey?: string; clientTimeMs?: number } }`
- update：`{ entityId: EntityId; baseVersion?: Version; value: unknown; meta?: { idempotencyKey?: string; clientTimeMs?: number } }`
- patch：`{ entityId: EntityId; baseVersion: Version; patch: JsonPatch[]; meta?: { idempotencyKey?: string; clientTimeMs?: number } }`
- delete：`{ entityId: EntityId; baseVersion?: Version; meta?: { idempotencyKey?: string; clientTimeMs?: number } }`

`WriteOptions`（示意，按你们现有语义收敛）：
- `returning?: boolean`
- `select?: Record<string, boolean>`
- `merge?: boolean`
- `conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'`

写结果建议“完全可对齐请求 items”（便于回放与调试）：

`WriteItemResult`：
- 成功：`{ index: number; ok: true; entityId: EntityId; version: Version }`
- 失败：`{ index: number; ok: false; error: StandardError; current?: { value?: unknown; version?: Version } }`

`WriteResultData = { transactionApplied?: boolean; results: WriteItemResult[] }`

`WriteResult = { opId; ok:true; data: WriteResultData } | { opId; ok:false; error: StandardError }`

> 解释：Sync Push、Batch 写、REST 单写都能复用同一个 WriteOp/WriteResult。Sync 的“幂等/离线队列”仅要求 `idempotencyKey` 必填并在重试时稳定复用。

### 7.3 ChangesPullOp（Sync Pull）

`ChangesPullOp = { opId; kind:'changes.pull'; pull: { cursor: Cursor; limit: number; resources?: string[] } }`

返回统一的变更批：

`ChangeBatch = { nextCursor: Cursor; changes: Change[] }`

`Change = { resource: string; entityId: EntityId; kind: 'upsert' | 'delete'; version: Version; changedAtMs: number }`

`ChangesPullResult = { opId; ok:true; data: ChangeBatch } | { opId; ok:false; error: StandardError }`

约束：
- `nextCursor` 是推进 cursor 的唯一权威字段（不依赖 changes 内单条字段推进）。
- cursor 只能前进：客户端持久化 cursor 只允许 `max(old, nextCursor)`。

---

## 8. Subscribe（SSE）与 ChangeBatch 的统一

Subscribe 的 transport 是 SSE（事件流），但事件 payload 与 Pull 完全一致，统一为 `ChangeBatch`。

- 事件名建议：`atoma.sync.changes`（或沿用现有常量）
- 事件体：`ChangeBatch`
- 连接参数：`cursor`（起始 resume 点）

这样 SyncEngine 的处理逻辑可以完全复用：
- pull 与 subscribe 的差异仅在 transport 层
- “应用 changes + 推进 cursor”是一套代码路径

---

## 9. REST / Batch / Sync 的“同一套协议”如何落地

### 9.1 一个“语义协议”，多个路由形态

协议语义统一后，server 可以提供多种路由形态（按产品偏好选择）：

1) **单一端点**：`POST /ops`（推荐作为权威实现）
- 请求：`OpsRequest`
- 响应：`OpsResponse`
- 好处：client 只需要一种请求模型；Batch 天然就是多 op；REST 变为 1 op。

2) **保留 REST 友好路由（可选）**
- `GET /resource`、`POST /resource` 等仍可存在，但它们的响应仍必须是 `Envelope<T>`，并且其数据结构应能映射到等价的 `OperationResult`（推荐直接返回 `Envelope<{ result: OperationResult }>` 或 `Envelope<OperationResult>`）。
- 好处：对人类/调试友好；代价是 server 需要做路由映射。

3) **SSE 专用端点**：`GET /sync/subscribe`
- 事件体统一 `ChangeBatch`

### 9.2 “操作级错误”与“请求级错误”
- 请求级错误：外壳 `ok:false`（例如 `meta.v` 不支持、body 非法 JSON）
- 操作级错误：外壳可 `ok:true`，但 `results[i].ok=false`

这条规则能让 batch 的部分失败与单操作的失败在语义上完全一致。

---

## 10. 兼容与演进策略（v 与 parser 的单一权威）

因为 vNext 明确 `meta.v`：
- server 必须返回其支持的 `v`，并对不支持的版本返回请求级错误。
- client 必须按 `meta.v` 解析；兼容逻辑只允许集中在 `protocol` 层（parser/compose），不要散落在 adapter 与业务编排中。

---

## 11. 与 SyncEngine / BatchEngine 的关系（实现层约束）

协议统一不意味着实现必须“一个大引擎”：
- `BatchEngine` 仍可专注“查询合并与 flush”（效率层）
- `SyncEngine` 专注“outbox + change feed + cursor + subscribe 生命周期”（一致性层）
- `HTTPAdapter` 只是组合根与委托者：路由请求到 REST/Batch/Sync，并把结果交给唯一的 `StateWriter` 回写本地

实现层只需要做到：
- transport 层统一 envelope 解析与错误模型
- 协议层提供统一的 types + parser + compose

---

## 12. 本协议的最大收益（为什么这套最优雅）

- 所有端点同一套 envelope：解析与错误处理“一次实现，到处复用”
- REST/Batch/Sync 同一套 Operation：业务编排与测试都更简单
- cursor/version/id 显式且稳定：跨端实现无需到处断言
- JSON Patch 标准化：第三方 adapter 与多语言实现成本显著降低
- pull/subscribe 统一 ChangeBatch：SyncEngine 代码结构极其干净

---

## 13. 下一步（建议的落地顺序）

1) 在 `src/protocol` 下创建 `vnext` 命名空间（或直接替换旧类型），先把 types 固化
2) server：先实现权威 `POST /ops` + `GET /sync/subscribe`（事件体改为 `ChangeBatch`）
3) client：先在 transport 统一 envelope，随后把现有 batch/sync/rest 的调用逐步迁移到 Operation 模型
4) 最后删除旧协议残留（一次性打断回退路径，避免长期双栈）

---

## 14. 实施 PR 计划（详细）

下面把 vNext 的落地拆成一组可以逐个合并、每步都可验证的 PR（允许破坏性变更，但仍建议每个 PR 都保持“协议/实现/测试”闭环）。

### PR-00：协议测试基线（必须先做）
- 状态：✅ 已完成（当前 PR）
- 新增：协议向量（固定 JSON 样例）与断言
  - 覆盖：`Envelope` 成功/失败、`StandardError`（含 `retryable/cause`）、`OpsRequest/OpsResponse`、`WriteOp/QueryOp/ChangesPullOp`、`ChangeBatch`、JSON Patch
- 新增：不变量测试
  - cursor 单调前进（客户端/服务端语义层都必须可证明）
  - `opId` 必填且请求内唯一（请求校验）
- 验证：`npm test`（新增 `tests/server/protocol/ProtocolVectorsVNext.test.ts` 或类似文件）
  - 已落地：
    - `tests/server/protocol/ProtocolVNextVectors.test.ts`
    - `tests/server/protocol/vnextVectors/*.json`

### PR-01：`src/protocol` 引入 vNext（types + compose + parse）
- 状态：✅ 已完成（当前 PR）
- 新增：`src/protocol/vnext/*`
  - `meta.ts`：Meta 定义与默认填充策略
  - `error.ts`：StandardError vNext（kind/retryable/cause/details union）
  - `envelope.ts`：统一 envelope 类型与构造器（ok/err）
  - `ops.ts`：Operation/OperationResult、OpsRequest/OpsResponse
  - `jsonPatch.ts`：JSON Patch 类型（RFC 6902 子集）与基础校验（可选）
  - `changes.ts`：Change/ChangeBatch 与 cursor 语义
- 已落地（新增文件）：
  - `src/protocol/vnext/index.ts`
  - `src/protocol/vnext/parse.ts`、`src/protocol/vnext/compose.ts`
  - `src/protocol/vnext/scalars.ts`、`src/protocol/vnext/jsonPatch.ts`
- 调整：`src/protocol/Protocol.ts` 增加 `Protocol.vnext.*` 出口
- 调整：`src/protocol/index.ts` 追加 vNext 类型导出（以 `VNext*` 前缀避免与 legacy 冲突）
- 暂时保留：旧 `protocol/http|batch|sync`，但在文档里标记为 “legacy”
- 验证：typecheck + tests（包含 PR-00 向量测试）

### PR-02：Server 最小闭环：新增权威 `POST /ops` + vNext SSE 事件体
- 状态：✅ 已完成（当前 PR）
- 新增：`POST /ops`
  - 输入：`OpsRequest`
  - 输出：`Envelope<{ results: OperationResult[] }>`
  - 初始支持：
    - `QueryOp`：映射到现有 rest/query 执行链路
    - `WriteOp`：映射到现有 write semantics（单条与批量 items）
    - `ChangesPullOp`：映射到现有 sync pull（返回 `ChangeBatch`）
- 调整：新增 `GET /sync/subscribe-vnext`
  - legacy 的 `GET /sync/subscribe` 保持不变（避免破坏现有行为）
  - vNext 的 SSE `data:` 事件体为 `ChangeBatch`（`{ nextCursor, changes }`，cursor 为 base10 string）
- 约束：请求级错误用 envelope `ok:false`；op 级错误用 result `ok:false`
- 验证：新增 server 侧集成测试（至少覆盖 query/write/pull 的 1-2 条路径）
  - 已落地：
    - 路由与服务：
      - `src/server/routes/ops/createOpsRoute.ts`
      - `src/server/services/ops/createOpsService.ts`
      - `src/server/routes/sync/createSyncSubscribeVNextRoute.ts`
      - `src/server/services/sync/createSyncService.ts`（新增 `subscribeVNext`）
    - 配置与插件：
      - `src/server/config.ts`（新增 `routing.ops.path` 与 `route.kind='ops'`）
      - `src/server/plugins/defaultRoutesPlugin.ts`（注册 `/ops` 与 `/sync/subscribe-vnext`）
      - `src/server/engine/errors.ts`（`route.kind='ops'` 顶层错误使用 HTTP envelope）
    - 测试：
      - `tests/server/OpsVNextRoutes.test.ts`

### PR-03：Client transport 全面统一 envelope（vNext 优先）
- 状态：✅ 已完成（当前 PR）
- 新增/调整：`transport` 在一个地方完成：
  - request meta 注入（traceId/requestId/deviceId、v）
  - response envelope 解析与错误归一化（请求级错误 vs 操作级错误）
- 调整：旧 `Protocol.http.parse.envelope` 的角色变更：
  - vNext 作为权威；legacy 的 parser 仅用于过渡（如果保留）
- 验证：typecheck + tests（尤其是 adapter events/observability 相关用例）
  - 已落地：
    - `src/adapters/http/transport/ops.ts`：新增 `/ops` transport（meta 注入 + 复用统一 pipeline/envelope）
    - `src/adapters/http/transport/pipeline.ts`：支持外部传入 trace（避免 requestId 不一致），并更健壮地解析 JSON（无 clone 也可工作）；`itemCount` 支持识别 `{ data: { results: [] } }`
    - `tests/adapters/http/OpsTransport.test.ts`：覆盖 meta 注入与请求级 envelope error 抛错

### PR-04：BatchEngine vNext 化：以 `/ops` 作为 flush 目标
- 改造：`BatchEngine` 聚合的是 `Operation`（至少 QueryOp）
- flush：`POST /ops`，返回 `results[]`，按 `opId` 拆包 resolve/reject
- 删除：batch 专用 response mapping（如 `mapResults` 的旧语义）或改为 vNext 适配层
- 验证：现有 batch 相关单测迁移到 vNext，保证 backpressure/flush 行为不变

### PR-05：新增独立 `SyncEngine`（vNext：outbox + change feed + cursor）
- 新增：`src/sync/*`
  - `OutboxStore`、`CursorStore`、`SyncTransport`、`SyncApplier`（或对接 `StateWriter`）
  - `start/stop/dispose/enqueue/flush/pullNow/subscribe` 的最小 API
- push：使用 `/ops` 提交 `WriteOp`（每个 item 必须有稳定 `idempotencyKey`）
- pull/subscribe：统一消费 `ChangeBatch`
- 验证：新增单测覆盖 outbox 幂等、cursor 单调前进、subscribe 重连（可用 mock transport）

### PR-06：HTTPAdapter 收敛为“固定委托管线”
- HTTPAdapter 只做路由与委托：
  - Query：`BatchEngine`（可选）或直接 `/ops`
  - Write：直接 `/ops` 或经 `SyncEngine.enqueue`（启用 sync 时）
  - Changes：由 `SyncEngine` 负责消费与回写
- hooks（若保留）只挂在 transport 边界（onRequest/onResponse/onError）
- 验证：adapter 端到端测试（包含 sync enabled/disabled 两条路径）

### PR-07：清理 legacy 协议与旧路由（一次性断尾）
- 删除/冻结：
  - legacy `protocol/sync/types.ts`、legacy batch response shape、legacy http envelope 兼容分支（按实际迁移情况）
- server：
  - 将旧 REST/batch/sync 路由映射到 `/ops`（或直接移除旧路由）
- 文档：
  - `HTTP_PROTOCOL.md` 与 vNext 文档对齐（若需要）
- 验证：全量测试 + typecheck
