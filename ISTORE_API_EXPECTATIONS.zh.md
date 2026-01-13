# IStore 全量 API 预期行为（用于逐项手测）

本文档描述 `IStore<T>` 对外所有 API 的**预期行为表现**（返回值/本地缓存变化/持久化与确认语义/常见错误形态），方便你按清单逐个测试并对照实现偏差。

来源与对照代码：
- 接口定义：`src/core/types.ts`（`IStore`、`StoreOperationOptions`、`WriteConfirmation`）
- 具体实现：`src/core/store/ops/*`
- 写入执行/确认：`src/core/mutation/pipeline/*`、`src/client/controllers/SyncController.ts`（当启用 sync/outbox 时）

---

## 0. 术语与全局约束（所有 API 都受影响）

### 0.1 两条“写入路径”

- **direct（直连后端）**
  - 写入会立刻发到后端（例如 HTTP ops），成功后才算完成。
  - `confirmation: 'optimistic' | 'strict'` 在 direct 路径下**通常等价**：两者都会等到本次持久化完成后才 resolve（因为 direct 没有“仅入队不确认”的阶段）。

- **sync/outbox（入队 + 后台同步）**
  - 写入先进入 outbox（落盘/可重试），稍后由 sync engine 推送到服务端并拿到 ack/reject。
  - `confirmation` 在此路径下**有实质区别**：
    - `optimistic`：等待 **enqueued（已入队）**就 resolve（UI 已更新，但服务端尚未确认）。
    - `strict`：等待 **confirmed（服务端 ack/reject）**才 resolve/ reject（可能超时）。

> 备注：`createServerAssigned*` 强制 direct（不允许 outbox）。

### 0.2 UI 是否“立刻更新”

- 所有普通写入（add/update/delete/upsert）在进入 mutation pipeline 后，都会先做 **optimistic commit**（先改本地 atom/map）。
- `options.confirmation` 仅影响 **Promise 何时完成**，不改变 UI 是否立刻更新。

### 0.3 版本与 baseVersion（决定 update/delete 是否能发出去）

Atoma 的版本模型要求：
- `update` 必须带 `baseVersion`（通常来自实体上的 `version` 字段）。
- `delete`（硬删/forceRemove）必须带 `baseVersion`。
- `upsert`：
  - `mode='loose'`：允许无 baseVersion（LWW + version 递增）。
  - `mode='strict'`：若服务端已存在该 id，则必须带 baseVersion，否则应冲突。

**关键含义（手测时很常见）：**
- 如果本地对象没有 `version`（例如：刚创建但尚未收到服务端 ack 的 outbox create），立刻 update/delete 可能会失败（“missing version/baseVersion”）。

### 0.4 “隐式补读（implicit fetch for write）”策略

当写入遇到本地缓存缺失时，是否允许自动 `bulkGet/get` 进行补读：
- direct：默认允许（提升 DX）
- sync/outbox：必须禁止（enqueue 阶段不触网）

当前落点（用于手测判断）：
- `updateMany/deleteMany` 会看 `handle.writePolicies.allowImplicitFetchForWrite`：
  - `true`：允许补读
  - `false`：直接返回 per-item 错误，提示先 fetch 再写
- `updateOne`：实现上会在 cache miss 时直接 `dataSource.get` 补读并写入缓存（不走该开关）。

### 0.5 confirmation 严格等待与超时

`StoreOperationOptions`：
- `confirmation?: 'optimistic' | 'strict'`（默认 optimistic）
- `timeoutMs?: number`（仅 strict 生效）
- `timeoutBehavior?: 'reject' | 'resolve-enqueued'`（默认 reject）

手测建议：
- 在 sync/outbox 模式下测试 `strict + timeoutMs`，观察超时策略是否符合预期。

---

## 1. 写入类 API（add/update/delete/upsert/createServerAssigned）

下面每个 API 都从 “输入约束 → 本地表现 → 持久化/确认 → 返回值/错误” 描述。

### 1.1 `addOne(item, options?) => Promise<T>`

输入约束：
- 允许不传 `id/createdAt/updatedAt`（会自动补齐）。

本地表现（UI）：
- 立刻把新对象写入本地缓存（optimistic commit）。

持久化：
- direct：后端 create（或 bulkPut/bulkCreate）。
- sync/outbox：入队 create，等 ack 后写回 `version`（以及可选 data）。

返回值：
- resolve：返回写入后的对象（经过 `beforeSave/transform/schema`，并在确认后应具备最新 `version`）。
- reject：持久化失败会 rollback，并 reject。

常见手测点：
- 重复 `id`（客户端指定 id）是否服务端冲突；失败时本地是否 rollback。

### 1.2 `addMany(items, options?) => Promise<T[]>`

输入约束：
- 每个 item 允许缺省 id（会自动生成）。
- 多个 item 在一次 actionId 下聚合（实现会补齐 actionId，便于 history/批处理）。

