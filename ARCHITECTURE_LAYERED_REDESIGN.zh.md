# Atoma 通用分层架构重设计（草案）

日期：2026-01-29  
状态：提案（不要求兼容旧实现，允许重构）

## 1. 背景与目标
当前架构在“store/remote 双通道”与“能力推断策略”上带有明确前提，导致：
- 运行时逻辑对后端语义有隐式假设，抽象不够中性。
- 通道/路由在核心层硬编码，可扩展性不足。
- 新增后端或多端点场景时扩展成本较高。

目标：
- 分层清晰、职责单一、可测试、可替换。
- **按事件名插件化**：核心只调度处理器链，不做策略推断。
- 明确依赖方向：核心运行时仅依赖抽象接口。
- 提供**默认插件集合**，但不做隐式 fallback。

非目标：
- 不要求兼容现有 API/插件。
- 不限定具体同步协议或存储介质。

---

## 2. 架构原则
- **单一职责**：每层只做一件事，并对外提供稳定接口。
- **依赖倒置**：核心运行时仅依赖抽象接口，不依赖具体后端实现。
- **显式接管**：行为由插件注册显式接管，不存在隐式 fallback。
- **有序链式**：同一事件允许多个处理器，按 `priority` + 安装顺序执行。
- **插件负责策略**：核心不内置策略选择逻辑。
- **可组合性**：端点可组合；插件可替换。
- **实现偏好**：核心组件优先采用 `class` 实现，避免函数 builder/闭包式装配。
- **文件命名**：包含 `class` 的文件名必须以大写开头（PascalCase）。

---

## 3. 分层设计（从底到顶）

### L0 协议层（Protocol & Types）
**职责**：定义操作模型、元数据、错误模型、序列化规范。  
**输入/输出**：`OperationEnvelope`、`Meta`、`ResultEnvelope`、标准错误。

### L1 驱动层（Drivers）
**职责**：实现具体存储/远程/通知等能力，对外暴露统一接口。  
**示例接口**：
- `StoreDriver`（本地/持久/内存/SQLite/IndexedDB）
- `RemoteDriver`（HTTP/gRPC/WebSocket）
- `NotifyDriver`（SSE/WS/推送，插件扩展）
- `SyncDriver`（changes.pull/changes.push 或增量同步，插件扩展）
**说明**：核心 `Driver` 仅包含 `executeOps`，其他能力由插件扩展。
**角色约定**：常用角色可统一为 `ops` / `sync` / `notify`，由插件注册端点时指定。

### L2 插件层（Plugin Registry & Interceptors）
**职责**：通过“事件名”注册处理器，形成有序处理链。  
**核心组件**：
- `PluginRegistry`：按事件名注册处理器并排序（class）。  
- `HandlerChain`：标准化处理函数（行业通用责任链，class）。

### L3 运行时内核（Runtime Core）
**职责**：本地状态、写入管线、变更应用、回写处理。  
**不依赖具体后端**：仅调用“按事件名注册”的处理器链。

### L4 默认插件集（Default Plugins）
**职责**：提供一组官方插件，覆盖常见场景。  
**注意**：默认插件**不是 fallback**；必须显式加入插件列表。  
**典型职责**：注册 endpoints、handlers。  
**默认约定**：官方插件应提供 `io/persist/read` 的终结处理器。

### L5 客户端门面与插件（Client Facade & Plugins）
**职责**：提供对外 API、插件扩展、易用性封装。  
**约束**：插件只能依赖上下文接口，不能直接触碰内部状态。

---

## 4. 核心抽象（概念接口）

### 4.0 Driver / Endpoint / Plugin 角色说明
- **Driver**：最低层执行器，只负责把 `OperationEnvelope` 变成 `ResultEnvelope`，不包含策略。  
- **Endpoint**：Driver 的可发现入口（目录条目），结构轻、无逻辑，仅用于按 `role` 查找。  
- **Plugin**：策略与流程的承载者，注册处理器链与端点，缺依赖即显式失败。

### 4.1 端点与驱动
```
Endpoint {
  id: string
  role: string
  driver: Driver
}
```
**说明**：端点只是“执行入口”。不携带策略信息。

