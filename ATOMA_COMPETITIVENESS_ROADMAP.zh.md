# Atoma（Client + Server）竞争力提升与短板修复清单

日期：2026-01-09  
范围：聚焦“功能与产品闭环”，不讨论测试覆盖率、文档站点质量、CI/发布流程等（但会提到哪些点需要最小化示例/默认配置来避免踩坑）。

---

## 0. 你现在到底在做什么（建议的清晰定位）

Atoma 当前最强的定位不是“又一个 query/hooks 库”，而是：

- **离线优先的数据层（offline-first store）**：本地 atom/索引/关系投影 + 读写 API。
- **带 Outbox 的复制同步（replication with outbox + idempotency + changefeed）**：写意图入队、持久化 outbox/cursor、push/pull、subscribe notify。
- **可回放与可检查（history + devtools）**：undo/redo（action 聚合）、client inspector 快照与事件。
- **配套服务端工具链（server handlers + ORM adapters）**：统一协议（ops + changes.pull + subscribe）、幂等表、changes 表、Prisma/TypeORM 适配器。

竞争力来自“端到端闭环”，而不是单点能力。

---

## 1. 现状亮点（作为竞争卖点的部分）

### 1.1 Client 侧亮点
- `Store`：CRUD + `findMany`（本地索引候选集 + 远端可 hydrate/transient）+ `relations include` 投影与预取。
- `Outbox`：队列写（`queue` / `local-first`）与“禁止隐式补读”语义区分，能保证 enqueue 阶段不触网。
- `Sync`：push/pull/subscribe 的 lane 架构 + outbox/cursor 持久化 + single instance lock + outbox rebase（减少离线连续写自冲突）。
- `History`：按 `scope + actionId` 聚合的撤销/重做，且天然排除 sync/history origin 的写入回灌。
- `Devtools`：客户端快照 + store/index/sync/history 子面板，适合做调试面板/日志桥接。

### 1.2 Server 侧亮点（这是很多竞品做不到“开箱即用”的部分）
- `createAtomaHandlers()`：同一套 handler 覆盖 `ops`（POST 批量 query/write/changes.pull）+ `subscribe`（SSE）。  
- 插件体系完备：`ops/subscribe/op` 三层插件，op 层还能区分 `query/write/changes.pull`，利于对接你们现有的 auth、审计、配额、字段裁剪等逻辑（Atoma 本身不内置多租户/权限隔离框架）。
- Sync 必需基础设施已有：`changes` 表 + `idempotency` 表，write 会写入 replay（ok/error），天然支持重试幂等。
- 冲突信息已具备闭环原料：CONFLICT 会回传 `currentValue/currentVersion`（TypeORM 适配器已实现），协议也支持在 `WriteItemResult.current` 返回。
- Query 工程化：TypeORM 适配器支持 keyset cursor + 稳定排序 tie-breaker（避免分页漂移），并支持 fields 稀疏字段集。
- write 批处理：优先 bulkXX（create/update/upsert/delete），失败后降级逐条事务，仍保持 per-item 结果与幂等回放。
- Subscribe（SSE）实现可用：heartbeat/retry/maxHold + resources 过滤，适配器侧提供 `waitForChanges(cursor, timeout)`。

---

## 2. 关键短板（影响“能不能在真实项目跑”的点）

下面这些不是“缺功能”，而是“缺闭环/缺默认策略/缺一致性”，会直接影响口碑与竞争力。

### 2.1 Client 侧短板
1) **冲突处理缺闭环**  
对外暴露了 `conflictStrategy`（含 `client-wins/manual`），但实际产品化流程不足：缺少结构化冲突事件、冲突队列、重试策略、以及让上层介入决策的稳定接口。

2) **`useOne`（原 useValue）存在 render 阶段副作用风险**  
当前会在 render 里 cache miss 时触发 `store.getOne(id)`，在 StrictMode/并发渲染下容易重复触发请求，属于高频“这库不专业”的第一印象问题。

3) **远端查询缓存无 TTL/上限**  
`useRemoteFindMany` 的全局 cache 没有淘汰策略，长时间运行可能增长。

4) **Outbox 对 version/baseVersion 的硬要求需要“产品化约束”**  
离线 update/delete 需要 baseVersion，没版本就抛错，这是合理并发控制，但需要更明确的约束、以及更易用的“引导路径”（否则用户会觉得离线不可用）。

### 2.2 Server 侧短板
1) **`changes.pull` 的 resources 过滤未落实**  
协议支持 `resources?: string[]`，client 也会用；但 server 目前 pull 全量 changes 并返回，未做过滤。资源多、写入频繁或客户端订阅面广的场景会被放大。

2) **subscribe 依赖轮询（waitForChanges 250ms loop）缺少生产级策略**  
Prisma/TypeORM sync adapter 都是轮询实现：在高并发/大实例数下会带来 DB 压力与成本。

3) **changes/idempotency 表的生命周期治理缺失**  
没有明确的清理/裁剪策略（TTL、保留窗口、按最小活跃 cursor 裁剪），长期运行会膨胀。

