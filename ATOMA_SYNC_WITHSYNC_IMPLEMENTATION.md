# `withSync(client)` 方案定稿：以中性插件系统为底座，`withSync` 只是语法糖（实现说明）

目标：参考 Slate 的 `withHistory(editor)`，把同步能力作为 **可选扩展** 注入 Atoma Client：

```ts
import { createClient } from 'atoma/client'
import { withSync } from 'atoma-sync'

const client = withSync(createClient(opts), syncOpts)
client.sync.start('full')
```

硬性目标（破坏式迁移，一步到位）：
- Atoma 主包只提供 **插件系统底座** + **中性扩展点**（不出现 sync 强绑定的 host/adapter 命名）
- 同步的 wiring / engine / outbox / cursor / transport / applier 全部归 `atoma-sync`
- `withSync(client, opts)` 是 `client.use(syncPlugin(opts))` 的语法糖
- 不做 V2/兼容层；直接迁移掉 `createClient({ sync: ... })` 等旧入口

---

## 1. 为什么像 `slate-history`（以及其它开源模式）

`slate-history` 的核心是：核心不懂 history，插件只拦截“关键路径”（`apply`），并把能力挂回 editor。

映射到 Atoma：
- “关键路径” = `CoreRuntime.persistence.persist(req)`（所有写入最终都会走 Persist Pipeline）
- sync 插件负责：选择持久化策略（direct / queue / local-first / …）→ outbox → push/pull/subscribe → writeback
- client 本体只提供稳定、中性扩展点，不感知外部是 sync 还是别的扩展

同类的成熟模式（思路一致，只是关键路径不同）：
- ProseMirror：`Plugin`（插件 state/props/view 组合进编辑器）
- CodeMirror 6：`Extension`（配置即扩展，通过组合扩展改变能力）
- Redux：middleware/enhancer（以 dispatch 为关键路径）
- Koa/Express：middleware 链（以 request/response 为关键路径）
- unified（remark/rehype）：插件链（以 AST transform 为关键路径）

结论：Atoma 的最佳关键路径就是 `persistence.persist`；它天然是“副作用/落地”的集中入口。

---

## 2. 设计选项对比：`withSync` 是不是最好？

先明确：**最佳底座一定是 `client.use(plugin)`**。`withSync` 是否“最好”，取决于你想把入口做成哪种风格。

### 2.1 `withSync(client, opts)`（enhancer / 语法糖）
- 优点：上手最顺、最像 Slate；一眼知道“给 client 加同步”
- 缺点：如果只有 `withXxx` 没有 plugin 底座，未来扩展会碎片化

### 2.2 `client.use(syncPlugin(opts))`（推荐作为架构核心）
- 优点：可组合（devtools/history/sync 都是 plugin）；生命周期统一（dispose）；更容易做“只暴露中性上下文”
- 缺点：对新用户略啰嗦

### 2.3 `createClient({ plugins: [...] })`（可选）
- 优点：集中配置、易于预设（preset）
- 缺点：会让 createClient 的 schema/选项膨胀；不利于“atoma 不依赖 atoma-sync”

### 2.4 `Sync = createSyncClient(client)` / `createSync(client)`（可行但不如 withSync）
- 优点：直观
- 缺点：很容易演化成“sync 包不得不认识 client 的内部结构”，最终又回到 host/适配层泥潭

定稿建议：
- 对外主入口保留 `withSync(client, opts)`（符合你想要的“一步到位”）
- 架构底座以 `client.use(plugin)` 为核心；`withSync = client.use(syncPlugin(opts))`

---

## 3. Atoma 主包需要提供的最小“中性扩展点”

为了让 `atoma-sync` 不依赖 `packages/atoma/src/client/internal/*`，Atoma 需要把“插件可用能力”收敛成一个 **中性上下文**。

### 3.1 插件底座：`client.use(plugin)` + `client.dispose()`

建议对外类型（示意）：

```ts
export type ClientPlugin<TExt extends object = {}> = {
    name: string
    setup: (ctx: ClientPluginContext) => {
        extension?: TExt
        dispose?: () => void
    }
}

export type PluginCapableClient = {
    use: <TExt extends object>(plugin: ClientPlugin<TExt>) => PluginCapableClient & TExt
    dispose: () => void
}
```

### 3.2 中性插件上下文：`ClientPluginContext`

`ClientPluginContext` 必须做到：
- 命名上不出现 sync 专有词
- 能覆盖 sync 的最小需求，但也能服务其它扩展（devtools、审计、离线缓存、批处理等）

建议最小能力集合（按用途分）：

1) 生命周期
```ts
onDispose: (fn: () => void) => () => void
```

2) persistence 扩展点（核心）
- 通过 `PersistKey` 路由（core 对 key 语义完全不关心，只透传）
- handler 能调用 `next(req)`（通常就是 direct persist）