### 4.2 插件拦截点（按事件名）
```
HandlerMap {
  io: IoHandler
  persist: PersistHandler
  read: ReadHandler
  observe: ObserveHandler
}
```
**说明**：核心只认事件名与处理器类型，不认具体插件 key。  
**约束**：`sync` / `notify` 不属于核心拦截点，由插件自行扩展 API。
**补充**：`HandlerMap` 只是允许的事件名集合，插件可以选择不注册某些事件。`observe` 为同步链路（返回 `ObservabilityContext`），不允许异步处理器。

### 4.3 I/O 请求包（中性）
```
OperationEnvelope {
  target?: string   // endpoint id 或 role
  ops: Operation[]
  meta: Meta
  context?: ObservabilityContext
  signal?: AbortSignal
}
```
不把通道固定为 `store/remote`，允许扩展或按端点 id 精确路由。

### 4.4 详细接口（TypeScript 草图）
**约束**：配置/接口对象最多两层嵌套。
```ts
// ---- L0: Protocol ----
export type OperationEnvelope = {
    target?: string
    ops: Operation[]
    meta: Meta
    context?: ObservabilityContext
    signal?: AbortSignal
}

export type ResultEnvelope = {
    results: OperationResult[]
    status?: number
}

// ---- L1: Drivers ----
export type Driver = {
    executeOps: (req: OperationEnvelope) => Promise<ResultEnvelope>
    dispose?: () => void | Promise<void>
}

export type Endpoint = {
    id: string
    role: string
    driver: Driver
}

// ---- L2: Plugins ----
export class EndpointRegistry {
    register(ep: Endpoint): () => void
    getById(id: string): Endpoint | undefined
    getByRole(role: string): Endpoint[]
    list(): Endpoint[]
}

export type Next<T> = () => Promise<T>
export type ObserveNext = () => ObservabilityContext

export type IoHandler = (req: OperationEnvelope, ctx: IoContext, next: Next<ResultEnvelope>) => Promise<ResultEnvelope>
export type PersistHandler = (req: PersistRequest, ctx: PersistContext, next: Next<PersistResult>) => Promise<PersistResult>
export type ReadHandler = (req: ReadRequest, ctx: ReadContext, next: Next<QueryResult>) => Promise<QueryResult>
export type ObserveHandler = (req: ObserveRequest, ctx: ObserveContext, next: ObserveNext) => ObservabilityContext

export type HandlerMap = {
    io: IoHandler
    persist: PersistHandler
    read: ReadHandler
    observe: ObserveHandler
}
export type HandlerName = keyof HandlerMap

export type Register = <K extends HandlerName>(
    name: K,
    handler: HandlerMap[K],
    opts?: { priority?: number }
) => () => void

export type HandlerEntry<K extends HandlerName = HandlerName> = {
    handler: HandlerMap[K]
    priority: number
}

export class PluginRegistry {
    register<K extends HandlerName>(
        name: K,
        handler: HandlerMap[K],
        opts?: { priority?: number }
    ): () => void
    list(name: HandlerName): HandlerEntry[]
}

export class HandlerChain {
    constructor(entries: HandlerEntry[])
    execute<TReq, TCtx, TRes>(req: TReq, ctx: TCtx): Promise<TRes>
}

export type IoContext = { clientId: string; endpointId?: string; storeName?: string }
export type PersistContext = { clientId: string; store: string }
export type ReadContext = { clientId: string; store: string }
export type ObserveContext = { clientId: string }

export type PluginContext = {
    clientId: string
    endpoints: EndpointRegistry
    runtime: RuntimeCore
}

export abstract class ClientPlugin {
    abstract id: string
    setup(ctx: PluginContext, register: Register): void
}

// ---- L3: Runtime Core ----
export class RuntimeCore {
    constructor(args: { registry: PluginRegistry })
    io: HandlerChain
    query(args: { store: string; query: Query; context?: ObservabilityContext }): Promise<QueryResult>
    write(args: { store: string; action: WriteAction; items: WriteItem[]; context?: ObservabilityContext }): Promise<WriteResultData>
}

// ---- 插件扩展 Driver（不进入核心抽象）----
export type SyncDriver = Driver & {
    changesPull: (req: ChangesPullRequest) => Promise<ChangeBatch>
}

export type NotifyDriver = Driver & {
    subscribeNotify: (req: NotifySubscribeRequest) => NotifySubscription
}

// ---- L5: Client ----
export type Client = {
    stores: Record<string, StoreFacade>
    dispose: () => void
}
```

---

