# Atoma 基于 RxDB 的新同步系统设计（完整方案）

> 目标：在不改 `atoma-core/atoma-runtime` 语义的前提下，重构 `atoma-sync` 与 `atoma-server` 的同步实现，移除自研 lane/outbox 引擎复杂度，收敛为基于 RxDB Replication 的单一同步架构。

---

## 0. 文档元信息

- 状态：`Proposed`
- 日期：`2026-02-25`
- 范围：`packages/plugins/atoma-sync`、`packages/atoma-server`、`packages/atoma-types/sync`（可重构）
- 不在范围：`packages/atoma-core`、`packages/atoma-runtime`（除非必须增加通用能力）
- 架构策略：`一步到位，不保留 legacy 双路径`

---

## 1. 背景与问题定义

当前同步链路由 `atoma-sync` 自研运行时承担：

- `SyncEngine` + `PushLane/PullLane/NotifyLane` 调度
- `OutboxStore` 本地持久化队列 + reserve/commit/recover
- `SingleInstanceLock` 多实例协调
- `WritebackApplier` 远端变更回写

实际复杂度来源并非业务语义本身，而是“同步基础设施”重复建设。其结果是：

1. 代码体积与状态机复杂度高（lane + lock + queue + retry + subscribe 交叉）。
2. 与 `atoma-server` 强适配点分散在多处，难以演进。
3. 与 `atoma-backend-shared` 的协议映射存在重复实现。
4. 维护成本高于业务收益。

`atoma-server` 现有同步语义本身是稳定且可复用的：

- `idempotency` 去重
- `appendChange` 游标增量
- `changes.pull` / `subscribe`
- `executeWriteItemWithSemantics`（CAS、冲突、版本推进）

因此本设计采取：

- 保留 Atoma 写语义和服务端一致性约束
- 用 RxDB 取代客户端同步基础设施
- 将适配复杂度集中到“桥接层”而非散落在 lane/store/policy 中

---

## 2. 设计目标与非目标

## 2.1 目标

1. 主业务 CRUD 继续走 Atoma 主链路（`runtime.write`）。
2. 同步引擎改为 RxDB Replication，移除自研 outbox/lane/lock。
3. 保留 Atoma 服务端语义：`baseVersion/expectedVersion/idempotency/cursor`。
4. 插件入口仍通过 `PluginContext` 能力完成：`events/runtime/services`。
5. 最终架构只保留单一同步路径，不保留旧实现并存。

## 2.2 非目标

1. 不把应用查询入口切到 RxDB（查询语义仍归 Atoma runtime）。
2. 不修改 `atoma-core` 查询/变更算法。
3. 不引入“兼容别名 API”或双导出体系。

---

## 3. 约束与边界

1. `atoma-core`、`atoma-runtime` 默认不改。
2. 若必须新增能力，只允许通用能力（与 sync 无业务耦合）。
3. 跨域术语保持一致：
   - core/runtime/client：`StoreToken` / `storeName`
   - protocol/sync/transport：`ResourceToken` / `resource`
4. 映射 `storeName <-> resource` 仅在同步边界适配层完成。

---

## 4. 目标架构总览

```text
[App CRUD]
    |
    v
[Atoma runtime.write]
    |
    | writeCommitted(changeCommitted)
    v
[Sync Local Bridge]
    | (origin != sync)
    v
[RxDB Collections per resource]
    |
    | replicateRxCollection()
    +--> push.handler  ----HTTP----> atoma-server /sync/rxdb/push
    +<-- pull.handler  ----HTTP----- atoma-server /sync/rxdb/pull
    +<-- stream$ (SSE) ----HTTP----- atoma-server /sync/rxdb/stream
    |
    v
[Sync Remote Bridge]
    | (received$)
    v
[runtime.stores.use(...).reconcile/remove]
    | context.origin = 'sync'
    v
[Atoma local state updated]
```

关键点：

1. 主路 CRUD 不变；同步是旁路桥接。
2. 回写统一打 `origin: 'sync'` 防止环路。
3. 远端通知以 `RESYNC` 驱动补拉，不做客户端自研轮询状态机。

---

## 5. 客户端设计（`packages/plugins/atoma-sync` 全量重写）

## 5.1 包内目标结构

