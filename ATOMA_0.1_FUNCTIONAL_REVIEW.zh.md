# Atoma 0.1 功能评估（AtomaClient + React Hooks）

日期：2026-01-09  
范围：仅评估“功能是否足够开源为 0.1”，不讨论测试、文档、发布流程、API 稳定性承诺与许可证等。

---

## 1. AtomaClient（对外公共能力面）

`AtomaClient` 的对外形态非常克制，只有 4 个入口：

- `stores`：`client.stores.Todo` / `client.stores('Todo')` 返回某个资源对应的 store facade（无状态 CRUD API）
- `Sync`：同步引擎控制面（start/stop/pull/flush/status/dispose）
- `History`：撤销/重做控制面（undo/redo/canUndo/canRedo/clear）
- `Devtools`：客户端检查器（snapshot/subscribe + stores/indexes/sync/history 子面板）

从“0.1 开源”的角度，这种面向能力聚合的 API 结构优点是：学习成本低、组合方式明确；缺点是：很多关键语义藏在 `Store` 与其 options/约定里（但这不影响“功能是否存在”）。

---

## 2. Store：直接读写（`client.stores.<name>`）

### 2.1 CRUD/读写语义（来自 `IStore/CoreStore`）

**写入：**

- `addOne/addMany`
- `updateOne/updateMany`（`updateOne` 走 immer recipe）
- `deleteOne/deleteMany`
- `upsertOne/upsertMany`（支持 `upsert.mode` + `merge`）

**读取：**

- `getOne/fetchOne`：`getOne` 会命中本地 atom 缓存，否则走 `dataSource.bulkGet`（有批量合并队列）；`fetchOne` 强制走后端
- `getMany`：缓存命中优先，缺失部分批量 `bulkGet`；可选是否写回缓存（`cache=true/false`）
- `getAll`：直接读取后端 `getAll`，并对缓存做“全量对齐”（会移除本地缓存中不再出现的 id）
- `query`：若后端支持 `dataSource.query` 则走后端查询；否则 fallback 为 `getAll + 本地过滤/排序`

**缓存/引用稳定：**

- 读写回缓存时做了浅层引用保留（`preserveReferenceShallow`），对 React 渲染友好
- `CoreStore.reset()` 可以清空内存缓存（不触碰后端）

### 2.2 查询能力（filter/sort/page + 索引）

- `filter` 支持多种操作符：`eq/in/gt/gte/lt/lte/startsWith/endsWith/contains`，以及 `text(match/fuzzy)`（文本/分词/模糊距离）
- `sort` 支持单字段或多字段排序
- `page` 支持 offset/cursor 分页（`after/before/cursor` + `pageInfo`）
- 若配置了 `indexes`，查询会先走候选集收集（`collectCandidates`），可显著降低全表扫描成本；并在候选集“exact”时跳过二次 where 过滤

### 2.3 写入确认（optimistic vs strict）

所有写 API 都接收 `StoreOperationOptions`，核心是：

- `confirmation`：
  - `optimistic`（默认）：写入在“系统接管”后即 resolve（direct=持久化完成；outbox=enqueued 落盘完成）
  - `strict`：等待 `confirmed`（direct≈持久化完成；outbox=服务端写入结果/ack）
- `timeoutMs/timeoutBehavior`：strict 等待超时策略
- `opContext`：携带 `scope/origin/actionId/label`；用于 history 聚合与可观测性

## 3. writeStrategy：队列写入（`queue` / `local-first`）

不再提供“派生 store 入口”；队列语义通过每次写入的 `options.writeStrategy` 选择：

```ts
client.stores.Todo.addOne({ ... }, { writeStrategy: 'queue' })
client.stores.Todo.addOne({ ... }, { writeStrategy: 'local-first' })
```

