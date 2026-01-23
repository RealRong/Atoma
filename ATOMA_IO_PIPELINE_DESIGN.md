# Atoma Client I/O Pipeline 设计（中性、可拦截、供插件复用）

本文定义一套**唯一**的设计：Atoma Client 对插件暴露一个中性的 `io` 管线（middleware/pipeline），所有“对外/对内”的 ops 调用（query/write/pull/任意协议 op）都必须走该管线。

允许破坏式变更：目标是一步到位把同步、未来的其他插件（auth、限流、观测、缓存、离线策略等）都统一到同一条可拦截 I/O 路径。

---

## 1. 背景问题

当前典型耦合点：某些插件（例如同步）会**自行构造** HTTP ops client / SSE 订阅（例如 `new HttpOpsClient(...)` / `new EventSource(...)`）。

这会导致：
- 其他插件无法拦截这些网络请求（无法统一注入 token、trace、重试、限流、审计、mock、record-replay）。
- 同一个 Client 里出现两套 I/O 行为（Store 一套，插件另一套），配置容易漂移。

结论：真正需要的不是“某个插件不要依赖 opsClient”，而是**所有 I/O 都必须从 client runtime 的统一入口经过**。

---

## 2. 目标

- **中性命名**：API 不出现同步专有词（例如不叫 SyncHost）。
- **行业规范**：使用常见术语 `io` / `channel` / `middleware` / `handler`。
- **尽量简洁**：只提供最小可用接口。
- **可拦截**：插件能在 I/O 的关键路径上插入中间件。
- **可分流**：同一 Client 允许多个 I/O 通道（最少 `store` 与 `remote` 两个）。

---

## 3. 核心设计：`ctx.io`（I/O 管线）

### 3.1 通道（channel）

`channel` 是 I/O 的逻辑分流标识，用于让插件做到“只拦截某一类请求”。

固定两个通道（足够覆盖绝大多数场景）：
- `store`：Store 直接 CRUD 所用（可能是本地 durable，也可能是远端）。
- `remote`：可选的远端通道（给任何扩展包使用：同步、实时订阅、后台任务等）。

说明：`remote` 是中性概念，不代表一定用于同步。

### 3.2 统一的 ops 执行入口

I/O 层只暴露一个通用操作：`executeOps`。原因：Atoma 的协议已经把 query/write/changesPull 等语义统一为 ops。

建议在 `ClientPluginContext` 上新增：

```ts
export type IoChannel = 'store' | 'remote'

export type IoExecuteOpsRequest = {
    channel: IoChannel
    ops: import('atoma/protocol').Operation[]
    meta: import('atoma/protocol').Meta
    signal?: AbortSignal
    context?: import('atoma/observability').ObservabilityContext
}

export type IoExecuteOpsResponse = {
    results: import('atoma/protocol').OperationResult[]
    status?: number
}

export type IoHandler = (req: IoExecuteOpsRequest) => Promise<IoExecuteOpsResponse>

export type IoMiddleware = (next: IoHandler) => IoHandler

export type ClientIo = {
    executeOps: IoHandler
    use: (mw: IoMiddleware) => () => void
}

export type ClientPluginContext = {
    io: ClientIo
    // 其它字段省略
}
```

关键点：
- `io.executeOps` 是唯一入口。
- `io.use(middleware)` 是唯一扩展方式。
- middleware 必须是纯函数式链式组合，顺序明确，易测试。

### 3.3（可选）订阅入口（subscribe）

订阅不是所有通道都支持，因此建议以可选能力提供：

```ts
export type IoSubscribeRequest = {
    channel: IoChannel
    resources?: string[]
    onMessage: (msg: unknown) => void
    onError: (err: unknown) => void
    signal?: AbortSignal
}

export type IoSubscribe = (req: IoSubscribeRequest) => { close: () => void }

export type ClientIo = {
    executeOps: IoHandler
    subscribe?: IoSubscribe
    use: (mw: IoMiddleware) => () => void
}
```