本地表现：
- 立刻批量写入本地缓存。

持久化/返回：
- 与 `addOne` 类似，但一次返回数组。

常见手测点：
- 任意一个 item 失败时：是否整体 reject、是否部分成功、是否回滚一致（取决于当前实现与后端能力）。

### 1.3 `createServerAssignedOne(item, options?) => Promise<T>`

强语义（必须严格遵守）：
- **不允许传入 `id`**（服务端分配）。
- **强制 `confirmation='strict'`**（非乐观）。
- **强制 direct**（禁止 sync/outbox）。

本地表现：
- 在服务端返回最终实体之前，本地不应出现该记录（“先返回、再写入本地”）。

持久化：
- 必须调用 dataSource 的 `bulkCreateServerAssigned` 并返回包含 `id/version` 的最终实体。

返回值：
- resolve：服务端返回的最终实体（已写入本地缓存）。
- reject：失败时不应污染本地。

常见手测点：
- 服务端生成 id 是否写入本地、UI 是否在 promise resolve 后才出现。

### 1.4 `createServerAssignedMany(items, options?) => Promise<T[]>`

语义同 `createServerAssignedOne`，只是批量。

常见手测点：
- 多条中部分失败的处理（是否整体 reject、是否出现部分已写入本地）。

### 1.5 `updateOne(id, recipe, options?) => Promise<T>`

输入约束：
- `recipe(draft)` 以 immer 方式修改。
- 若 cache miss：会 `dataSource.get(id)` 补读；不存在则抛错。

本地表现：
- 立刻更新本地缓存（optimistic commit）。

持久化：
- direct：update 必须带 baseVersion（来自实体 `version`）。
- sync/outbox：入队 update（同样需要 baseVersion）。

返回值/错误：
- 若 id 不存在（本地+后端都无）：reject（`Item with id ... not found`）。
- 若缺少 `version` 导致 baseVersion 不可用：会在持久化阶段报错并 rollback。

常见手测点：
- “只知道 id，不先 fetch”：`updateOne` 预期会自动 fetch 并缓存，然后再 update。

### 1.6 `updateMany([{id, recipe}], options?) => Promise<WriteManyResult<T>>`

输入约束：
- 允许重复 id，但重复项会被标记为错误：`Duplicate id in updateMany: ...`。

cache miss 行为：
- 若缺失且 `allowImplicitFetchForWrite=true`：会 `bulkGet` 补读并写入缓存，再执行更新。
- 若缺失且 `allowImplicitFetchForWrite=false`：该 id 对应的结果为 `ok:false`，提示先 fetch 再写。

本地表现：
- 对可执行的条目：立刻更新缓存。
- 不可执行的条目：不应改变缓存（只在结果里返回错误）。

返回：
- 永远 resolve 一个数组（每项 ok/err）。

常见手测点：
- direct 模式下 cache miss 的自动补读。
- sync/outbox 模式下 cache miss 的拒绝补读（需要你显式 fetch）。

### 1.7 `deleteOne(id, options?) => Promise<boolean>`

语义：
- 默认是**软删**：将记录标记为 `{ deleted: true, deletedAt }`，并作为 update 持久化。
- `options.force === true`：走**硬删**（从本地移除，并向后端发送 delete，需要 baseVersion）。

本地表现：
- remove（软删）：立刻把该 id 的对象改为 deleted=true。
- forceRemove（硬删）：立刻从本地 map 删除。

错误点（常见）：
- forceRemove 时如果拿不到 baseVersion（实体缺 `version`）：持久化阶段报错并 rollback。

### 1.8 `deleteMany(ids, options?) => Promise<WriteManyResult<boolean>>`

整体语义同 `deleteOne`，但返回 per-item 结果。

额外规则：
- 重复 id：重复项会 `ok:false`。
- `force` 且该 id 在缓存中不存在：直接 `ok:false`（提示必须先 fetch 获取 version）。
- cache miss：
  - `allowImplicitFetchForWrite=true`：会 `bulkGet` 补读（主要用于后续 baseVersion/存在性判断）。
  - `allowImplicitFetchForWrite=false`：返回错误提示先 fetch。

常见手测点：
- `force delete` 的“必须缓存里有 version”约束。
- cache miss 下 direct 允许补读、sync 禁止补读。

### 1.9 `upsertOne(item, options?) => Promise<T>`

语义：
- 若本地缓存存在该 id：按 update 处理（merge 或 replace）。
- 若本地缓存不存在该 id：按 add 处理（会补 createdAt/updatedAt）。

持久化（关键）：
- `options.mode`：
  - `strict`：若服务端已存在该 id，必须带 baseVersion，否则应 CONFLICT。
  - `loose`：允许无 baseVersion（更接近 LWW/幂等覆盖）。