关键语义（保持最少概念）：
- `queue`：写入转译为“意图”进入 durable outbox 队列（由 sync 引擎后续 push）；写入阶段默认禁止“缓存缺失时隐式补读”（避免 enqueue 阶段触网）
- `local-first`：先写本地 durable 再入队；允许本地补读

结论：**offline-first 的核心闭环是齐的：本地写 + 队列 + 稍后 push。**

---

## 4. Sync：复制/同步引擎（`client.sync`）

### 4.1 控制面能力

- `start(mode?)` / `stop()` / `dispose()`
- `status(): { started; configured }`
- `pull()`：确保启动后执行一次拉取
- `push()`：确保启动后执行一次推送（outbox -> remote）

`start` 支持模式：

- `pull-only` / `subscribe-only` / `pull+subscribe` / `push-only` / `full`

默认模式会根据配置推导：

- 若启用 subscribe 但后端不具备 subscribe 能力，会降级到 `pull-only`

### 4.2 引擎构成（功能点）

SyncEngine 由三条 lane 组成：

- **PushLane**：从 outbox 取 batch，发 `write` op；支持重试/退避；支持 `inFlight` 标记与超时回收；支持 rebase（服务端确认 version 后重写后续 baseVersion，减少离线连续写自冲突）
- **PullLane**：发 `changes.pull` op，拿 change batch 并调用 `applier.applyPullChanges` 落地；维护 cursor（单调前进）
- **NotifyLane**：subscribe（SSE 或自定义 subscribe）；收到 notify 后 schedule pull

### 4.3 持久化与多实例

- outbox 与 cursor 都会持久化到一个 KVStore：
  - 浏览器：IndexedDB（`atoma-sync-db`）
  - 非浏览器：内存 fallback（不 durable）
- 单实例锁（SingleInstanceLock）基于 KVStore 的 `lockKey`，防止同一 deviceId 多个实例同时 push/pull（多 tab 场景）

### 4.4 冲突策略（需要如实看待其“完成度”）

对外暴露 `conflictStrategy: 'server-wins' | 'client-wins' | 'reject' | 'manual'`，但从实际落地看：

- 写入被 reject 后会走 `remoteReject`，并在 `server-wins` + `CONFLICT` 时把 `current.value` 写回本地
- `client-wins/manual` 在当前实现中更像是“保留 reject 后的现状/等待上层介入”，并没有提供完整的交互闭环（例如自动重试、生成可处理的冲突对象、提供 hook/callback 让上层决策）

结论：**同步的“管道”完整，冲突处理的“产品化闭环”偏早期。作为 0.1 可开源，但需要明确定位为 preview。**

---

## 5. History：撤销/重做（`client.History`）

### 5.1 能力与语义

- `undo/redo` 按 `scope` 维护栈
- 记录粒度是“action”（同一 `actionId` 下的多次提交会被聚合为一个撤销单元）
- 只记录 `origin === 'user'` 的提交；undo/redo 的写入会标记 `origin: 'history'`，不会反向进入 history
- `actionId` 在未提供 `opContext` 时也会由 store 内部自动补齐，因此默认“开箱即用”

### 5.2 对上层的意义

- 这套 history 是“通用补丁回放”能力（patches + inversePatches），不局限于某个特定实体
- 通过 `createOpContext({ scope, label })` 可以把 UI 里一次“用户动作”跨多个 store 的写入聚合为一个 undo 单元

结论：**history 功能对 0.1 来说足够，且实现边界清晰。**

---

## 6. Devtools：可观测/检查器（`client.Devtools`）

提供：

- `snapshot()`：客户端快照（stores/indexes/sync/history + backend meta）
- `subscribe(fn)`：事件订阅（store/index 注册、sync 事件等）
- `stores/indexes`：list/snapshot（按 name 过滤）
- `sync/history`：单独 snapshot

机制上通过 runtime 监听 handle 创建来“自动注册 store/index 观察器”，并维护一个全局 registry，可被 `Devtools.global()` 枚举多 client。