## 5. 配置模型（ClientConfig）
```ts
export type BackendInput = { baseURL: string }

export type ClientConfig = {
    schema?: AtomaSchema
    backend?: string | BackendInput
    plugins?: ClientPlugin[]
}
```
**要点**：  
- `schema` 置于第一层，作为最小初始化输入。  
- `backend` 是显式“默认插件预设”，不是 fallback。  
- 其余能力（endpoints/runtime）由插件管理。  
- 配置对象最多两层嵌套。
- 插件仅在 `createClient` 初始化时装配，**不再提供 `client.use`**。
**补充**：只有显式提供 `backend` 才会追加默认插件。

### 5A. `backend` 预设展开（示意）
```
createClient({ schema, backend: 'https://api.example.com' })
```
等价于：
```
createClient({
  schema,
  plugins: [HttpBackendPlugin({ baseURL: 'https://api.example.com' })]
})
```
**说明**：这不是 fallback，而是显式的“插件预设”语法糖。

## 6. 初始化流程（createClient）
1. 校验 `ClientConfig`（schema/backend/plugins）。  
2. 先装配用户插件，再追加官方默认插件（`backend` 预设 + `DefaultObservePlugin`）。  
3. `new EndpointRegistry()`。  
4. `new PluginRegistry()` 并构建 `HandlerChain`。  
5. 依次执行插件 `setup`，调用 `register(name, handler, { priority })`。  
6. 按 `priority` 升序、安装顺序进行排序，生成各 scope 处理链。  
7. 校验必需 scope（`io/persist/read/observe`）存在，否则直接失败。  
8. `new RuntimeCore({ registry })` 并注入处理器链。  
9. 返回 `Client` 门面对象。

## 7. 全流程调用（详细）

### 7.1 写入流程（write）
1. `StoreFacade.write(...)` 生成写入意图。  
2. `RuntimeCore.write` 构建 `PersistRequest`。  
3. `PersistHandler` 链按优先级执行（可拦截或调用 `next`）。  
4. 终结 `PersistHandler` 构造 `OperationEnvelope` 并进入 `io` 处理器链。  
5. `IoHandler` 链执行，终结处理器调用 `Driver.executeOps`。  
6. `RuntimeCore` 应用 `writeback` 更新内存态。  
7. 发出 commit 事件、返回结果。

### 7.2 查询流程（query）
1. `StoreFacade.query(...)` 构建 `ReadRequest`。  
2. `ReadHandler` 链按优先级执行（可拦截或调用 `next`）。  
3. 终结 `ReadHandler` 进入 `io` 处理器链。  
4. `io` 处理器链执行并调用 `Driver.executeOps`。  
5. `RuntimeCore` 校验与 transform 后返回数据。

### 7.3 同步与通知（插件扩展）
1. 同步/通知由插件自行扩展 API（如 `client.sync` / `client.notify`）。  
2. 插件内部使用 `SyncDriver` / `NotifyDriver` 扩展接口。  
3. 核心不感知该能力是否存在。

## 7A. 插件如何设计 Driver 扩展（详细）

### 7A.1 设计原则
- 核心 `Driver` 只保留 `executeOps`（最小可执行面）。  
- 任何“额外能力”必须由插件定义扩展接口并自行校验。  
- 插件以“显式失败”为准，不允许 fallback。  
- 不修改核心 `Driver`，避免概念泄漏。

### 7A.2 插件扩展接口（行业常见模式）
```ts
// 插件私有协议：在插件包内定义
export type SyncDriver = Driver & {
    changesPull: (req: ChangesPullRequest) => Promise<ChangeBatch>
}

export type NotifyDriver = Driver & {
    subscribeNotify: (req: NotifySubscribeRequest) => NotifySubscription
}
```

### 7A.3 插件初始化校验（必须）
```ts
// 伪代码：Sync 插件在 setup 时校验
const ep = ctx.endpoints.getByRole('sync')[0]
if (!ep) throw new Error('[SyncPlugin] endpoint(role=sync) not found')
const driver = ep.driver as Partial<SyncDriver>
if (typeof driver.changesPull !== 'function') {
    throw new Error('[SyncPlugin] driver.changesPull is required')
}
```

### 7A.4 插件调用流程（示意）
```
Client.sync.pull(...)
  -> SyncPlugin (resolve endpoint + validate driver)
  -> driver.changesPull(...)
  -> runtime.applyChanges(...)
```

## 7B. 处理器链与 priority 规则（关键）