约束：
- `subscribe` 只负责“建立连接/转发消息/关闭”，消息体保持 `unknown`。
- 消息解析（例如把 SSE data 解析为 notify message）属于上层扩展包。

---

## 4. Client runtime 的责任边界

### 4.1 runtime 负责创建“底层 handler”

Atoma Client 构造时（`createClient`）必须把底层 I/O handler 装配好：
- `store` 通道的底层 handler：来自 store backend（HTTP / IndexedDB / memory / custom）。
- `remote` 通道的底层 handler：来自可选的 remote backend（通常是 HTTP + 可选 SSE）。

然后由 `io.use(...)` 把 middleware 链包在底层 handler 之外。

### 4.2 插件只能通过 `ctx.io` 做 I/O

任何插件（包含同步）不得自行 new 网络客户端。

插件做 I/O 的唯一方式：
- `ctx.io.executeOps({ channel: 'remote', ... })`
- 订阅：`ctx.io.subscribe?.({ channel: 'remote', ... })`

这样所有 I/O 都能被统一拦截。

---

## 5. 插件拦截示例（单一范式）

### 5.1 Auth 插件（注入 token）

Auth 插件只需要注册一个 middleware：
- 读取 token
- 在 `meta` 或请求上下文里注入（由底层 HTTP handler 解释）

关键是：它会同时作用于 Store CRUD 与任何扩展包的请求，只要它们走 `ctx.io`。

### 5.2 Observability/Tracing 插件

同样通过 middleware：
- 如果 req.context 缺 traceId，则创建
- 统一记录耗时、错误、重试次数

---

## 6. atoma-sync（withSync）的对接方式（唯一方案）

### 6.1 远端 I/O 来源

`withSync` 不再接受/解析 endpoint 来构造 HttpOpsClient。

`withSync` 只做两件事：
- 注册持久化策略（`ctx.persistence.register('sync:queue' | 'sync:local-first', ...)`）
- 启动同步引擎，并通过 `ctx.io` 访问远端：
  - pull/push：`ctx.io.executeOps({ channel: 'remote', ... })`
  - subscribe：`ctx.io.subscribe?.({ channel: 'remote', ... })`

当 `remote` 未配置时：`withSync` 直接抛错（配置缺失）。

### 6.2 本地 durable mirror（可选）

是否需要把 pull/ack/reject 的结果写入 durable local backend，不应该由同步插件通过 runtime“猜”。

唯一规则：
- 若需要 mirror，则由 client 提供一个明确的 I/O 通道（通常是 `store` 且角色为 local）。
- withSync 只调用 `ctx.io.executeOps({ channel: 'store', ... })` 进行 mirror（或完全不做 mirror）。

---

## 7. 破坏式迁移计划（一步到位）

1) Atoma Client：在 `ClientPluginContext` 增加 `io`（如上定义），并让 Store 的所有 ops 都走 `ctx.io.executeOps({ channel: 'store' })`。
2) Atoma Client：`createClient` 增加中性的 `remote` 配置（与 `store` 同级），用于构造 `remote` 通道底层 handler。
3) atoma-sync：`withSync` 移除 `endpoint`/HTTP 构造逻辑，改为依赖 `ctx.io` 的 `remote` 通道。
4) 删除任何“插件自行构造网络客户端”的路径（包括 SSE）。

---

## 8. 验收标准

- 任意插件发起的 ops 请求，都能被一个统一的 middleware（例如 auth）拦截到。
- `store` 与 `remote` 通道行为可独立配置（不同 retry/限流策略也可通过 middleware 实现）。
- withSync 不再包含 endpoint 解析与 HttpOpsClient 构造逻辑；同步的 I/O 完全走 `ctx.io`。
- API 命名中性、简单：对外只暴露 `io.executeOps` / `io.use`（+ 可选 `io.subscribe`）。