4) **适配器能力不对齐**  
TypeORM 适配器对 CONFLICT 能返回 currentValue/currentVersion；Prisma 侧若做不到等价能力，冲突闭环会被削弱。

---

## 3. 优先级路线图（提升竞争力的最短路径）

按建议优先级分为 P0（立即）、P1（短期）、P2（中期）。

### P0（1–2 周内可落地，立刻提升口碑与可用性）

#### P0-1：实现 `changes.pull` 的 resources 过滤（Server）
- **目标**：减少无关 changes 下发；为规模化（资源更多、订阅面更广、写入更频繁）时的性能扩展打基础。
- **建议改动**：
  - server：在执行 `changes.pull` 时对 `pull.resources` 做过滤（至少在返回前过滤；更优是 adapter 级过滤）。
  - adapter：扩展 `ISyncAdapter.pullChanges(cursor, limit, resources?)`（可选参数），让 DB 层过滤更高效。
- **验收标准**：
  - 传 resources 时，只返回对应 resources 的 changes。
  - 未传 resources 时行为不变。

#### P0-2：把 `useOne` 的 cache miss 补读移出 render（Client）
- **目标**：避免 StrictMode 下重复请求、避免 render 阶段副作用。
- **建议改动**：
  - render 只读缓存；在 `useEffect` 中判断 miss 再触发 `getOne`。
  - 增加 in-flight 去重（同一个 store+id 并发只触发一次）。
- **验收标准**：
  - StrictMode 下不会在一次渲染周期触发重复 getOne。

#### P0-3：远端查询 cache 增加 TTL + 上限（Client）
- **目标**：长时间运行稳定。
- **建议改动**：
  - `REMOTE_QUERY_CACHE` 加 LRU/容量上限。
  - 使用 `FindManyOptions.cache.staleTime`（已有字段）作为 entry 过期时间；无该字段则用默认（例如 30–120s）。
  - 提供 `clearRemoteQueryCache()`（devtools/调试用）。
- **验收标准**：
  - cache 规模受控，过期后自动清理。

### P1（2–6 周，形成“同步闭环”差异化）

#### P1-1：冲突处理闭环（Client + Server 对齐）
- **目标**：把 `conflictStrategy` 从“配置项”变成“可用工作流”。
- **建议改动（Client）**：
  - 增加结构化事件：`sync:conflict`（resource/entityId/baseVersion/currentValue/currentVersion/localIntent/idempotencyKey）。
  - 增加冲突队列 API（最小）：`client.sync.conflicts()`（list/subscribe/resolve）。
  - 提供内置策略：
    - `server-wins`：自动应用 `currentValue` 并丢弃该 intent（你们现在接近这个，但需要保证一致与可观测）。
    - `client-wins`：自动把该 intent 重新入队（使用 `currentVersion` 作为新 baseVersion；必须生成新 idempotencyKey，避免命中旧 replay）。
    - `manual`：把冲突放进队列，交给上层 resolve（UI/业务规则）。
- **建议改动（Server）**：
  - 保证所有 ORM adapter 在冲突时都返回 `currentValue/currentVersion`（必要时先 read current）。
  - 将 CONFLICT 的 details 结构标准化（字段名一致、类型稳定）。
- **验收标准**：
  - 同一冲突能稳定复现并可被 resolve（server-wins/client-wins/manual）。
  - manual 模式上层能拿到足够信息完成 UI 合并。

#### P1-2：changes/idempotency 生命周期治理（Server）
- **目标**：生产可运行、成本可控。
- **建议改动**：
  - idempotency：基于 `expiresAt` 的清理策略（cron/job），并在读取时忽略过期（TypeORM/Prisma 已做忽略，但需要清理）。
  - changes：保留窗口（例如 N 天）或按“最小活跃 cursor”裁剪；提供索引建议。
- **验收标准**：
  - 长期运行不会无限增长；清理不会破坏活跃客户端 pull。

### P2（6–12 周，做“规模化体验”与生态竞争）

#### P2-1：subscribe 从轮询升级为事件驱动（Server/Adapter）
- **目标**：降低 DB 压力，提升实时性与成本效率。
- **建议改动**（按 DB）：
  - Postgres：LISTEN/NOTIFY（appendChange 时触发 notify），subscribeExecutor 可等待通知或超时 heartbeat。
  - MySQL/SQLite：保留轮询 fallback，但引入指数退避/抖动，避免固定 250ms。
- **验收标准**：
  - 高并发场景 subscribe 连接数上升时 DB QPS 不线性爆炸。

#### P2-2：标准化迁移与 schema（Server）
- **目标**：让 Prisma/TypeORM 的 changes/idempotency 表结构、索引、字段一致，减少生态碎片化。
- **建议改动**：
  - 提供官方 migration 模板与字段约束（含索引）。
  - Prisma 侧支持自定义 model 名（或提供统一约定与清晰错误）。

#### P2-3：更强的 observability（Client + Server）
- **目标**：降低排障成本，提高“工程感”。
- **建议改动**：
  - server：对每个 op/每个 write item emit 结构化事件（耗时、命中 bulk、冲突率、idempotency hit 等）。
  - client：devtools 增加冲突队列、远端查询 cache 状态、outbox 吞吐等指标。