结论：**对 0.1 开源非常加分：即使没有 UI，也提供了可嵌入自定义面板/日志的基础设施。**

---

## 7. React Hooks（`src/react/hooks`）能力盘点

### 7.1 本地订阅类

- `useValue(store, id, { include? })`：订阅单条；用 `selectAtom` 做细粒度更新；支持 relations include  
  - 注意：在 render 阶段若缓存缺失会触发 `store.getOne(id)`（副作用），在 React StrictMode 下可能导致重复请求/告警
- `useAll(store, { include? })`：订阅全量集合
- `useMultiple(store, ids, { unique/limit/selector/include? })`：订阅指定 id 集合；通过 `useShallowStableArray` 降低无效重算
- `useStoreQuery(store, { where/orderBy/limit/offset/select? })`：纯本地查询；会利用 store 的 indexes 做候选集收集

### 7.2 远端查询与混合策略

- `useRemoteFindMany({ store, options, behavior, enabled? })`
  - `behavior.hydrate=true`：把远端结果 hydrate 到 store（并更新 indexes）
  - `behavior.transient=true`：不写入 store，在 hook 内部维护 data
  - 有一个进程级 cache（`REMOTE_QUERY_CACHE`）做订阅与 in-flight 去重，但无 TTL/淘汰策略（长生命周期应用可能增长）
- `useFindMany(store, options + fetchPolicy + select?)`
  - `fetchPolicy: 'local' | 'remote' | 'cache-and-network'`
  - 支持 `include`（通过 `useRelations` 做关系投影与预取）
  - 当 `skipStore` 或 `fields` 存在时会强制走 transient，避免半字段对象污染 store
  - 返回 `loading/isFetching/isStale/error/pageInfo` + `refetch/fetchMore`

### 7.3 关系 include 与本地工具

- `useRelations(items, include, relations, resolveStore)`：
  - 会先 prefetch 关系（支持并发/超时/partial），再投影到返回数据
  - include 支持 `live=false` 的“快照关系”（避免子 store 变化引起父列表频繁抖动）
- `useLocalQuery(data, options, store?)`：对任意数组复用 core query（可注入 matcher）
- `useFuzzySearch(items, q, options)`：core fuzzySearch 的 memo 包装
- `useShallowStableArray`：浅比较稳定化数组引用

结论：**hooks 覆盖了 0.1 常见的 React 使用面：订阅单条/多条/全量、本地查询、远端查询、关系 include、以及 transient vs hydrate 的缓存污染控制。整体“够用”。**

---

## 8. 是否足够作为 0.1 开源？（仅功能角度结论）

### 8.1 结论（建议）

**功能层面可以作为 0.1 开源。**

理由：

- Store 能力闭环完整（CRUD + cache + query + indexes + relations）
- Offline-first 核心链路完整（writes 入队 + durable outbox/cursor + push/pull + subscribe notify）
- History/Devtools 属于“超出 0.1 预期”的加分项
- React hooks 足以支撑 demo 级到中等规模应用的主要数据访问方式

### 8.2 0.1 需要提前在开源说明里“明确边界”的点（不涉及测试/文档质量，只是功能风险）

- `conflictStrategy` 的 `client-wins/manual` 目前缺少完整闭环（更多像占位能力）；建议以“实验性/待完善”表述
- `useValue` 在 render 阶段触发 `store.getOne` 属于副作用：在 StrictMode 下可能重复触发请求/产生告警（建议 0.1 说明或后续改为 effect）
- `useRemoteFindMany` 的全局缓存无 TTL/淘汰：长时间运行可能增长
- outbox 写入对 `version/baseVersion` 有硬要求：如果用户数据模型不维护 version，离线 update/delete 可能无法工作（需在开源定位中说明）
- Sync 的 KV 持久化在非浏览器环境会退化为内存：Node 场景可能与用户预期不一致

如果把 0.1 明确定位为“React-first、offline-first 的数据层技术预览”，当前功能集合是成立的。
