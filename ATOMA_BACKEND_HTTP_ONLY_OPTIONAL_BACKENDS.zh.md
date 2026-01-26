# Backend 不集成进 Client（默认仅 HTTP）设计方案（一次到位）

本文目标：在不把 IndexedDB/SQLite/Dexie 等重依赖集成进 `atoma-client` 的前提下，仍保持：
- `createClient` 易用（默认可直接用 HTTP）
- 插件体系（`ClientPluginContext`）稳定、可拦截（单一 I/O pipeline）
- 依赖图单向、可按需安装不同 backend

> 前置文档：`ATOMA_PACKAGE_SPLIT_PLAN.zh.md`、`ATOMA_BACKEND_EXTRACTION_PLAN.zh.md`、`ATOMA_BACKEND_SPLIT_WITH_PLUGIN_CLIENT.zh.md`

---

## 1. 核心结论

1) `atoma-client` **只内置 HTTP endpoint**（不引入额外依赖；使用浏览器/运行时自带 `fetch/EventSource` 或允许注入）。
2) 所有非 HTTP backend（IndexedDB/SQLite/Memory/Batch 等）都拆成独立包，用户**显式安装并在构造期注入**。
3) 插件（包括 sync）**不提供** `registerOpsClient` 之类能力；backend/通道装配只发生在 `createClient(...)` 阶段，避免运行期顺序冲突与绕过 pipeline。

---

## 2. 问题背景：为什么不能把所有 backend 集成到 client

backend 往往会带来：
- 平台/环境差异：IndexedDB（Web）、SQLite（Node/RN）、不同 fetch polyfill
- 重依赖：Dexie、SQLite driver、批处理/重试库等
- 类型污染：例如把 Dexie 的 `Table` 类型暴露在 `atoma-client` 公共类型里，会迫使用户安装 Dexie（哪怕不用 IDB）

因此最优解是：**client 只承诺“装配能力 + 拦截能力 + 高阶 API”**，具体实现（backend）用户按需安装。

---

## 3. 最小稳定接口：BackendEndpoint（构造期注入）

本方案的关键变化：`createClient` 不再接收 `store/remote/storeBatch/...` 这类“装配配置”，而是只接收一个 **backend 对象**。

### 3.1 `OpsClient`（最小执行接口）

backend 的最小职责是“执行协议 ops”：

```ts
export type OpsClient = Readonly<{
    executeOps: (input: {
        ops: import('atoma-protocol').Operation[]
        meta: import('atoma-protocol').Meta
        signal?: AbortSignal
        context?: import('atoma-observability').ObservabilityContext
    }) => Promise<{
        results: import('atoma-protocol').OperationResult[]
        status?: number
    }>
}>
```

### 3.2 `NotifyClient`（可选：订阅通知，保持中性）

不直接在类型里暴露 `EventSource/WebSocket` 等平台类，而是抽象成 `subscribe -> unsubscribe`，方便未来接入 SSE/WS/RTC/自定义长连：

```ts
export type NotifyMessage = Readonly<{ resources?: string[]; traceId?: string }>

export type NotifyClient = Readonly<{
    subscribe: (args: {
        resources?: string[]
        onMessage: (msg: NotifyMessage) => void
        onError: (err: unknown) => void
        signal?: AbortSignal
    }) => { close: () => void }
}>
```

### 3.3 `BackendEndpoint`（通道端点：store/remote 的实现载体）

```ts
export type BackendEndpoint = Readonly<{
    /** 协议执行器：最终由 I/O pipeline 调用 */
    opsClient: OpsClient

    /** 可选：远端通知通道（SSE/WS/...） */
    notify?: NotifyClient

    /** 可选：能力声明（client 读能力，不读配置） */
    capabilities?: Readonly<{
        supportsBatch?: boolean
    }>
}>
```

### 3.4 `Backend`（createClient 唯一输入：由 backend 自己关注 role/remote/batch）

```ts
export type Backend = Readonly<{
    /** 稳定标识：用于 clientKey、插件命名空间、缓存隔离等 */
    key: string

    /** store 端点：ctx.store 的底层实现 */
    store: BackendEndpoint

    /** 可选 remote 端点：ctx.remote 的底层实现（sync/notify/changes.pull 依赖它） */
    remote?: BackendEndpoint

    /** 可选：能力声明（用于决定是否做 durable mirror 等行为） */
    capabilities?: Readonly<{
        storePersistence?: 'ephemeral' | 'durable' | 'remote'
    }>

    /** 可选：释放资源（sqlite 连接、订阅、文件句柄等） */
    dispose?: () => void | Promise<void>
}>
```

> 关键点：client 不再需要理解 “`store.role`/`remote`/`storeBatch`” 这些装配选项；它只看 `Backend` 的端点与能力。Dexie/SQLite 等类型也不会泄露到 `atoma-client` 公共类型里。

