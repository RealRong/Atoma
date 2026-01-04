# Atoma 端到端架构说明（client → protocol → server）

本文从 **client 创建**开始，串起 **core mutation**、**batch**、**sync**、**datasource → ops**、**backend 传输**、**server handlers/adapter**，并解释全链路的 **protocol 一致性** 与 **observability**，最后补充 **React 等多框架适配**的思路。

> 关键共识：`atoma/server` 是“协议内核”，只认 Web `Request`/`Response`，默认暴露 `ops()`/`subscribe()` 两个 handler，不做宿主框架适配、不内置 authz/policies（见 `SERVER_REFACTOR.zh.md:1`）。

---

## 0. 一句话全链路

用户在 UI/业务代码里调用 `Store.addOne/updateOne/...` → core 生成 patches 并走 mutation pipeline → persister 选择直连（Direct）或入 outbox（Outbox）→ datasource（例如 `HttpDataSource`）把读写意图编码成 `Protocol.ops` 的 `Operation[]` → backend（`OpsClient`）用 HTTP POST 发到 `/ops` 并用 `Protocol.ops.parse.envelope` 解包 → server 侧 `createAtomaHandlers().ops(request)` 解析 ops 并调用 `IOrmAdapter/ISyncAdapter` → 返回标准 envelope；同步场景由 client `sync`（push/pull/subscribe SSE）驱动，server `subscribe()` 输出 SSE `changes` 事件。

---

## 1. Client 创建：从 `defineEntities` 到 `defineClient`

入口是顶层 API：

- `defineEntities()`：声明实体集合
- `.defineStores(stores?)`：可覆盖某些 store 的配置/relations
- `.defineClient({ backend, remote, sync, defaultDataSourceFactory? })`：实例化 client

代码位置：

- `src/client/createAtomaClient.ts:1`（`defineEntities/defineClient`）
- `src/client/types.ts:1`（`DefineClientConfig/AtomaClient`）

默认行为（没有自定义 `defaultDataSourceFactory` 时）：

- 为每个 resource 创建一个 `HttpDataSource`（ops 协议），绑定：
  - `backend.opsClient`（传输层）
  - `resourceName`（用于 ops 路由）
  - `remote.batch`（是否开启 batch 合并）
  - `remote.usePatchForUpdate`（update 用 patch 或 replace）

对应代码：`src/client/createAtomaClient.ts:1`。

同时 client 会创建：

- `HistoryController`（历史/回放，略）
- `SyncController`（sync 生命周期 + 把 mutation 切换成 outbox 模式）

对应代码：`src/client/createAtomaClient.ts:1`、`src/client/controllers/SyncController.ts:1`。

---

## 2. Core：mutation 怎么从“调用 API”变成“patches + 持久化”

### 2.1 Store API 触发 mutation

以 `updateOne` 为例：

1) 从缓存或 datasource 拉取 base（必要时写回 cache）
2) 用 `immer.produce` 计算新值
3) `services.mutation.runtime.beginWrite()` 生成 ticket（含 idempotencyKey/clientTimeMs 等写元数据）
4) `BaseStore.dispatch({ type, data, ticket, opContext, onSuccess/onFail })`
5) 等待 `services.mutation.runtime.await(ticket)`（可选：上层 `await` 保证落盘/入队语义）

对应代码：

- `src/core/store/updateOne.ts:1`
- `src/core/store/addOne.ts:1`
- `src/core/createCoreStore.ts:1`

### 2.2 Scheduler：同一 action 的操作如何合并

`MutationPipeline` 内部有一个 `Scheduler`：

- 将同一个 atom（store）的事件收集到微任务队列
- 再按 `opContext` 分段（`scope|origin|actionId`）保证“同一次 action”能被规划成一个 plan

对应代码：`src/core/mutation/pipeline/Scheduler.ts:1`、`src/core/operationContext.ts:1`。

### 2.3 Executor：plan、commit、persist、rollback

`Executor.run()` 的关键点：

- `planner.reduce` 产出 `plan`（patches/inversePatches/changedFields 等）
- 先 `committer.prepare`（准备回滚信息）
- 进入 `beforePersist` middleware 链（这是 sync/outbox 切换点）
- persist 成功后 commit；失败则 rollback

对应代码：`src/core/mutation/pipeline/Executor.ts:1`、`src/core/mutation/hooks.ts:1`。

### 2.4 Persister：Direct vs Outbox（sync 的切换点）

默认 direct：