### 7B.1 注册方式
```
registry.register('persist', handler, { priority: 10 })
```
- `priority` 越小越先执行；相同 `priority` 按插件安装顺序。  
- 未提供 `priority` 时，默认 `0`。
- 官方默认终结处理器建议使用较大的 `priority`（如 `1000`）以稳定处于链尾。

### 7B.2 链式执行约定
- 每个处理器接收 `next`，调用 `next()` 进入后续处理器。  
- **不调用 `next()` 即终止链路**，由该处理器承担“最终执行”。  
- 必需 scope（`io/persist/read/observe`）必须存在，否则初始化失败。  
- `observe` 为**同步链**（不允许 Promise），其余链为异步链。
- 若链路执行到末尾仍调用 `next()`，应直接抛错。

### 7B.3 推荐分工
- `persist`：组织写入、组装 `OperationEnvelope`，决定何时调用 `io`。  
- `io`：统一执行 I/O（鉴权/重试/批处理/调用 driver）。  
- `read`：组织查询、结果校验/转换。

### 7B.4 横切逻辑推荐写法
将鉴权/重试/打点写成 `io` 处理器链的一段前置处理器：
```
registry.register('io', async (req, ctx, next) => {
  // 统一鉴权/重试/打点
  return await next()
}, { priority: -10 })
```
不再提供单独的中间件层。

## 7C. 方案A：按角色端点组合（推荐）

### 7C.1 设计目标
- **不检测 Driver 类型**：Sync/Notify 不去“识别 HttpDriver”。  
- **显式依赖**：插件通过角色端点决定依赖，缺失即报错。  
- **可组合**：HTTP / Sync / Notify 分离，按需安装。

### 7C.2 端点注册（示意）
```
HttpBackendPlugin:
  register endpoint { id: 'http-ops', role: 'ops', driver: HttpDriver }

SyncHttpPlugin:
  register endpoint { id: 'http-sync', role: 'sync', driver: SyncHttpDriver }

NotifySsePlugin:
  register endpoint { id: 'http-notify', role: 'notify', driver: NotifySseDriver }
```
说明：
- `HttpDriver` 只实现 `executeOps`。  
- `SyncHttpDriver` 只实现 `changesPull`（插件扩展接口）。  
- `NotifySseDriver` 只实现 `subscribeNotify`（插件扩展接口）。

### 7C.3 写入策略如何使用 sync 能力
```
PersistHandler:
  if writeStrategy === 'sync':
     ep = ctx.endpoints.getByRole('sync')[0]
     if !ep -> throw
     driver = ep.driver as SyncDriver
     await driver.changesPull(...)
  else:
     ep = ctx.endpoints.getByRole('ops')[0]
     if !ep -> throw
     // 进入 io 处理器链，由终结处理器执行 driver
     await runtime.io.execute(opEnvelope, ioCtx)
```
关键点：
- `writeStrategy` 由插件内部定义与解释。  
- 角色端点缺失时**直接失败**，无 fallback。
- `io` 为运行时内部执行器，仅用于官方终结处理器。

### 7C.4 HTTP + SSE 的组合方式
- `HttpBackendPlugin` 只负责 ops。  
- `NotifySsePlugin` 只负责 notify（EventSource 逻辑在插件内部）。  
- 普通 HTTP 场景不需要安装 `NotifySsePlugin`。  
- 插件之间不相互探测，依赖由角色端点显式表达。

### 7C.5 IndexedDB 场景
- 只安装本地存储插件（注册 `role=ops` 的本地 driver）。  
- 不安装 sync/notify 插件；若误装，必须报错。

### 7C.6 IndexedDB + 在线同步（双端点）
- 安装本地插件：注册 `role=ops` 的 IndexedDB driver。  
- 安装同步插件：注册 `role=sync` 的在线 driver（HTTP/WS/自定义）。  
- 若同步插件仅支持 HTTP，则必须同时提供 HTTP 端点，否则初始化直接失败。

## 7D. 镜像写回（mirror）在插件中的设计

### 7D.1 设计原则
- `mirror` 是**特定策略**，不进入核心 `HandlerMap`。  
- 由插件自行实现与启用，缺依赖即报错。  
- 作为 `persist` 链的**后置步骤**最清晰。

