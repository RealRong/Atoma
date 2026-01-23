# `withSync(client)` 实现说明：同步插件完全依赖 `ctx.io`（破坏式迁移，一步到位）

目标：参考 Slate 的 `withHistory(editor)`，把同步能力作为 **可选插件** 注入 Atoma Client，但同步包不再自建任何 HTTP/SSE 客户端；所有 I/O 都走 client 的中性可拦截入口 `ctx.io`。

对外用法：

```ts
import { createClient } from 'atoma/client'
import { withSync } from 'atoma-sync'

const client = withSync(
    createClient({
        schema,
        store: { type: 'indexeddb', tables },
        // 关键：远端通道由 client 统一配置（供插件使用）
        remote: { url: 'https://api.example.com', sse: '/sync/subscribe' }
    }),
    { mode: 'full' }
)

client.sync.start()
```

硬性约束（本仓库允许破坏式变更）：
- `withSync(client, opts)` 只是 `client.use(syncPlugin(opts))` 的语法糖
- `atoma-sync` 不接收/不解析 endpoint，不构造 `HttpOpsClient`/`EventSource`
- 同步、审计、缓存、限流等插件都只能依赖 `ctx.io`，以便统一拦截与观测

---

## 1. 必须依赖的 client 中性扩展点

同步插件只依赖 `ClientPluginContext` 的中性能力（命名不出现 sync 专有词）：
- `ctx.io.executeOps({ channel, ops, meta, signal, context })`
- `ctx.io.subscribe?({ channel, resources, onMessage, onError, signal })`
- `ctx.persistence.register(persistKey, handler)`
- `ctx.writeback.apply(storeName, writeback)`
- `ctx.acks.ack/reject`
- `ctx.onDispose(fn)`

其中 `channel` 固定为：
- `store`：正常 CRUD（Store 永远走这个通道）
- `remote`：插件访问远端（sync 等扩展包使用）

---

## 2. `withSync/syncPlugin` 在 atoma-sync 内的分层

`atoma-sync` 内部保持纯分层（不依赖 atoma/client 内部实现）：
- outbox/cursor/lock：纯存储与并发控制
- transport：只依赖 `OpsClientLike.executeOps` 与可选 `subscribe`
- engine（pull/push/notify lanes）：调度与重试/退避
- applier：把 pull/ack/reject 结果转换为 `ctx.writeback.apply(...)`

`withSync` 负责“把这些层 wiring 在一起”，但 wiring 的 I/O 部分只做一件事：把 `ctx.io` 适配成 `OpsClientLike` 与 `SyncSubscribe`。

---

## 3. I/O 适配（核心）

1) 远端 ops：
- `remoteOpsClient.executeOps(input)` → `ctx.io.executeOps({ channel: 'remote', ...input })`

2) 远端订阅（可选）：
- 当且仅当 `ctx.io.subscribe` 存在时启用 subscribe lane
- `ctx.io.subscribe` 的 `onMessage` 载荷是 `unknown`，同步插件负责 decode：
  - `string`：按协议 `Protocol.sse.parse.notifyMessage` 解析
  - `object`：允许上游 I/O 已经解码成 `{ resources?, traceId? }`

---

## 4. 与 Store 的配合（persistKey 策略）

同步插件通过 `ctx.persistence.register(...)` 接管两条策略（仅是 key 字符串约定；core 不关心语义）：
- `sync:queue`：只 enqueue outbox（正常 CRUD 仍可用；只是写确认语义变成“已入队”）
- `sync:local-first`：先 `next(req)` 写入本地（confirmed/writeback），再 enqueue outbox

并且（可选）在 `client.Store(name)` 返回的 store 上挂一个非枚举 getter：`store.Outbox`，指向一个使用上述 persistKey 的 view，避免污染默认 CRUD 路径。

---

## 5. 迁移要点（无兼容层）

- 删除 `withSync(opts.endpoint)`：远端必须通过 `createClient({ remote })` 或 remote store 隐式提供
- 同步相关的 HTTP/SSE 配置属于 client 的 remote 通道（中性、可复用、可拦截）
- `atoma-sync` 的导出只保留 4 个主入口：`withSync` / `syncPlugin` / `WithSyncOptions` / `WithSyncExtension`