```text
packages/plugins/atoma-sync/src/
  plugin.ts                       # 插件入口与生命周期
  types.ts                        # 新 Sync 配置类型（RxDB 语义）
  services.ts                     # 可选 transport service token（仅保留必要）
  devtools/sync-devtools.ts       # 状态与事件聚合
  rxdb/database.ts                # RxDB 数据库与 collection 注册
  rxdb/schema.ts                  # 文档约束、元字段处理
  replication/replication.ts      # per-resource replicateRxCollection
  bridge/localWriteBridge.ts      # Atoma writeCommitted -> RxDB 本地写
  bridge/remoteApplyBridge.ts     # RxDB received$ -> Atoma runtime 回写
  transport/pull.ts               # pull.handler
  transport/push.ts               # push.handler
  transport/stream.ts             # pull.stream$ (SSE -> RESYNC)
  mapping/writeMapping.ts         # Atoma 写语义映射
  mapping/docMapping.ts           # 文档与实体映射
```

说明：旧目录 `engine/lanes/storage/policies/persistence` 全部删除，不保留兼容导出。

## 5.2 插件公开 API（保持语义，不保留旧实现）

保留 `sync` 扩展行为语义：

- `start()`：启动所有 resource replication
- `stop()`：暂停 replication 与流
- `pull()`：触发一次 reSync
- `push()`：触发一次 runPush
- `status()`：返回 started/configured

内部不再暴露 `SyncEngine`、lane 状态。

## 5.3 资源模型与配置

```ts
type SyncResourceConfig = {
    resource: string
    storeName: string
    collectionName?: string
    schema: RxJsonSchema<any>
}

type SyncPluginOptions = {
    baseURL: string
    resources: SyncResourceConfig[]
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    mode?: 'full' | 'pull-only' | 'push-only'
    retryTimeMs?: number
    live?: boolean
    waitForLeadership?: boolean
    push?: {
        batchSize?: number
    }
    pull?: {
        batchSize?: number
        initialCheckpoint?: { cursor: number }
    }
    stream?: {
        enabled?: boolean
        reconnectDelayMs?: number
    }
    onEvent?: (event: any) => void
    onError?: (error: Error, context: { phase: string }) => void
}
```

## 5.4 文档模型（RxDB 存储）

每个 resource 一张 collection，文档主键 `id`。

```ts
type SyncDoc<T = any> = T & {
    id: string
    version: number
    _deleted?: boolean
    atomaSync: {
        resource: string
        clientId: string
        mutationId?: string
        idempotencyKey?: string
        changedAtMs?: number
        source?: 'local' | 'remote'
    }
}
```

规则：

1. `version` 必填，来自 Atoma 服务端版本语义。
2. 删除使用 tombstone：`_deleted: true`，不直接物理删本地文档。
3. `atomaSync` 仅为同步桥接元信息，不暴露给业务查询。

## 5.5 本地写桥接（LocalWriteBridge）

输入：`ctx.events.on('writeCommitted')`

处理：

1. 过滤 `event.context.origin === 'sync'`。
2. 从 `changes` 读取 `before/after`：
   - `after` 存在：写入/更新 RxDB 文档
   - `after` 不存在：写入 tombstone 文档（`_deleted=true`）
3. 为每次本地变更生成稳定 `mutationId` 与 `idempotencyKey`（写入 `atomaSync`）。
4. 不直接调用网络，交给 RxDB replication push。

## 5.6 远端回写桥接（RemoteApplyBridge）

输入：`replicationState.received$`

处理：

1. 按 `resource` 分组。
2. 将文档映射为 runtime 回写：
   - `_deleted=true` -> `session.reconcile({ mode: 'remove', ids })`
   - 否则 -> `session.reconcile({ mode: 'upsert', items })`
3. 回写上下文统一 `context.origin='sync'`。
4. 在回写前做版本短路：若本地 `peek(id).version >= incoming.version`，跳过。

## 5.7 环路控制

1. LocalWriteBridge 忽略 `origin='sync'`。
2. RemoteApplyBridge 所有写入都强制 `origin='sync'`。
3. 文档中 `atomaSync.source` 仅用于调试，不作为逻辑正确性依赖。

## 5.8 Devtools

保留 `sync` 面板，但数据来源改为 RxDB replication state：

- `active$`
- `error$`
- `sent$`
- `received$`
- `canceled$`

## 5.9 `replicateRxCollection` 接线样例

