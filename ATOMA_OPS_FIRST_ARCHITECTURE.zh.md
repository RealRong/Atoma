# Atoma：Ops-first 架构（移除 `IDataSource`/`OpsDataSource`/`src/bridges`，不留兼容层）

目标：把“持久化/远端交互”的唯一抽象收敛为 `OpsClient.executeOps(...)`，让 Atoma 的核心链路只围绕 **Ops 协议**工作；不保留兼容层（允许破坏式变更），以最低心智成本获得可扩展性与一致性。

这份文档比 `ATOMA_BACKEND_OPTIMAL_ARCHITECTURE.zh.md` 更激进：那份建议“Translator 内置到 client”，而这里建议 **直接移除 Translator（`IDataSource`）**，让 core 直接产出/消费 ops，并明确删除 `src/bridges`，不保留兼容层。

---

## 1. 现状（你现在的链路）

目前有两条“翻译链路”，概念重复：

1) **direct（直连）路径**
- `src/core` 写入/查询 → `IDataSource<T>` → `src/bridges/ops/OpsDataSource.ts`（翻译成 ops）→ `src/backend/ops/OpsClient.ts`（发送）→ HTTP/IndexedDB/Memory transport

2) **outbox（入队）路径**
- `src/core/mutation/pipeline/persisters/Outbox.ts` 里直接调用 `Protocol.ops.encodeWriteIntent(...)` 生成 ops intent（相当于另一套翻译器）→ outbox 存储/同步引擎推送时发 `write` op

这导致：
- 新人需要理解：`IDataSource`、`OpsDataSource`、`OpsClient`、outbox intent、以及它们之间的差异。
- 同样的“meta 注入 / idempotency / baseVersion”在多处重复实现，长期一致性风险大。

---

## 2. 核心结论（Ops-first）

把 ops 协议定义为 Atoma 的“原生后端契约”：
- **唯一后端接口：** `OpsClient.executeOps({ ops, meta, context, signal })`
- **唯一持久化/查询表达：** `Operation(kind='query'|'write'|'changes.pull')`

因此（明确删除清单，不留兼容层）：
- 删除 `IDataSource<T>` 以及所有 `*DataSource` 实现（包括 `OpsDataSource`）。
- 删除 `src/bridges/**`（整个目录直接移除；不再作为内部/外部入口存在）。
- 删除 “dataSourceFactory 注入” 这条配置面（改为注入 `OpsClient` 或等价的 ops 执行器）。
- 删除/迁移 `StoreKey`（详见 §5.6：统一前后端 id 类型为 `string`）。
- core 的 persister/query 直接生成 ops 并调用 `OpsClient`。

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
- 一个“按资源绑定”的轻量封装（可选，但能显著简化调用端心智）：
  - `OpsResourceClient(resource).query(params)` → 发 `QueryOp`
  - `OpsResourceClient(resource).write(action, items, options?)` → 发 `WriteOp`

命名说明：
- `OpsClient`：transport 级（怎么发到 HTTP/DB/内存）。
- `OpsResourceClient`：语义更直观的“资源级调用器”（把 `resource` 绑定住，避免每次手写 `Operation`）。
- 这不是 `IDataSource`；它不试图模拟 CRUD 语义，只是 ops 的薄封装。

---

## 5. 必须一次性整理清楚的“坑”（高频踩坑清单）

下面这些不是实现细节，而是“如果不先定规则，一定会反复踩”的系统性坑。

### 5.1 `getAll` 语义与协议分页不匹配（强烈建议移除或改名）

现状坑：
- 你现在的 `normalizeAtomaServerQueryParams` 会在没传 `limit` 时默认 `limit=50`。
- 若保留 `getAll()` 且实现为“发一次 query”，远端永远拿不到全量（只拿到前 50）。

Ops-first 规则建议（二选一，别模糊）：
1) **移除 `getAll`**，只保留 `findMany`（显式分页）/`scan`（显式迭代）。
2) **保留但改语义：** `getAll` 明确为“最多 N 条”（例如 `getAll({ limit: 1000 })`），或者内部自动翻页直到穷尽（但要定义最大页数/最大条数/超时/取消）。

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

