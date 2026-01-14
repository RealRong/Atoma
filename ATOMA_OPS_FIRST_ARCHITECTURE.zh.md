# Atoma：Ops-first 架构（移除 `IDataSource`/`OpsDataSource`/`src/bridges`，不留兼容层）

目标：把“持久化/远端交互”的唯一抽象收敛为 `OpsClient.executeOps(...)`，让 Atoma 的核心链路只围绕 **Ops 协议**工作；不保留兼容层（允许破坏式变更），以最低心智成本获得可扩展性与一致性。

这份文档比 `ATOMA_BACKEND_OPTIMAL_ARCHITECTURE.zh.md` 更激进：那份建议“Translator 内置到 client”，而这里建议 **直接移除 Translator（`IDataSource`）**，让 core 直接产出/消费 ops，并明确删除 `src/bridges`，不保留兼容层。

---

## 1. 现状（截至 2026-01-14：已完成 Phase 3）

当前仓库已经进入 **Ops-first**：

1) **direct（直连）路径**
- `src/core` 写入/查询 → 直接组装 `Operation(query/write)` → `StoreHandle.backend.opsClient.executeOps(...)` → HTTP/IndexedDB/Memory transport
  - 读侧：`src/core/store/internals/opsExecutor.ts`（`executeQuery/executeOps`）
  - 写侧：`src/core/mutation/pipeline/persisters/Direct.ts`（组装 `WriteOp` + 解析 `WriteResultData`）

2) **outbox（入队）路径**
- `src/core/mutation/pipeline/persisters/Outbox.ts`：把写入 encode 为 ops intent（`Protocol.ops.encodeWriteIntent(...)`）→ outbox 存储/同步引擎推送时发 `write` op

差异点（Phase 3 已统一关键合同，入口差异保留）：
- direct 与 outbox 都走 ops，但编码入口不同（direct 直接组装 `WriteOp`，outbox 先 encode intent 再入队）——这是实现差异，不再影响协议合同。
- `WriteItem.meta` 的生成/补齐策略已统一：发送前必须具备 `idempotencyKey + clientTimeMs`，并且同一次发送内每个 item 的 `idempotencyKey` 必须唯一（见 `Protocol.ops.meta.*` + PushLane 的兜底补齐与校验）。

---

## 2. 核心结论（Ops-first）

把 ops 协议定义为 Atoma 的“原生后端契约”：
- **唯一后端接口：** `OpsClient.executeOps({ ops, meta, context, signal })`
- **唯一持久化/查询表达：** `Operation(kind='query'|'write'|'changes.pull')`

因此（明确删除清单，不留兼容层；已完成）：
- 已删除 `IDataSource<T>` 以及 `OpsDataSource`。
- 已删除 `src/bridges/**`（目录不再作为入口存在）。
- 已把 runtime 注入从 `dataSourceFactory` 改为 `backendFactory`（返回 `{ key, opsClient }`）。
- 删除/迁移 `StoreKey`（详见 §5.6：统一前后端 id 类型为 `string`）。
- core 的 persister/query 直接生成 ops 并调用 `OpsClient`（准确说是 `OpsClientLike` 结构类型）。

这个选择会让 `src/core` 与 `#protocol/#backend` 产生依赖（“协议入侵 core”），但换来最直观的学习路径：**只学 ops**，不再需要理解“另一个抽象层”。

---

## 3. 推荐分层（最少概念版本）

锁死依赖方向为：

`core (store/mutation/query)` → `protocol (Operation/Result)` → `backend (OpsClient transports)`

约束：
- `backend` 只负责“怎么发/怎么 batch/怎么重试/怎么拦截”，不懂 store 语义。
- `core` 只做“什么时候发哪些 ops、如何把结果写回本地缓存/版本”。
- `protocol` 只提供类型 + Atoma 约定的字段含义（meta/idempotency 等）。

---

## 4. 建议的最小 API 面（对学习者友好）