```ts
const replicationState = replicateRxCollection({
    replicationIdentifier: `atoma:${clientId}:${resource}`,
    collection,
    live: options.live ?? true,
    waitForLeadership: options.waitForLeadership ?? true,
    retryTime: options.retryTimeMs ?? 5000,
    autoStart: false,
    pull: {
        batchSize: options.pull?.batchSize ?? 200,
        handler: async (checkpoint) => {
            return await pullHandler({
                baseURL: options.baseURL,
                resource,
                checkpoint: checkpoint as { cursor: number } | undefined
            })
        },
        stream$: createStreamObservable({
            baseURL: options.baseURL,
            resource
        })
    },
    push: {
        batchSize: options.push?.batchSize ?? 100,
        handler: async (rows) => {
            return await pushHandler({
                baseURL: options.baseURL,
                resource,
                rows
            })
        }
    }
})
```

说明：

1. `stream$` 推荐只发 `RESYNC` 事件，避免在 SSE 承载文档数据。
2. `autoStart=false`，由 `sync.start()` 显式启动，保持与 Atoma 插件生命周期一致。
3. 每个 `resource` 单独 replicationState，便于隔离错误与指标。

---

## 6. 服务端设计（`packages/atoma-server` 重构）

## 6.1 新端点

新增独立同步端点，不复用 `ops` 的 envelope：

1. `POST /sync/rxdb/pull`
2. `POST /sync/rxdb/push`
3. `GET /sync/rxdb/stream`

旧 `changes.pull` 与 `/sync/subscribe` 不再作为主同步链路，迁移完成后删除。

## 6.2 `POST /sync/rxdb/pull`

请求：

```json
{
  "resource": "todos",
  "checkpoint": { "cursor": 1024 },
  "batchSize": 200
}
```

响应：

```json
{
  "documents": [
    {
      "id": "t1",
      "version": 9,
      "title": "...",
      "atomaSync": { "resource": "todos" }
    },
    {
      "id": "t2",
      "version": 10,
      "_deleted": true,
      "atomaSync": { "resource": "todos" }
    }
  ],
  "checkpoint": { "cursor": 1080 }
}
```

服务端流程：

1. 读取 `changesTable`：`cursor > checkpoint.cursor AND resource = ? ORDER BY cursor ASC LIMIT batchSize`。
2. 对 `kind='upsert'` 批量查 ORM 实体并组装完整文档。
3. 对 `kind='delete'` 返回 tombstone 文档。
4. `checkpoint.cursor` 返回本批最后一条 cursor。

## 6.3 `POST /sync/rxdb/push`

请求：

```json
{
  "resource": "todos",
  "rows": [
    {
      "newDocumentState": { "id": "t1", "version": 4, "title": "A", "_deleted": false, "atomaSync": { "idempotencyKey": "..." } },
      "assumedMasterState": { "id": "t1", "version": 3, "title": "B", "_deleted": false }
    }
  ],
  "context": {
    "clientId": "c1",
    "requestId": "r1",
    "traceId": "t1"
  }
}
```

响应：

```json
{
  "conflicts": [
    { "id": "t1", "version": 5, "title": "Server", "_deleted": false }
  ]
}
```

语义：

1. 逐行转换为 Atoma 写意图，复用 `executeWriteItemWithSemantics`：
   - `assumed == null && !_deleted` -> `create`
   - `assumed != null && !_deleted` -> `update(baseVersion=assumed.version)`
   - `assumed != null && _deleted` -> `delete(baseVersion=assumed.version)`
   - `assumed == null && _deleted` -> no-op（忽略）
2. `idempotencyKey` 透传到语义执行器。
3. 成功写入必须继续 `appendChange`，保证 pull 可见。
4. 冲突返回“服务端主文档”供 RxDB 冲突收敛。

## 6.4 `GET /sync/rxdb/stream`

协议：`SSE`

- `event: sync.notify`
- `data: { "resource": "todos", "cursor": 1090 }`

客户端行为：

- 收到任何 `sync.notify` 事件，向对应 resource 发 `RESYNC`。

说明：

1. stream 仅做“有变化”信号，不承载完整数据。
2. 完整一致性依赖 pull + checkpoint。

## 6.5 适配器与索引要求

`ISyncAdapter` 重构目标：