`OpsDataSource.normalizeResourceName` 这类“只取最后一段”的规则会制造隐形冲突：
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
- 目前 server 在 `src/server/ops/opsExecutor/write.ts` 内部用 `normalizeId(...)` 接受 number 并转 string，这是“兼容行为”。
- Ops-first 改造完成后，应把它改为**只接受 string**，对 number 直接返回 `INVALID_WRITE/validation`，从而把合同钉死。
- 另外，server 的 `src/server/ops/opsExecutor/normalize.ts` 会把 `write.items` 直接 cast 为 `WriteItem[]`（不逐项校验字段类型）；要真正落实“id 仅 string”，需要在 write executor 逐项校验（或在 normalize 阶段深度校验 items）。

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

### 6.3 最后删除旧抽象
- 删除 `IDataSource`、`OpsDataSource`、`src/bridges/**`（明确整个目录移除）
- `createStore`/runtime 注入从 `dataSourceFactory` 改为注入 `opsClient`（或由 `OpsResourceClient` 在内部绑定 resource）
- 文档与 README 统一只讲 `OpsClient` 与 ops 协议（不再出现 datasource/bridge 术语）

---

## 9. 分阶段实现方案（建议按阶段验收，避免“大爆炸”）

下面以“每阶段可运行 + 可回滚到上阶段（仅在本地分支语义上）”为原则拆分。你明确不在乎迁移成本，因此每阶段都允许破坏式改动，但仍建议按顺序推进以减少同时改动面。

### Phase 0：锁合同（协议/语义先行）
- 输出一份“服务端必须满足的合同”：write result 的 `index/entityId/version`、query 的 `pageInfo`、错误分类（哪些可重试）。
- 把 id 合同写死：`EntityId` 仅 string，并决定是否要求 `value.id` 必须与 `entityId` 一致（server 端已有校验雏形）。
- 明确 `getAll` 语义去留：移除或改为显式分页/scan（禁止隐含 50 条上限）。

验收：server（`src/server`）能对非法 id/非法 op 早失败，并给出稳定错误码；文档能让新人只看一份就理解全部约束。

### Phase 1：类型收敛到 `src/protocol`（id/版本/游标）
- 把核心标量类型统一由 `src/protocol/shared/scalars` 提供：`EntityId`/`Version`/`Cursor`（以及你希望保留的时间戳类型）。
- core 不再定义 `StoreKey`，并把“原 StoreKey 的职责”并入 `EntityId`：store API 全面切换为 `EntityId`（string）。
- 扫掉所有 number id 的隐式转换逻辑（客户端与 server 同步收紧）。

验收：全仓库不再出现 `StoreKey`（或仅残留在历史文件中，待下一阶段删），所有 id 流转都是 string。

### Phase 2：direct 路径 Ops 化（core 直接发 ops）
- 替换 direct persister：从“按 CRUD 调 `dataSource.bulkPut/bulkDelete...`”改为“组装 `WriteOp` 发给 `OpsClient`”。
- 替换读路径：`get/bulkGet/findMany` 直接组装 `QueryOp`（保留本地缓存/索引逻辑不变）。
- 把 meta 注入收敛到一个位置（建议在 core 的“组装 Operation”处，或一个专门的 ops middleware）。

验收：不引入 outbox 的情况下，store 的所有写入/查询链路都不再依赖 `IDataSource`。

### Phase 3：outbox/sync 路径统一（同一套 ops 编码/回执处理）
- outbox 存储的内容从“半自定义 intent”收敛为“可直接发送的 ops 表达”（二选一：`WriteOp` 或 `WriteIntent` + 统一 encoder）。
- ack/reject 的处理只依赖 `entityId(string)` 与 `idempotencyKey`，不再做 StoreKey/数字化分支。
- 统一 strict/optimistic 的 ticket/confirmed 语义，保证 direct/outbox 行为不漂移。

验收：direct 与 outbox 的 meta/idempotency/baseVersion 规则完全一致；同一写入在两条路径的错误形态一致。

### Phase 4：清理旧层与目录（真正完成“无兼容层”）
- 删除 `src/bridges/**`、删除 `IDataSource`、删除所有 DataSource 相关测试与文档引用。
- `createClient/createStore` 配置面只暴露 `OpsClient`（以及 batch/retry/interceptors），不再出现 datasource 入口。
- 更新 README/示例，让使用者只接触 `Backend.*OpsClient` 与 Store API。

验收：仓库中不存在 “bridge/datasource” 概念入口；新人只需要理解 ops 协议与 `OpsClient`。

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