- 优先调用 `dataSource.applyPatches(patches, metadata, ctx)`（如果实现）
- 否则退化为 `bulkCreate/bulkPut/bulkDelete` 等

对应代码：`src/core/mutation/pipeline/persisters/Direct.ts:1`。

sync 启用后（`SyncController.start()`），会安装 `beforePersist` middleware，把 direct persist 替换为 outbox：

- 把 write intent 编码成 ops 的 `write`（create/update/patch/delete）
- enqueue 到 `SyncEngine` outbox

对应代码：

- `src/client/controllers/SyncController.ts:1`（`beforePersist` 安装）
- `src/core/mutation/pipeline/persisters/Outbox.ts:1`（编码 write intent 并 `sync.enqueueWrite`）

### 2.5 Core 缓存：`Map<id, entity>` + 增量写入 + 索引维护

Atoma 的“缓存”不是单独的缓存模块，而是每个 store 持有的 **Jotai atom**：

- `createCoreStore()` 内部创建 `objectMapAtom = atom(new Map<StoreKey, T>())`
- 所有读写最终都围绕这个 map：本地读取、远端写回、关系投影、索引维护

对应代码：`src/core/createCoreStore.ts:1`、`src/core/store/runtime.ts:1`。

缓存写入的关键点：

- `commitAtomMapUpdateDelta/commitAtomMapUpdate` 负责：
  - `jotaiStore.set(atom, after)`
  - 同步维护索引（`indexes.applyChangedIds/applyMapDiff`）
  - （可选优化）读路径优先用索引缩小候选集，避免全表扫描

对应代码：`src/core/store/cacheWriter.ts:1`、`src/core/indexes/StoreIndexes.ts:1`、`src/core/store/runtime.ts:1`。

为减少 UI 无效刷新，写回时会做“浅层引用复用”：

- `preserveReferenceShallow(existing, incoming)`：当对象字段浅比较相等时复用旧引用（避免 React 订阅的 map value 频繁变动）

对应代码：`src/core/store/preserveReference.ts:1`、`src/core/store/findMany/index.ts:1`、`src/core/store/writeback.ts:1`。

同步/远端写回走统一入口：

- `Core.store.writeback.applyStoreWriteback(handle, { upserts, deletes, versionUpdates })`：把远端实体/删除/`entity.version` 字段写回 map，并维护索引

对应代码：`src/core/store/writeback.ts:1`。

### 2.6 Core 查询：`findMany` 的本地评估、索引加速与缓存写策略

`findMany` 的读路径是“本地先算一遍（可用索引加速）→ 再走 datasource（如果有）→ 决定是否写回缓存”：

1) **本地评估**（local evaluate）
   - `indexes.collectCandidates(where)` 得到候选 id（`exact/superset/empty/unsupported`）
   - 再用 `Core.query.applyQuery()` 做 where/orderBy/offset/limit（含 Top-K 优化）

对应代码：`src/core/store/findMany/localEvaluate.ts:1`、`src/core/indexes/StoreIndexes.ts:1`、`src/core/query/index.ts:1`、`src/core/query/QueryMatcher.ts:1`。

2) **远端查询（可选）**
   - 如果 datasource 实现了 `findMany`，会把 options 传给 datasource（默认 HttpDataSource → ops query）
   - 返回值会被 `normalizeFindManyResult()` 统一成 `{ data, pageInfo?, explain? }`

对应代码：`src/core/store/findMany/index.ts:1`、`src/core/store/findMany/normalize.ts:1`。

3) **缓存写策略（cache policy）**
   - `options.skipStore === true`：完全不写回 map（只把结果当作 transient snapshot）
   - `options.fields`（稀疏字段）存在时也会强制 `effectiveSkipStore`，避免把“半字段对象”污染到 store 的完整实体缓存

对应代码：`src/core/store/findMany/cachePolicy.ts:1`、`src/react/hooks/useFindMany.ts:1`。

4) **观测与 explain**
   - `findMany` 会 emit `query:start/query:index/query:finalize/query:cacheWrite` 等事件
   - `options.explain === true` 时会返回 explain（含索引候选、最终过滤统计、远端耗时等）

对应代码：`src/core/store/findMany/index.ts:1`、`src/core/store/findMany/paramsSummary.ts:1`、`src/observability/types/public.ts:1`。

### 2.7 Indexes：声明、维护与查询计划

索引属于 store 的“可选加速层”：