```ts
interface ISyncAdapter {
    appendChange(change: { resource: string; id: string; kind: 'upsert' | 'delete'; serverVersion: number; changedAt: number }, tx?: unknown): Promise<{ cursor: number }>
    pullChangesByResource(args: { resource: string; cursor: number; limit: number }): Promise<Array<{ cursor: number; resource: string; id: string; kind: 'upsert' | 'delete'; serverVersion: number; changedAt: number }>>
    waitForResourceChanges(args: { resources?: string[]; afterCursorByResource?: Record<string, number>; timeoutMs: number }): Promise<Array<{ resource: string; cursor: number }>>
    getIdempotency(key: string, tx?: unknown): Promise<IdempotencyResult>
    putIdempotency(key: string, value: { status: number; body: unknown }, ttlMs?: number, tx?: unknown): Promise<void>
}
```

数据库索引要求：

1. `changes(resource, cursor)` 复合索引（pull 主路径）。
2. `changes(cursor)` 索引（全局调试与回放）。
3. `idempotency(idempotencyKey)` 唯一索引。
4. `idempotency(expiresAt)` 清理索引。

---

## 7. Atoma 语义映射（核心）

## 7.1 版本语义

1. 服务端版本是唯一权威。
2. RxDB 文档 `version` 必须与服务端版本一致。
3. push 时 CAS 基线来自 `assumedMasterState.version`。

## 7.2 幂等语义

1. 每条 push row 必须带 `idempotencyKey`。
2. 服务端写入 idempotency 表后再返回。
3. 重试必须得到相同 replay 结果。

## 7.3 删除语义

1. 传输层用 tombstone（`_deleted=true`）。
2. Atoma runtime 回写层将 tombstone 转换为 `remove(ids)`。
3. 本地 RxDB tombstone 可按策略定期压缩（不影响协议语义）。

## 7.4 冲突语义

1. CAS 冲突由服务端返回 current/master。
2. push 响应 `conflicts[]` 必须是当前主文档快照（含 `version`）。
3. 客户端冲突策略默认 server-wins（后续可扩展策略，不在本期）。

## 7.5 错误映射表（服务端 -> 客户端行为）

| 服务端错误码/类别 | push.handler 行为 | 客户端结果 |
| --- | --- | --- |
| `CONFLICT` | 返回 conflict master 文档 | RxDB 冲突收敛 |
| `NOT_FOUND`（delete/update） | 返回 tombstone 或当前 master | 本地状态向服务端对齐 |
| `INVALID_WRITE`/`validation` | 记录错误并返回 conflict（不中断整批） | 局部失败可见，不阻塞其他行 |
| `INTERNAL`/`adapter` 且可重试 | throw（让 RxDB 重试） | 批次重试 |
| 网络错误/超时 | throw（让 RxDB 重试） | 批次重试 |

---

## 8. 生命周期与状态机

不再自研 lane 状态机，改用 RxDB replication 状态：

- `started`
- `paused`
- `active`
- `error`

插件层状态仅维护：

1. 每个 resource replicationState 引用。
2. 启停控制器。
3. 订阅清理栈（reverse dispose）。

---

## 9. 与现有 Atoma 组件的关系

## 9.1 `PluginContext`

只使用以下能力即可完成重构：

1. `events.on('writeCommitted')`：本地写桥接。
2. `runtime.stores.use/peek/snapshot`：远端回写与去重。
3. `runtime.action.createContext`：写回上下文构造。
4. `services.resolve/register`：可选注入 transport/devtools。

不要求 `runtime` 新增 sync 专有 API。

## 9.2 `atoma-backend-atoma-server`

`WriteCoordinator` 仍可保留给普通 `/ops` 路径；
RxDB 新同步端点不依赖 `WriteCoordinator`，直接调用 `executeWriteItemWithSemantics`。

---

## 10. 一步到位实施计划

## 10.1 代码替换顺序

1. 新建 RxDB 同步模块（client/server/types）。
2. 在同一 PR 内切换 `atoma-sync` 入口到新实现。
3. 删除旧实现目录与类型（engine/lanes/storage/policies）。
4. 删除 `atoma-server` 旧 `changes.pull` 同步主路径与 subscribe 旧用法。
5. 更新 demo/bench/tests 到新端点。

## 10.2 不保留事项（必须删除）