---

## 4. Client 侧具体改进建议（按模块）

### 4.1 Sync/Outbox
- **冲突闭环**：见 P1-1。
- **outbox rebase 的可观测性**：当前 rebase 在 outbox store 内部进行，建议 emit devtools 事件（例如 `sync:rebase`），并附带 resource/entityId/old/new。
- **写入语义一致性**：
  - 明确 strict/outbox 的最终完成语义：strict 等待 server ack/reject；optimistic 等待 enqueue 落盘。
  - 对 `client-wins` 自动重试：必须新 idempotencyKey（避免命中旧 replay）。
- **baseVersion 约束的“用户体验”**：
  - 明确建议：所有 offline-first 资源必须带 `version:number`。
  - 提供一条“迁移/适配器建议”：服务端 write 默认让 version 自增、并在 returning 中返回。

### 4.2 React Hooks
- `useOne`：把 cache miss 的补读移到 effect；并做 in-flight 去重。
- `useRemoteFindMany`：cache TTL/LRU；提供手动清理 API。
- `fetchPolicy` 的语义一致性：
  - `cache-only`：不触发远端；仅订阅本地。
  - `network-only`：只用远端数据（transient 时直接返回 remote；hydrate 时返回本地 hydrate 后的结果需明确）。
  - `cache-and-network`：本地优先 + 背景刷新 + isStale。

### 4.3 Devtools/History
- Devtools 增加：
  - 冲突队列视图（若实现 P1-1）。
  - remote query cache 视图（命中率、entry 数、过期时间）。
- History 增加（可选）：
  - “action 组”的可视化字段（label/affected stores/patch count），便于调试。

---

## 5. Server 侧具体改进建议（按模块）

### 5.1 ops（query/write/changes.pull）
- **changes.pull resources 过滤**：见 P0-1。
- **write 的一致性与性能**：
  - bulk 路径成功时，保证每个 item 的 replay 都可写入 idempotency（当前已做）。
  - 对 `returning/select` 做更严格的适配器约束：即使 `returning=false`，也必须保证 `version` 可被返回（你们已在 server 侧强制 upsert/update returning=true 来拿 version，这很好）。
- **安全与稳定性**：
  - limits 默认值建议更保守（bodyBytes/maxOps/maxLimit），并在错误 details 中稳定返回 max/actual，方便用户定位。

### 5.2 subscribe（SSE）
- **轮询优化**：
  - 默认 250ms 轮询过激，建议改为可配置且带退避（空转时逐渐拉长）。
  - 对同一 resources 的多个连接做共享（可选：在 adapter 层实现事件总线）。
- **资源过滤与聚合**：目前会把 hold 期间的资源聚合后 notify，这个方向正确；建议把 `minNotifyIntervalMs` 与合并策略开放为配置（生产可调）。

### 5.3 adapters（Prisma/TypeORM）
- **能力对齐**：
  - Prisma 与 TypeORM 都要能在 CONFLICT 时返回 currentValue/currentVersion（否则 manual/client-wins 难做）。
- **索引与 schema**：
  - changes 表：`cursor` 主键/自增 + 索引；（可选）`resource,cursor` 复合索引（当做 resources filter 时）。
  - idempotency 表：`idempotencyKey` 唯一索引 + `expiresAt` 索引（用于清理）。

---

## 6. 建议的“对外能力表述”（提升竞争力的表达方式）

把 Atoma 说成三件事的组合，而不是单点：

1) **Client store**：本地状态与查询（indexes/relations），可选远端 hydrate/transient。  
2) **Replication**：outbox（intent）+ idempotency + changefeed（pull/subscribe）+ 冲突回传。  
3) **Server toolkit**：统一 handler、ORM 适配器、插件体系、限流与可观测性。

这能让用户理解：你们解决的是“离线写入 + 可恢复同步 + 工程化服务端接入”，不是“请求缓存”。

---

## 7. 最小里程碑建议（不含测试/文档，只含功能与默认策略）

### v0.1.1（补齐“生产最容易卡”的点）
- server：`changes.pull` 支持 resources 过滤（至少 response 过滤）。
- client：`useOne` 移除 render 副作用；remote query cache TTL/LRU。

### v0.2（形成明确差异化）
- 冲突处理闭环（events + queue + resolve API + adapter 对齐）。
- changes/idempotency 生命周期治理（清理/裁剪策略 + 索引建议）。

### v0.3（规模化）
- subscribe 事件驱动（PG LISTEN/NOTIFY 等）+ 轮询退避 fallback。
- 更强的可观测与运行时指标（冲突率、idempotency 命中率、push/pull 吞吐、subscribe 连接健康度等）。

---

## 8. 一句话总结

你们现在已经具备“端到端同步数据层”的骨架；要把竞争力做实，关键不是再加新 feature，而是把 **冲突处理、subscribe 成本、pull 过滤、生命周期治理** 这四个闭环打磨到用户不踩坑。