- 用户在 `createCoreStore({ indexes: [...] })` 声明索引定义
- `StoreIndexes` 包装 `IndexManager`，并在缓存写入时被动更新（增量更新或全量 diff）
- 查询时通过 `collectCandidates(where)` 给 `findMany` 提供候选集与查询计划（plan）

对应代码：`src/core/createCoreStore.ts:1`、`src/core/indexes/StoreIndexes.ts:1`、`src/core/indexes/IndexManager.ts:1`、`src/core/indexes/types.ts:1`。

索引实现类型（按字段/文本等）位于：

- `src/core/indexes/implementations/*:1`

### 2.8 Relations：定义、prefetch 与投影（include）

Atoma 的 relations 分两件事：

1) **定义关系（schema）**
   - 用 builder 定义：`belongsTo/hasMany/hasOne/variants`
   - 关系本质是“如何用 source 的 key 找到 target store 的 items”，不做数据库 join

对应代码：`src/core/relations/builders.ts:1`、`src/core/createCoreStore.ts:1`、`src/client/types.ts:1`。

2) **include 的执行：prefetch + project**
   - `RelationResolver.prefetchBatch()`：根据 include 计算目标 store 查询，并并发触发 `store.findMany(...)` 预取
   - `projectRelationsBatch()`：从相关 store 的 `Map` 读取数据，把关系字段投影到返回 items 上（支持 live/snapshot 两种 include 模式）

对应代码：`src/core/relations/RelationResolver.ts:1`、`src/core/relations/projector.ts:1`、`src/react/hooks/useRelations.ts:1`。

> 注意：relations 的默认实现是“客户端 join/投影”，而不是 server 端 join；这也是为什么 `skipStore/fields` 等策略需要避免污染实体缓存。

### 2.9 其他 core 能力（简述）

- **History（undo/redo）**：基于 patches/inversePatches，按 `scope + actionId` 聚合 action，支持 `origin: 'history'` 的回放语义：`src/core/history/HistoryManager.ts:1`
- **Search（fuzzy search）**：独立于 ops/sync 的本地搜索工具：`src/core/search/index.ts:1`

---

## 3. DataSource：如何把“读写接口”转成 `Operation[]`

在 ops 形态下，核心是 `OperationRouter`（HTTP datasource 的“协议路由器”）：

- `findMany/get/getAll/bulkGet` → `Operation(kind='query')`
- `put/bulkPut/bulkCreate/delete/bulkDelete/applyPatches` → `Operation(kind='write')`
- `applyPatches` 会按 id 分组、决定 create/update/patch/delete 的最小集合

对应代码：`src/datasources/http/adapter/OperationRouter.ts:1`。

`HttpDataSource.executeOps()` 会把 ops 包装成 `OpsRequest`：

- `meta: { v: 1, clientTimeMs: Date.now() }`
- `ops: Operation[]`

并在有 `ObservabilityContext` 时，为每个 op 注入 `op.meta.traceId/requestId`（用于 server 端把错误与 trace 关联起来）。

对应代码：`src/datasources/http/adapter/HttpDataSource.ts:1`。

---

## 4. Batch：在 client 侧把多次 ops 合并成更少的请求

当 `remote.batch` 开启时，`HttpDataSource` 会创建 `BatchEngine`：

- Query lane：合并查询 ops（并发默认 2）
- Write lane：合并写 ops（并发默认 1，且校验 `write.items` 的 maxBatchSize）

最终仍走同一个 `OpsClient.executeOps()` 传输。

对应代码：`src/batch/BatchEngine.ts:1`、`src/datasources/http/adapter/HttpDataSource.ts:1`。

---

## 5. Sync：push / pull / notify（SSE）如何驱动一致性

### 5.1 触发：SyncController 把 mutation 改为 outbox

`SyncController.start()` 后：

- 所有写操作会在 `beforePersist` 被 `OutboxPersister` 截获并入队
- `SyncEngine` 的 push lane 负责把 outbox items 打包成 `write` op 发到 server

对应代码：`src/client/controllers/SyncController.ts:1`、`src/sync/engine/SyncEngine.ts:1`、`src/sync/lanes/PushLane.ts:1`。

### 5.2 Pull：`changes.pull`（轮询拉取）

`PullLane` 会构造 `Operation(kind='changes.pull')`：

- `{ cursor, limit, resources? }`
- server 返回 `ChangeBatch`（`nextCursor + changes[]`）

对应代码：`src/sync/lanes/PullLane.ts:1`。