### 7D.2 推荐实现方式
```
registry.register('persist', async (req, ctx, next) => {
  const result = await next()   // 先走主写入
  // 仅在需要时执行镜像写回
  const ep = ctx.endpoints.getByRole('mirror')[0] ?? ctx.endpoints.getByRole('ops')[0]
  if (!ep) throw new Error('[MirrorPlugin] endpoint not found')
  // 组装镜像写入 ops，调用 driver.executeOps(...)
  await mirrorWrite(ep.driver, req)
  return result
}, { priority: 10 })
```
说明：
- 通过 `priority` + `next()` 确保镜像在主写入之后执行。  
- `mirror` 端点角色由插件自定义（可复用 `ops`）。  
- 不需要核心理解“镜像”概念。


### 7.4 错误与取消
- 任何层抛出的错误统一包装为标准错误结构返回。  
- `AbortSignal` 贯穿 `OperationEnvelope`，处理器链必须遵守。
- 必需 scope 为空或链末仍调用 `next()` 时，直接抛错。

---

## 8. 数据流（示意）

### 写入（write）
```
Client API
  -> Runtime Core
    -> PersistHandler 链
      -> io 处理器链
        -> Driver.executeOps(...)
    -> Writeback (apply local state)
```

### 查询（query）
```
Client API
  -> Runtime Core
    -> ReadHandler 链
      -> io 处理器链 -> Driver
  -> Transform/Apply -> 返回
```

### 同步/通知（插件扩展）
```
Client.sync / Client.notify (可选插件)
  -> Plugin Handler
  -> Driver (changes.pull / subscribe)
```

---

## 9. 依赖规则（必须遵守）
- L3 Runtime 不可依赖 L1 Driver 的具体实现。
- L2 插件层不可引用 Runtime 的内部状态。
- 运行时不做策略推断，只按事件名调度处理器链。
- 插件只通过 `PluginContext` 使用受控接口。
- 自定义插件不得直接调用其他处理器链（避免隐式耦合）。

---

## 10. 模块组织建议（示例）
```
src/
  protocol/        // L0
  drivers/         // L1
  plugins/         // L2
  runtime/         // L3
  defaults/        // L4
  client/          // L5
```
各层对外仅暴露抽象接口；具体实现放在 adapters/packages。

---

## 11. 对现有问题的直接改进点

1) **取消“能力推断策略”**
- 不再基于后端能力做默认决策。  
- 行为由插件注册的处理器链显式接管。

2) **取消“通道硬编码”**
- `Runtime` 只调度 `IoHandler` 链。  
- 路由由插件决定，不固定 `store/remote`。

3) **统一 I/O 抽象**
- `IoHandler` 作为标准执行入口。  
- 横切逻辑统一写在 `io` 处理器链中。

---

## 12. 可测试性与演进
- 通过 mock 插件与驱动可进行单元测试。  
- 通过调整插件组合与 `priority` 模拟离线/在线/多端点场景。  
- 逐步替换：先引入插件层，再替换旧通道逻辑。

---

## 13. 重构路线（不兼容版本）
1. 定义插件拦截点与标准 Handler 接口。  
2. 统一 I/O 执行为 `io` 处理器链。  
3. 重写 `Runtime` 为按处理器链调度。  
4. 提供默认插件集合（HTTP/IndexedDB/Memory）。  
5. 清理旧 `store/remote` 硬编码路径。

---

## 14. 风险与需要决策
- 是否强制每个必需 scope **恰好一个**终结处理器？  
- 插件之间是否允许互相调用？
- 错误与重试是否必须由 `IoHandler` 统一处理？
- 处理器 `priority` 是否允许运行期切换？

---

## 15. 分阶段实施方案（建议）

> 目标：逐步落地“事件名处理器链 + 角色端点”的新架构，避免一次性大改难以验证。

### 阶段 0：准备与约束
- 目标：冻结本提案的核心约束（无 fallback、无 middleware、镜像下放插件）。  
- 任务：
  - 明确必需 scope（`io/persist/read`）的终结处理器规则。  
  - 明确 endpoint 角色命名（`ops/sync/notify`）规范。  
- 文档/文件：
  - `ARCHITECTURE_LAYERED_REDESIGN.zh.md`（完善约束与术语）。

### 阶段 1：类型与注册器落地
- 目标：落地 `HandlerMap/PluginRegistry/EndpointRegistry` 类型与实现。  
- 任务：
  - 新增插件注册与处理器链执行器（按 `priority` 排序）。  
  - 新增端点注册与查询能力。  
  - 更新类型导出与入口。  