- `options.merge`：
  - `true/undefined`：merge（仅覆盖给定字段）
  - `false`：replace（更像整行覆盖，但会尽量保留 createdAt/etag/version）

常见手测点：
- **cache miss 但服务端存在**：`mode='strict'` 预期会冲突（需要先 fetch 再 upsert）。
- `mode='loose'` 是否能在 cache miss 情况下成功覆盖。

### 1.10 `upsertMany(items, options?) => Promise<WriteManyResult<T>>`

语义同 `upsertOne`，但返回 per-item 结果，并对重复 id 给出错误。

---

## 2. 读取类 API（get/fetch/find）

### 2.1 `getOne(id) => Promise<T | undefined>`

语义：
- cache hit：直接返回缓存对象。
- cache miss：走批量合并 `bulkGet`（microtask 聚合），并**写入缓存**。

常见手测点：
- 连续多次 `getOne` 不同 id 是否被合并为一次 `bulkGet`。
- miss 后是否被缓存（后续 getOne 命中）。

### 2.2 `fetchOne(id) => Promise<T | undefined>`

语义：
- 始终走后端 `bulkGet`（microtask 聚合），但**不写入缓存**。

常见手测点：
- fetchOne 后立刻 getOne：getOne 仍应 miss（除非其它路径写入了缓存）。

### 2.3 `getMany(ids, cache=true) => Promise<T[]>`

语义：
- 对 cache miss 的 id：会 `bulkGet` 补齐。
- `cache=true`：会把 fetched 写入缓存；`cache=false`：不写入缓存。

注意（非常重要，手测时别踩坑）：
- 返回值会 `filter` 掉 undefined，因此：
  - 返回数组长度可能 **小于** ids.length
  - 返回数组不保证严格与输入 ids 一一对应（缺失会被抹掉）

### 2.4 `getAll(filter?, cacheFilter?) => Promise<T[]>`

语义：
- 会调用 `dataSource.getAll(filter)` 拉取列表，并把结果写入缓存。
- **会移除本地缓存中“此次拉取结果里不存在的 id”**（把 cache 对齐到服务端快照）。
- `cacheFilter`：只控制“哪些写入缓存”，但所有 fetched 的 id 都会参与“不要被移除”的集合（避免误删）。

常见手测点：
- 服务端少返回一条，本地是否会被移除。
- `cacheFilter` 为 false 的条目是否不写入缓存，但也不触发误删。

### 2.5 `fetchAll() => Promise<T[]>`

语义：
- 直接调用 `dataSource.getAll(undefined)` 并返回 transform 后的数据。
- **不写入缓存、不做移除**（纯“拉取”）。

常见手测点：
- fetchAll 后 getCachedAll（或 getAll）是否不受影响。

### 2.6 `findMany(options?) => Promise<FindManyResult<T>>`

语义分支：
- 若 dataSource 实现了 `findMany`：
  - 默认会把返回的数据**写入缓存**（增量写入，不会清空其它缓存项）。
  - 若 `options.skipStore===true` 或 `options.fields` 非空（sparse fieldset）：**不写入缓存**。
- 若 dataSource 未实现 `findMany`：
  - 会 fallback 到 `getAll + 本地 applyQuery`。
  - 该 fallback 路径会把缓存视为“快照同步”：**会移除不在结果里的 id**（与 `getAll` 类似）。

常见手测点：
- `fields` 时不写入缓存（避免半字段对象污染）。
- dataSource.findMany 缺失时的 fallback 行为（尤其是“会移除”这一点）。

---

## 3. 手测建议：按“维度”组织用例

为了更快定位差异，建议每个 API 至少覆盖这些维度：

### 3.1 路径维度
- direct（sync 关闭）
- sync/outbox（sync 开启，能入队、能 ack/reject）

### 3.2 confirmation 维度
- optimistic（默认）
- strict（包含 timeoutMs/timeoutBehavior）

### 3.3 cache 状态维度
- cache hit（先 getOne/getAll/fetch 再写）
- cache miss（只拿 id 直接写：updateMany/deleteMany 的 implicit fetch 行为尤为关键）

### 3.4 version 维度
- entity 有 version（正常）
- entity 无 version（刚创建但未确认/未写回；测试 update/delete 的报错与回滚）

---

## 4. 当前实现/设计差异（建议你重点手测暴露）

1) direct 路径对“item 级失败”的回滚/抛错：
- 若后端协议返回 `op.ok=true` 但 `data.results[i].ok=false`，目前 **可能不会触发前端 rollback**（取决于 OpsDataSource 是否将 item 失败提升为异常）。
- 手测时建议同时观察服务端日志与本地缓存是否回滚一致。

2) `deleteOne` 在目标不存在时的语义：
- 实现上更偏“尽力而为”的软删：若本地也没有该 id，可能不会报错也不会产生变化，但仍可能 resolve。
- 如需严格语义（不存在则 false/抛错），需要另行定义产品规则。