### 5.3 Notify：SSE `sync.notify`（通知触发 Pull）

`NotifyLane` 默认用 `EventSource` 订阅：

- event 名固定 `Protocol.sse.events.NOTIFY`（`event: sync.notify`）
- data 解析用 `Protocol.sse.parse.notifyMessage`（`NotifyMessage`）
- 收到通知只触发 `SyncEngine.schedulePull({ cause: 'notify' })`；不 apply、不写 cursor

对应代码：`src/sync/lanes/NotifyLane.ts:1`、`src/protocol/sse/format.ts:1`。

### 5.4 Apply：把远端变化写回 core

当收到 pull 的 changes 或 write ack/reject：

- `SyncController.applyPullChanges()`：按 resource 分发到对应 store，触发 `mutation.control.remotePull()` 并批量 `bulkGet` 拉取实体，再写回 cache
- `applyWriteAck/applyWriteReject`：写回 ticket 状态，并触发 `remoteAck/remoteReject`

对应代码：`src/client/controllers/SyncController.ts:1`、`src/core/mutation/MutationPipeline.ts:1`。

---

## 6. Backend：如何把 ops 发到 server（HTTP + envelope）

### 6.1 后端配置解析

`backend` 支持：

- 字符串 baseURL（默认 HTTP）
- `backend.http`（可配 opsPath/subscribePath/headers/retry/fetchFn/interceptors）
- 自定义 `opsClient`（高级用法）

对应代码：`src/client/backend.ts:1`。

### 6.2 HttpOpsClient 与传输

`HttpOpsClient.executeOps()`：

- POST `${baseURL}${opsPath}`（默认 path 由 `Protocol.http.paths.OPS` 决定）
- body：`{ meta, ops }`
- response：用 `Protocol.ops.parse.envelope` 解析成 `Envelope<OpsResponseData>`

对应代码：`src/backend/http/HttpOpsClient.ts:1`、`src/backend/http/transport/opsTransport.ts:1`、`src/backend/http/transport/jsonClient.ts:1`。

### 6.3 重试与观测

- 重试：`fetchWithRetry`（由 `backend.http.retry` 控制）
- telemetry：若 `ObservabilityContext.active`，会 emit：
  - `datasource:request`（method/endpoint/attempt/payloadBytes）
  - `datasource:response`（ok/status/durationMs/itemCount）

对应代码：`src/backend/http/transport/retryPolicy.ts:1`、`src/backend/http/transport/telemetry.ts:1`。

---

## 7. Server：handlers + core executors + adapters（PR5 极简形态）

### 7.1 接入方式：宿主框架自己路由与适配

server 入口是 `createAtomaHandlers(config)`：

- `handlers.ops(request: Request) -> Response`
- `handlers.subscribe(request: Request) -> Response`（SSE）

宿主（Express/Next/Koa/Cloudflare Workers 等）负责：

- 路由：把 `/ops`/`/sync/subscribe`（或自定义路径）映射到对应 handler
- 适配：把宿主请求转换成 Web `Request`，把 Web `Response` 写回

对应代码：`src/server/createAtomaHandlers.ts:1`，示例见 `demo/zero-config/src/server/index.ts:1`。

### 7.2 ops：解析、执行、返回 envelope

server `opsExecutor` 做的事：

- 解析 body（`meta.v` + `ops[]`）
- 校验 limits（maxOps/maxQueries/maxBatchSize 等）
- `query` → `adapter.orm.findMany(resource, params)`
- `write` → `executeWriteItemWithSemantics(...)`（可选：sync/idempotency/changes 记录）
- `changes.pull` → `adapter.sync.pullChanges(cursor, limit)`
- 返回：`Protocol.ops.compose.ok({ results }, metaOut)`

对应代码：`src/server/core/opsExecutor/index.ts:1`、`src/server/core/opsExecutor/write.ts:1`、`src/server/core/write.ts:1`。

### 7.3 subscribe：SSE notify（不下发 changes）

server `subscribeExecutor`：

- `GET` + 可选 `resources` query（逗号分隔或重复参数）
- `adapter.sync.getLatestCursor()` 作为起始 cursor
- `adapter.sync.waitForChanges(cursor, maxHoldMs)`
- 服务端 100ms 合并一次通知（资源名 union）
- 用 `Protocol.sse.format.*` 产出 SSE 字符串流（`retry`/`comment hb`/`event: sync.notify`）