1. `SyncEngine`、`PushLane`、`PullLane`、`NotifyLane`。
2. `DefaultOutboxStore`、`DefaultCursorStore`、`SingleInstanceLock`。
3. 旧 `SYNC_TRANSPORT_TOKEN`/`SYNC_SUBSCRIBE_TRANSPORT_TOKEN` 依赖路径。
4. `operation-driver` 中为同步专用的写 op 分组重复逻辑。

## 10.3 里程碑（建议）

1. `M1`：完成 `atoma-server` 三个新端点 + adapter 能力，集成测试可跑通单资源 pull/push/stream。
2. `M2`：完成 `atoma-sync` RxDB 重写，打通一条资源全链路（create/update/delete）。
3. `M3`：完成多资源、冲突、断网恢复、幂等重试与 devtools 指标。
4. `M4`：删除旧同步实现与旧 server 同步路径，执行全仓 typecheck/test/bench 验收。

---

## 11. 文件级变更清单（目标）

## 11.1 客户端

新增：

- `packages/plugins/atoma-sync/src/rxdb/database.ts`
- `packages/plugins/atoma-sync/src/replication/replication.ts`
- `packages/plugins/atoma-sync/src/bridge/localWriteBridge.ts`
- `packages/plugins/atoma-sync/src/bridge/remoteApplyBridge.ts`
- `packages/plugins/atoma-sync/src/transport/pull.ts`
- `packages/plugins/atoma-sync/src/transport/push.ts`
- `packages/plugins/atoma-sync/src/transport/stream.ts`
- `packages/plugins/atoma-sync/src/mapping/docMapping.ts`
- `packages/plugins/atoma-sync/src/mapping/writeMapping.ts`

重写：

- `packages/plugins/atoma-sync/src/plugin.ts`
- `packages/plugins/atoma-sync/src/types.ts`
- `packages/plugins/atoma-sync/src/index.ts`

删除：

- `packages/plugins/atoma-sync/src/engine/*`
- `packages/plugins/atoma-sync/src/lanes/*`
- `packages/plugins/atoma-sync/src/storage/*`
- `packages/plugins/atoma-sync/src/policies/*`
- `packages/plugins/atoma-sync/src/persistence/SyncWrites.ts`
- `packages/plugins/atoma-sync/src/transport/operation-driver.ts`
- `packages/plugins/atoma-sync/src/drivers/*`

## 11.2 服务端

新增：

- `packages/atoma-server/src/sync-rxdb/contracts.ts`
- `packages/atoma-server/src/sync-rxdb/pull.ts`
- `packages/atoma-server/src/sync-rxdb/push.ts`
- `packages/atoma-server/src/sync-rxdb/stream.ts`
- `packages/atoma-server/src/sync-rxdb/index.ts`

修改：

- `packages/atoma-server/src/createAtomaHandlers.ts`（注册新路由）
- `packages/atoma-server/src/adapters/ports.ts`（sync adapter 新接口）
- `packages/atoma-server/src/adapters/typeorm/TypeormSyncAdapter.ts`（按 resource 拉取与等待）

删除或下线路径：

- `packages/atoma-server/src/ops/subscribeExecutor.ts`（旧同步主路）
- `packages/atoma-server/src/ops/opsExecutor` 中 `changes.pull` 的同步职责

## 11.3 类型层

新增或重写：

- `packages/atoma-types/src/sync/rxdb.ts`
- `packages/atoma-types/src/sync/index.ts`（仅导出新类型）

---

## 12. 测试与验收

## 12.1 单元测试

1. 本地写桥接：`writeCommitted -> RxDB doc` 映射正确。
2. 远端回写桥接：`received$ -> runtime reconcile/remove` 映射正确。
3. tombstone 与版本短路逻辑。
4. push 映射：`new/assumed -> create/update/delete`。

## 12.2 集成测试（client + server + sqlite/typeorm）

1. 单资源全链路：create/update/delete 双端一致。
2. 断网恢复：离线写入 -> 在线自动 push。
3. 冲突场景：双端并发修改，最终收敛一致。
4. SSE 中断重连：`stream` 重连后 `RESYNC` 成功补齐。
5. 幂等场景：重复 push 不产生重复写。

## 12.3 回归测试

1. `runtime` 事件序列未破坏。
2. `origin='sync'` 不触发二次入队。
3. `ops` 普通 query/write 路径不受影响。

## 12.4 通过标准