### 4.1 对外（public）
- `createClient(...)` / `client.Store('resource')`
- `Backend.HttpOpsClient / Backend.IndexedDBOpsClient / Backend.MemoryOpsClient / Backend.OpsClient`
- （可选）batch/retry/interceptors 都作为 `OpsClient` 的配置或装饰器，不单独暴露“BatchEngine”概念

### 4.2 对内（internal）
- 不再引入“资源级 client 类”（避免再造一个 `Resource*Client` 概念）。
- 直接使用少量函数式 helper（core 内部使用，不对外暴露）：
  - `executeQuery(handle, params, ctx)`：发 `QueryOp`
  - `executeOps(handle, ops, ctx)`：发 ops 批量（direct/sync 内部都可复用）

命名说明：
- `OpsClient`：transport 级（怎么发到 HTTP/DB/内存）。
- `StoreHandle.backend`：store 级绑定（把 `resource` 固定为 `storeName`，把 `opsClient` 固定为 runtime 注入的 backend）。

---

## 5. 必须一次性整理清楚的“坑”（高频踩坑清单）

下面这些不是实现细节，而是“如果不先定规则，一定会反复踩”的系统性坑。

### 5.1 `getAll` 语义与协议分页不匹配（强烈建议移除或改名）

现状坑：
- 你现在的 `normalizeAtomaServerQueryParams` 会在没传 `limit` 时默认 `limit=50`。
- 若保留 `getAll()` 且实现为“发一次 query”，远端永远拿不到全量（只拿到前 50）。

Ops-first 规则（按你的决定：宁可爆炸也不做隐式分页）：
- **移除 `limit=50` 的隐式默认值**：当 `QueryParams.limit` 未提供时，服务端与本地实现都应视为“无上限”，直接返回全部匹配数据。
- `getAll()`/“不带 limit 的 findMany()”都将变成潜在的全量拉取：数据量爆炸由调用方自行承担。
- cursor 分页（after/before）仍建议要求显式 `limit`；如果调用方不传，则允许实现层提供一个保守默认值（仅用于 cursor 分页），但绝不能再影响 `getAll`。

### 5.2 `where` 的“双语义”必须明确：本地函数 vs 远端对象

Atoma 的 `FindManyOptions.where` 允许是 function（本地过滤），但 ops 只能接收 plain object。

必须定清：
- 远端只接受对象 where；function where 永远不会发到服务端。
- 如果希望“同一段代码本地/远端一致”，就需要给出可序列化的 where DSL，并禁止 function where 走远端。

### 5.3 版本模型：`baseVersion` 是硬约束，不是可选优化

当前实现里，多个路径都强依赖 `version/baseVersion`：
- `update` 必须带 `baseVersion`（通常来自实体上的 `version`）。
- `delete(forceRemove)` 必须带 `baseVersion`。
- outbox enqueue update/delete 也同样需要它。

如果你的产品目标包含离线队列（outbox），那就必须接受一个事实：
- **实体必须有 `version`，否则离线 update/delete 无法可靠工作。**

Ops-first 下建议把这条变成“系统级不变量”并写进错误信息与文档（不要把它留成运行时 surprise）。

### 5.4 meta 的三层结构必须统一（否则重试/追踪会乱）

目前存在三种 meta：
- request meta：`ExecuteOpsInput.meta`（一次请求级）
- op meta：`Operation.meta`（每个 op 级）
- write item meta：`WriteItem.meta`（每个 item 级，影响幂等与回放）

建议的强规则：
- **幂等相关字段只存在于 item meta**：`idempotencyKey/clientTimeMs`（跨重试稳定）
- trace/diagnostic 字段只存在于 op meta（或 request meta，二选一并固定）
- request meta 只做“请求级默认值”（比如 clientTimeMs/版本号），不要塞业务字段

并且：所有路径（direct/outbox/sync push）都必须复用同一套 meta 生成策略，禁止多处各自生成。

### 5.5 `resource` 命名必须稳定且不做隐式归一化

任何“normalizeResourceName（只取最后一段）”的规则都会制造隐形冲突（历史上曾在 `OpsDataSource` 里出现过这种逻辑，已移除）：
- `/a/users` 与 `/b/users` 会撞成同一个 `users`