- 文件/代码：
  - 新增：`packages/atoma/src/plugins/PluginRegistry.ts`（PluginRegistry 实现）  
  - 新增：`packages/atoma/src/plugins/HandlerChain.ts`（处理器链执行器）  
  - 新增：`packages/atoma/src/drivers/EndpointRegistry.ts`  
  - 修改：`packages/atoma/src/client/types/plugin.ts`（替换为事件名处理器链模型）  
  - 修改：`packages/atoma/src/index.ts`（导出新类型）

### 阶段 2：Driver 与 Endpoint 适配
- 目标：把核心 Driver 收敛到 `executeOps`，端点以 role 组织。  
- 任务：
  - 收敛 `Driver` 定义并更新后端适配。  
  - HTTP/IndexedDB/Memory 后端按 role 注册为 endpoint。  
  - 移除旧 `Backend/BackendEndpoint/capabilities` 抽象与 `create*Backend` 路径。  
- 文件/代码：
  - 修改：`packages/atoma/src/backend/types.ts`（仅保留 OpsClient/ExecuteOps）  
  - 修改：`packages/atoma/src/backend/http/*`（仅保留 endpoint）  
  - 修改：`packages/atoma-backend-indexeddb/*`（保留 endpoint）  
  - 修改：`packages/atoma-backend-memory/*`（保留 endpoint）  
  - 删除：`packages/atoma/src/backend/http/createHttpBackend.ts`  
  - 删除：`packages/atoma-backend-indexeddb/src/createIndexedDbBackend.ts`  
  - 删除：`packages/atoma-backend-memory/src/createMemoryBackend.ts`

### 阶段 3：Runtime 接入处理器链
- 目标：运行时只调度处理器链，不再直接依赖 I/O 管线。  
- 任务：
  - 在 runtime 中引入处理器链执行。  
  - `createClient` 组装 endpoint/registry/handlers。  
  - 删除旧 IoPipeline 相关实现。  
  - 引入 `observe` 同步处理链并移除 `client.use`。  
- 文件/代码：
  - 修改：`packages/atoma/src/client/internal/createClient.ts`  
  - 修改：`packages/atoma/src/client/internal/runtime/ClientRuntime.ts`  
  - 删除：`packages/atoma/src/client/internal/infra/IoPipeline.ts`  
  - 删除：`packages/atoma/src/client/internal/infra/ChannelApis.ts`

### 阶段 4：默认插件与扩展能力
- 目标：提供官方插件集合（HTTP/IndexedDB/Sync/Notify），并按角色端点组合。  
- 任务：
  - 默认插件注册 `io/persist/read` 终结处理器。  
  - 默认插件补齐 `observe` 终结处理器。  
  - Sync/Notify 作为插件扩展能力注册 `role=sync/notify`。  
  - `backend` 预设只负责追加官方默认插件。  
- 文件/代码：
  - 新增：`packages/atoma/src/defaults/HttpBackendPlugin.ts`  
  - 新增：`packages/atoma/src/defaults/DefaultObservePlugin.ts`  
  - 新增：`packages/atoma/src/defaults/IndexedDbPlugin.ts`  
  - 新增：`packages/atoma/src/defaults/SyncHttpPlugin.ts`  
  - 新增：`packages/atoma/src/defaults/NotifySsePlugin.ts`  
  - 修改：`packages/atoma/src/client/internal/createClient.ts`（处理 backend 预设）

### 阶段 5：清理与验证
- 目标：删除旧路径、补齐测试与文档。  
- 任务：
  - 清理旧通道/旧 plugin 系统代码。  
  - 新增处理器链与插件组合测试（如 `tests/core/HandlerChain.test.ts`）。  
  - 更新 README 与示例。  
  - 迁移/重写 `atoma-sync` / `atoma-history` / `atoma-devtools` 等旧插件包。  
- 文件/代码：
  - 删除：`packages/atoma/src/client/internal/infra/*`（旧体系）  
  - 新增：`tests/core/PluginChain.test.ts`  
  - 修改：`README.md` / `README.zh.md` / `todo_docs/*`

---

## 16. 小结
该方案将“策略与执行”完全交给插件，以“事件名 + 处理器链”显式接管核心流程，取消能力推断与硬编码通道。默认插件集合提供常见实现，但**不作为 fallback**，避免语义歧义。核心运行时保持中性、可替换，适合重构与长期演进。