1. 删除旧同步实现后，`pnpm typecheck` 与 `pnpm test` 全绿。
2. 新同步链路覆盖 create/update/upsert/delete 与冲突恢复。
3. 性能基线不低于当前实现（95 分位 push/pull 延迟不回退 >20%）。

---

## 13. 风险与缓解

1. 风险：RxDB 引入后的 bundle/初始化开销。
   - 缓解：按 resource 懒注册 collection，按需启动 replication。

2. 风险：tombstone 长期累积。
   - 缓解：服务端与客户端均提供 compaction 任务，按 cursor 水位清理。

3. 风险：`assumedMasterState` 缺失导致 delete 语义不明确。
   - 缓解：server push 路径定义 no-op 或返回 tombstone conflict，避免抛硬错误阻断整批。

4. 风险：同端多实例重复同步。
   - 缓解：启用 `waitForLeadership`，仅 leader 执行 live replication。

5. 风险：迁移期间语义漂移。
   - 缓解：先做语义对照测试（旧实现 vs 新实现），再一次性切换并删除旧代码。

---

## 14. 可观测性规范

统一事件命名（示例）：

- `sync.lifecycle.started`
- `sync.lifecycle.stopped`
- `sync.push.batch`
- `sync.pull.batch`
- `sync.conflict.detected`
- `sync.stream.notify`
- `sync.error`

指标：

1. 每 resource 的 `sent/received/conflicts/retries`。
2. 最新 checkpoint（cursor）。
3. push/pull 单批耗时与批大小分布。
4. stream 连接状态与重连次数。

---

## 15. 结论

该方案将 Atoma 同步系统从“自研同步运行时”收敛为“RxDB Replication + Atoma 语义桥接”：

1. 主链路 CRUD 继续由 Atoma runtime 负责，不改 core/runtime。
2. 同步基础设施复杂度由 RxDB 承担，显著减少自研状态机。
3. 服务端继续复用 Atoma 既有写语义、幂等和变更游标机制。
4. 架构一条主路径，不保留 legacy 双实现。

这是在当前约束下，复杂度、语义一致性、可维护性三者平衡最优的方案。

---

## 16. 附录：关键伪代码

## 16.1 本地写桥接

```ts
events.on('writeCommitted', async (event) => {
    if (event.context.origin === 'sync') return
    const resource = mapStoreNameToResource(event.storeName)
    const collection = registry.getCollection(resource)

    const docs = event.changes.map((change) => {
        if (change.after) {
            return toSyncDoc({
                resource,
                entity: change.after,
                deleted: false
            })
        }
        return toSyncDoc({
            resource,
            id: change.id,
            version: (change.before?.version ?? 0) + 1,
            deleted: true
        })
    })

    await collection.bulkUpsert(docs)
})
```

## 16.2 远端回写桥接

```ts
replicationState.received$.subscribe(async (docs) => {
    const byResource = groupByResource(docs)

    for (const [resource, items] of byResource) {
        const session = runtime.stores.use(mapResourceToStoreName(resource))
        const removeIds = items.filter(i => i._deleted).map(i => i.id)
        const upsertItems = items.filter(i => !i._deleted).map(fromSyncDocToEntity)

        const context = runtime.action.createContext({ origin: 'sync' })
        if (upsertItems.length) await session.reconcile({ mode: 'upsert', items: upsertItems }, { context })
        if (removeIds.length) await session.reconcile({ mode: 'remove', ids: removeIds }, { context })
    }
})
```

## 16.3 push 端点处理

```ts
for (const row of request.rows) {
    const intent = toAtomaWriteIntent(row)
    const result = await executeWriteItemWithSemantics(intent)
    if (!result.ok) {
        conflicts.push(await loadMasterDocOrTombstone(intent))
        continue
    }
    await syncAdapter.appendChange(...)
}
return { conflicts }
```

---

## 17. 参考

- RxDB Replication（官方文档）
  - https://rxdb.info/replication.html
  - https://rxdb.info/replication-http.html
- 当前仓库关键实现
  - `packages/plugins/atoma-sync/src/plugin.ts`
  - `packages/plugins/atoma-sync/src/engine/sync-engine.ts`
  - `packages/plugins/atoma-sync/src/storage/outbox-store.ts`
  - `packages/atoma-server/src/ops/writeSemantics.ts`
  - `packages/atoma-server/src/adapters/typeorm/TypeormSyncAdapter.ts`