Ops-first 建议：
- `resource` 必须由 schema 定义，且与 `client.Store(name)` 一致。
- 禁止对 resource 做任何“看起来聪明”的改写。

### 5.6 统一前后端 id：只保留 `string`（把 `StoreKey`/数字 id 彻底移出主链路）

核心约束（建议写成协议合同 + 服务器校验）：
- **前后端只有一个 id 类型：`EntityId = string`**
- `Operation.write.items[].entityId` 必须是 string
- 实体数据里的 `value.id` 也必须是 string（至少在 Atoma 主链路中）

这意味着：
- 删除 `StoreKey = string | number` 这类“半强类型”。
- 删除所有 “纯数字字符串转 number” 的隐式策略（例如 `toStoreKey()`/`normalizeStoreKeyFromEntityId()` 这类函数应消失）。
- cursor/pageInfo 里出现的 `cursor/after/before` 都一律是 string（不再承载“可能是 number”）。

对应用层的明确要求（换取整体简化）：
- 如果你的业务主键是 number：在进入 Atoma 之前先做 `String(id)`，把 id 当字符串处理；不要指望框架帮你猜测/转换。
- schema/校验层应在开发期就拦截 “非 string id”。

与 `src/server` 的一致性（参考当前实现）：
- server 侧已在 ops normalize 阶段启用 `Protocol.ops.validate.*` 校验：`entityId/value.id` 非 string 会被直接拒绝（validation）。
- 这意味着“number id 兼容”应视为已废弃：任何 number/数字字符串转 number 的逻辑都不应该再存在于主链路中。

### 5.7 `WriteResultData.results` 的顺序/索引是协议级合同

你现在的 writeback（versionUpdates/upserts）依赖：
- 结果里带 `index`
- `index` 与提交 items 的顺序一致

Ops-first 必须把它写成“服务端必须满足的合同”，否则客户端无法可靠写回 version。

### 5.8 fields/select 与 transform/schema 的交互

一旦支持 `fields`（投影）：
- transform/schema/hook 可能依赖某些字段存在（例如 `version/updatedAt`）。
- 本地缓存写入“部分字段对象”会污染缓存一致性。

建议：
- 明确 `fields` 只用于“skipStore + 只读场景”，禁止写入缓存。
- 或者定义“投影结果只用于 UI，不进入 store 的实体缓存”。

### 5.9 错误分类与重试边界

Ops-first 下重试必须有边界，否则会把冲突/校验错误也当成网络错误重放：
- 可重试：网络/超时/5xx/明确的 `kind='transient'`（如果你定义了）
- 不可重试：validation/conflict/permission（按 `StandardError.kind/code` 约束）

建议统一在 `OpsClient`（transport/middleware）层做自动重试，core 只消费最终结果。

### 5.10 batch/backpressure 的语义边界

batch 只能改变性能，不能改变语义：
- 同一资源的 write 是否需要保持顺序？（至少对同一 entityId 需要可预测）
- query 是否允许被 drop（例如队列溢出时丢旧 query）？这种策略必须显式并可观测

建议把这些策略作为 `HttpOpsClient`/batch decorator 的配置，并在 devtools/observability 里暴露事件。

### 5.11 “软删 vs 硬删”必须在协议层有明确约定

当前 store 语义里（见 `ISTORE_API_EXPECTATIONS.zh.md`）：
- `deleteOne()` 默认是软删：把对象更新为 `{ deleted: true, deletedAt }`，本质是一次 **update**。
- `deleteOne({ force: true })` 才是硬删：本地移除 + 发 **delete**（需要 baseVersion）。

Ops-first 下要明确：
- 软删就是 `write(action='update')`，值里必须包含 deleted 相关字段（服务端只把它当作普通更新）。
- 硬删才是 `write(action='delete')`。
- 不要在服务端“偷偷把 deleted=true 当 delete 处理”，否则会破坏版本/回放/审计一致性。

### 5.12 server-assigned create（服务端分配 id）是特殊能力，别混到通用 create 里