```ts
import type { Entity, PersistKey, PersistRequest, PersistResult } from 'atoma/core'

export type PersistHandler = <T extends Entity>(args: {
    req: PersistRequest<T>
    next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
}) => Promise<PersistResult<T>>

persistence: {
    register: (key: PersistKey, handler: PersistHandler) => () => void
}
```

3) writeback（把外部结果写回本地 store）
```ts
import type { Entity, PersistWriteback, StoreToken } from 'atoma/core'

writeback: {
    apply: <T extends Entity>(storeName: StoreToken, writeback: PersistWriteback<T>) => Promise<void>
}
```

4) （可选）后端/remote 能力
- 不要求 Atoma 内置 sync endpoint 归一化
- sync 插件可以自己基于 `withSync(opts.endpoint)` 构造远端 opsClient/subscribe
- 但如果 Atoma 已经有“backend 解析器”，也可以把解析后的 handle 以中性字段暴露（如 `ctx.backend.local/ctx.backend.remote`）供插件复用

---

## 4. `atoma-sync` 里 `withSync` 的实现分层

### 4.1 纯工具层（atoma-sync 内部）
- Outbox / Cursor / Lock / Engine / Transport 都属于 atoma-sync 自己的实现
- 这些模块不依赖 atoma/client，只依赖 `atoma/core`（协议与 opsClient 类型）

### 4.2 `SyncApplier`（协议结果 → `ctx.writeback.apply(...)`）
- `applyPullChanges(changes)`：按 resource 聚合 change，必要时补 fetch，再 writeback
- `applyWriteAck/Reject`：按冲突策略把 current.value 转成 upsert/delete，再 writeback

要点：applier 只依赖 `ClientPluginContext.writeback`（中性能力），不需要任何 sync 专用 host/适配层。

### 4.3 插件注入（关键：persistKey 策略）

`withSync`/`syncPlugin` 通过 `ctx.persistence.register(...)` 接管两种策略：

- queue 模式：`persistKey = 'sync:queue'`
  - handler：只 enqueue outbox → 返回 `{ status: 'enqueued' }`

- local-first 模式：`persistKey = 'sync:local-first'`
  - handler：先 `next(req)` direct persist 拿到 confirmed/writeback → enqueue outbox → 返回 `{ status: 'enqueued', writeback }`

注意：`sync:*` 只是 key 字符串约定（属于插件自己的命名空间）；Atoma core 不应出现任何 `sync:` 分支。

### 4.4 `sync` 扩展字段挂载

`syncPlugin.setup(ctx)` 返回：
- `extension: { sync: { start/stop/dispose/status/pull/push/devtools? } }`
- `dispose: () => { stop; release lock; abort in-flight; unsubscribe }`

并通过 `ctx.onDispose(...)` 确保 client dispose 时同步也自动清理。

---

## 5. 一次性迁移计划（无兼容层）

### 5.1 Atoma（主包）需要做什么
- 增加插件系统：`client.use(plugin)` / `client.dispose()` / `ctx.onDispose(...)`
- 把 `CoreRuntime.persistence.persist` 实现为“可注册 handler 的路由器”（对外暴露 `ctx.persistence.register`）
- 通过 ctx 暴露 `writeback.apply(...)`

必须移除/迁出（不再由 atoma/client 内置 sync）：
- `createClient({ sync: ... })` 相关 schema/类型/实现
- `SyncController`、`resolveSyncWiring/resolveSyncRuntimeConfig`、`SyncReplicatorApplier`、sync diagnostics（迁到 atoma-sync 或直接删除）
- atoma 包对 atoma-sync 的依赖（`atoma` → `atoma-sync` 必须断开）

### 5.2 atoma-sync（扩展包）需要新增什么
- `syncPlugin(opts)`（底座入口）
- `withSync(client, opts)`（语法糖主入口）
- 可选：给 store 挂 `Outbox` 视图（纯 UX，不是 core 必需）

---

## 6. 验收标准

功能：
- 不安装/不使用 `withSync`：client 行为完全不变
- 使用 `withSync`：`client.sync.*` 可用；`stop/dispose` 后不再发请求/不再 apply
- outbox 满时行为明确（抛错 + 事件上报），不会 silent drop
- retry 边界只包 transport（不重试 applier/store）

工程：
- `pnpm -w typecheck` 通过
- `pnpm -w test` 通过
- 依赖关系：`atoma-sync` 依赖 `atoma`（core/client 类型）；`atoma` 不依赖 `atoma-sync`

---

## 7. 实现顺序（最短路径）

1) 在 `atoma` 落地插件系统：`use`/`dispose`/`ClientPluginContext`
2) 在 `atoma` 把 persistence 改为可注册路由器（并把注册能力挂到 ctx）
3) 在 `atoma` 把 writeback.apply 挂到 ctx（稳定、中性）
4) 在 `atoma-sync` 实现 `syncPlugin/withSync`：注册 `sync:queue`/`sync:local-first` 两个 persist handler + 启动引擎
5) 删除/迁移 atoma 内置 sync 旧实现，并更新对外导出与文档