对应代码：`src/server/core/subscribeExecutor.ts:1`。

---

## 8. Protocol 一致性：同一份 `#protocol` 贯穿 client 与 server

Atoma 的“协议一致性”不是靠约定文档，而是靠同一个 `src/protocol/*` 模块：

- HTTP paths：`src/protocol/http/constants.ts:1`（`/ops`、`/sync/subscribe`）
- Ops 类型：`src/protocol/ops/types.ts:1`（`Operation/OperationResult/OpsRequest/OpsResponseData`）
- Envelope：`src/protocol/envelope/compose.ts:1`、`src/protocol/envelope/parse.ts:1`
- SSE：`src/protocol/sse/constants.ts:1`、`src/protocol/sse/format.ts:1`
- Trace 传递（禁止 header）：
  - ops：`op.meta.traceId` / `op.meta.requestId`（op-scoped，支持 batch mixed trace）
  - subscribe（SSE）：URL query `traceId` / `requestId`

client（datasource/backend/sync）与 server（handlers/executors）都通过 `#protocol` 共享这些类型与 parse/compose 逻辑，从而保证：

- “发出去的请求”和“解析回来的响应”遵循同一 schema
- SSE event name 与 payload schema 不漂移
- 版本号（`meta.v`）在解析处统一校验（当前 v=1）

---

## 9. Observability：从 store 到网络到 server 的关联方式

Atoma 的观测体系是**轻量级、以 traceId 为主键的 debug/telemetry**：

### 9.1 Client：store 级别 ObservabilityContext

每个 store handle 都有 `ObservabilityRuntime`：

- `handle.createObservabilityContext()` 创建 `ObservabilityContext`
- `ctx.traceId` 作为跨模块关联 key
- `ctx.emit(type, payload)` 产出 debug events（可采样/可脱敏）

对应代码：`src/core/store/runtime.ts:1`、`src/observability/runtime/ObservabilityRuntime.ts:1`。

`HttpDataSource` 会把 trace 注入到每个 op 的 `meta.traceId/requestId`（server 侧可据此把 op 级别错误与 trace 关联）。

对应代码：`src/datasources/http/adapter/HttpDataSource.ts:1`。

### 9.2 Backend：请求级 telemetry

当 `ObservabilityContext.active` 时，HTTP 传输层会 emit `datasource:request/response`（含 payloadBytes/durationMs/status）。

对应代码：`src/backend/http/transport/telemetry.ts:1`。

### 9.3 Server：request/runtime + hooks + debug scope

`createAtomaHandlers()` 每个请求会创建 runtime，并 emit：

- `server:request`（method/pathname）
- `server:error`（message）

并支持 hooks：`onRequest/onResponse/onError`（用于接入你们自己的 logger/trace 系统）。

对应代码：`src/server/createAtomaHandlers.ts:1`、`src/server/runtime/createRuntime.ts:1`。

> 重要说明：server 的 request 级 `traceId/requestId` 默认来自请求 header（`x-atoma-*`），未提供时会由 server runtime 生成；而 op 级别的 trace 信息来自 `op.meta`（client 注入）。两者可以共存：request 级用于 server 日志与 hooks，op 级用于 ops results 中的错误关联。

---

## 10. 多框架适配：React 只是“读写 core store”的一层薄适配

### 10.1 React：`atoma/react`

React hooks 的定位：

- 用 `jotai` 订阅 `storeHandle.atom`（`Map<id, entity>`）
- 调用 `store.getOneById/findMany/...` 驱动数据加载
-（可选）关系 include：通过 `useRelations` 组合多个 store 的读取

对应代码：

- `src/react/hooks/useValue.ts:1`
- `src/react/hooks/useFindMany.ts:1`

### 10.2 非 React（Vue/Svelte/Solid/Node 等）

因为 core store 的“状态载体”是 `jotaiStore + atom`，所以非 React 的适配通常有两条路：

1) **继续用 Jotai**：在框架里订阅 atom（或桥接到该框架的响应式系统）
2) **只用命令式 API**：直接调用 `store.findMany/addOne/updateOne/...`，状态读写交给你自己的状态容器（但这样会绕开 Atoma 的缓存/索引优势）

建议策略：

- UI 框架适配尽量只做“订阅 atom + 调用 store 方法”，不要复制 mutation/sync/batch 的实现
- `#protocol` 与 `#observability` 作为跨端公共依赖，避免“请求/响应/事件格式”在不同框架里重新手写一遍