这类能力会强制引入额外合同：
- 客户端不能提供 `id`（否则语义不清）
- 服务端必须 returning 最终实体（至少包含 `id/version`），否则客户端无法写回缓存
- outbox 一般不允许（否则“入队时 id 未知”会让后续 update/delete 无法表示）

建议把它从通用 CRUD 中单独命名并单独约束（例如保留 `createServerAssigned*`，并明确它只走 direct）。

### 5.13 “写入时隐式补读（implicit fetch for write）”是模式差异，不要偷偷跨模式

你现在 already 有一个关键策略差异：
- direct：允许 cache miss 时补读（DX 更好）
- outbox：必须禁止补读（enqueue 阶段不触网，否则回放/幂等会变复杂）

Ops-first 之后也必须保留这种差异，并把“是否允许补读”变成显式策略：
- 由 store view/persist mode 决定，而不是某个底层模块“顺手 fetch 一下”
- 避免出现“updateOne 在 cache miss 时直接 remote get”的隐式路径（否则 outbox 会被绕过）

### 5.14 `confirmation`（optimistic/strict）在 direct/outbox 下的定义要写死

如果你对外保留 `StoreOperationOptions.confirmation`，那它必须是稳定合同：
- direct：通常 optimistic≈strict（都等本次持久化完成）
- outbox：optimistic 等 enqueued；strict 等服务端 ack/reject（可能超时）

Ops-first 改造时最容易犯的错是：把 direct 的行为“误改成只等 enqueue”，导致历史行为断裂。

---

## 6. 破坏式迁移路线（推荐按“先定合同，再改实现”）

### 6.1 先冻结“协议合同”（最重要）
在动代码前先写清楚并达成一致：
- 版本模型：哪些 action 必须 baseVersion、upsert strict/loose 的精确定义
- meta：三层 meta 的字段归属、生成时机、稳定性要求
- write result：index/版本/返回 data 的最低保证
- query：分页（offset/cursor）与 pageInfo 的字段意义

### 6.2 再把 core 的“意图”直接落到 ops
把 core 内部需要的最小操作集收敛为：
- `query(resource, params) -> { items, pageInfo }`
- `write(resource, action, items, options?) -> WriteResultData`
- （可选）`changes.pull(...)` 只属于 sync lane

然后逐步替换：
- direct persister：不再调用 `dataSource.bulkPut/bulkDelete...`，改为组装 `WriteOp`
- query/read：不再调用 `dataSource.get/bulkGet/findMany/getAll`，改为组装 `QueryOp`

### 6.3 最后删除旧抽象（已完成）
- 已删除 `IDataSource`、`OpsDataSource`、`src/bridges/**`
- `createStore`/runtime 注入已从 `dataSourceFactory` 改为 `backendFactory`（内部通过 `StoreHandle.backend` 绑定 `opsClient` 与 `storeName`）
- 文档与 README 统一只讲 `OpsClient` 与 ops 协议（不再出现 datasource/bridge 术语）

---

## 9. 分阶段实现方案（建议按阶段验收，避免“大爆炸”）

下面以“每阶段可运行 + 可回滚到上阶段（仅在本地分支语义上）”为原则拆分。你明确不在乎迁移成本，因此每阶段都允许破坏式改动，但仍建议按顺序推进以减少同时改动面。

### Phase 0：锁合同（协议/语义先行）
- 输出一份“服务端必须满足的合同”：write result 的 `index/entityId/version`、query 的 `pageInfo`、错误分类（哪些可重试）。
- 把 id 合同写死：`EntityId` 仅 string，并决定是否要求 `value.id` 必须与 `entityId` 一致（server 端已有校验雏形）。
- 明确 `getAll` 语义去留：移除或改为显式分页/scan（禁止隐含 50 条上限）。

验收：server（`src/server`）能对非法 id/非法 op 早失败，并给出稳定错误码；文档能让新人只看一份就理解全部约束。