---

## 4. `createClient` 的推荐输入结构（不再接收“多 backend union config”）

### 4.1 建议的 client 构造形态（只接收 backend）

```ts
createClient({
  schema,
  backend: createHttpBackend({ baseURL: '...' }),
  plugins: [sync()],
})
```

- `backend.store`：用于 `ctx.store.query/write`（以及 client 内部 store 请求）
- `backend.remote?`：用于 `ctx.remote.*`（sync 的 `changes.pull/notify` 等依赖它；没有就表示“无远端能力”）
- durable mirror、批处理、重试、鉴权等，都由 backend 自己关注（通过 options 或 backend 装饰器实现），client 不再暴露对应配置开关。

### 4.2 组合场景（本地 store + 远端 remote）

当你希望 store 是本地 durable（IndexedDB/SQLite），同时 remote 走 HTTP（给 sync 用），推荐用组合 backend（由 backend 层提供 helper）：

```ts
const backend = composeBackend({
  key: 'local+remote',
  store: createIndexedDbBackend({ dbName: 'atoma' }),
  remote: createHttpBackend({ baseURL: '...' }),
})

createClient({ schema, backend, plugins: [sync()] })
```

> `composeBackend` 的规则应当非常简单：取 `store` 的 store 端点、取 `remote` 的 remote 端点，并合并/串联 `dispose()`。

### 4.3 HTTP backend 是否需要“语法糖”

需要，而且应该是默认路径（行业惯例：80% 场景一行可用，剩下的通过更低阶组合扩展）。

推荐只保留一套命名：
- `createHttpBackend(options)`：返回完整 `Backend`（默认同时提供 `store` 与 `remote`，最符合直觉）
- `composeBackend(...)`：用于跨 backend 组合（例如 SQLite + HTTP）

不建议把 `httpEndpoint` 作为主要对外入口；端点级别的拼装更像“内部实现细节”，会把用户带回“client 装配层”的心智负担。

---

## 5. 非 HTTP backend 的包形态（用户显式安装）

以“独立包 + 工厂函数返回 `Backend`”为统一模式（backend 自己关注 store/remote/batch 等）：

- `atoma-backend-indexeddb`
  - 依赖 Dexie/IDB 等
  - 导出 `createIndexedDbBackend(config) => Backend`
  - config 类型仅存在于该包内部/导出，不污染 `atoma-client`

- `atoma-backend-sqlite`
  - 依赖 SQLite driver
  - 导出 `createSqliteBackend(config) => Backend`

- `atoma-backend-memory`
  - 导出 `createMemoryBackend(config?) => Backend`

> 不提供 `atoma-web/atoma-node` 预设包（按当前要求），组合由用户显式安装与注入完成。

---

## 6. 与 Plugin/Sync 的结合方式（禁止 registerOpsClient）

### 6.1 为什么不能给插件暴露 `registerOpsClient`

运行期注册/替换 backend 会导致：
- 绕过/破坏单一 I/O pipeline 的可控性
- 插件间顺序冲突与生命周期复杂化（谁覆盖谁、卸载后恢复谁）
- 同一份 `createClient` 配置在不同插件组合下行为不稳定

因此：
- backend/通道装配只允许发生在 `createClient(...)` 阶段
- 插件只能：
  - `ctx.io.use(mw)` 做横切拦截
  - `ctx.store/ctx.remote` 做业务请求
  - `ctx.writeback.commit` 做权威写回落地

### 6.2 sync 的依赖边界
`atoma-sync` 作为插件包：
- 只依赖 `atoma-client` 暴露的 `ClientPluginContext`
- 通过 `ctx.remote.*` 与 `ctx.writeback.commit` 工作
- 不依赖任何 backend 实现包（HTTP/IDB/SQLite 都不需要被 sync 直接 import）

---

## 7. 依赖图约束（拆包后必须成立）

必须保持：
- `atoma-core` 不依赖任何 backend 实现
- `atoma-client` 只内置 HTTP（零依赖），其它 backend 通过 `BackendEndpoint` 注入
- `atoma-sync` 依赖 `atoma-client`（插件 API），但 `atoma-client` 不依赖 `atoma-sync`

---

## 8. 落地步骤（概念级，一次到位）

1) 把 `createClient` 的公开入参从“多 backend union config”改为“只接收 `backend: Backend`”。
2) `atoma-client` 内置 `createHttpBackend(...)`（零依赖），其余 backend 从 `atoma-client` 代码与类型中移除。
3) 为 IndexedDB/SQLite/Memory 等分别建立独立 backend 包，各自导出 `createXxxBackend(...) => Backend`（必要时提供 `composeBackend`/装饰器）。
4) 保持插件 API 不变（只走 `ctx.store/ctx.remote/ctx.writeback.commit` + `ctx.io.use`），禁止插件在运行期注册/替换 backend。