### Phase 1：类型收敛到 `src/protocol`（id/版本/游标）（已完成）
- 把核心标量类型统一由 `src/protocol/shared/scalars` 提供：`EntityId`/`Version`/`Cursor`（以及你希望保留的时间戳类型）。
- core 不再定义 `StoreKey`，并把“原 StoreKey 的职责”并入 `EntityId`：store API 全面切换为 `EntityId`（string）。
- 扫掉所有 number id 的隐式转换逻辑（客户端与 server 同步收紧）。

验收：全仓库不再出现 `StoreKey`（或仅残留在历史文件中，待下一阶段删），所有 id 流转都是 string。

### Phase 2：移除 datasource/bridges（core 直接发 ops）（已完成）
- direct persister：从“按 CRUD 调 datasource”改为“组装 `WriteOp` 发给 `opsClient`”（`src/core/mutation/pipeline/persisters/Direct.ts`）。
- 读路径：`get/bulkGet/findMany/getAll` 直接组装 `QueryOp`（`src/core/store/internals/opsExecutor.ts` + `src/core/store/ops/*`）。
- runtime 注入：`dataSourceFactory` → `backendFactory`（`StoreBackend = { key, opsClient }`）。
- 删除：`IDataSource`、`OpsDataSource`、`src/bridges/**`（不留兼容层）。

验收：不引入 outbox 的情况下，store 的所有写入/查询链路都不再依赖 `IDataSource`。

### Phase 3：outbox/sync 路径统一（同一套 meta/校验/回执处理）（已完成）
- `WriteItem.meta` 的生成规则收敛为协议级工具：`Protocol.ops.meta.ensureWriteItemMeta/newWriteItemMeta`。
- client enqueue/send 全链路强制补齐并校验：
  - enqueue：`SyncEngine.enqueueWrite(...)` 统一补齐 `idempotencyKey/clientTimeMs`（`src/sync/engine/SyncEngine.ts`）
  - push：`PushLane.flush()` 发送前按 outbox entry 兜底补齐（确保 `idempotencyKey` 与 outbox key 一致），并执行 `Protocol.ops.validate.assertOutgoingOpsV1(...)`（`src/sync/lanes/PushLane.ts`）
- patches 场景防坑：当一次 patches 影响多个 entity 时，不再允许多个 write items 共享同一个 `idempotencyKey`（避免服务端幂等表写入冲突）。
- ack/reject 分支彻底收敛：仅依赖 `entityId: string` 与 `item.meta.idempotencyKey`（不再存在 StoreKey/数字化兼容分支）。

验收：direct/outbox/sync push 三条路径发出的 ops 均能通过协议校验；并且不会出现“同一批 write items 共享 idempotencyKey”导致的服务端幂等冲突。

### Phase 4：文档/示例清理（进行中）
- 清理 README/示例中残留的 datasource/bridge 术语与配置（例如旧的 `dataSource`/`dataSourceFactory` 字段）。
- 统一对外只暴露 `OpsClient`（以及 batch/retry/interceptors）与 Store API。

验收：新人不需要看到任何 datasource/bridge 名词也能跑通 demo 与 sync。

---

## 7. 落地自检（改完后你应该能回答这些问题）

1) 新人是否只需要理解：`Operation(query/write)` + `OpsClient.executeOps` + `Store API`？
2) direct 与 outbox 是否使用同一套 meta/idempotency/baseVersion 规则？
3) 是否还存在“同一语义两套翻译器”的代码路径？
4) `getAll` 是否不再暗含“可能只有前 50 条”的陷阱？
5) server contract 是否写清楚（否则客户端 writeback/分页都不可靠）？

---

## 8. 关联阅读（避免重复造轮子）

- `ISTORE_API_EXPECTATIONS.zh.md`：store API 的预期行为与大量“版本/baseVersion/隐式补读”坑位说明。
- `src/sync/README.zh-CN.md`：outbox/sync lane 的整体链路与 ack/reject。
- `ATOMA_BACKEND_OPTIMAL_ARCHITECTURE.zh.md`：更保守的“保留 core->IDataSource，但把 translator 内置”的版本（与本文档方向不同）。
