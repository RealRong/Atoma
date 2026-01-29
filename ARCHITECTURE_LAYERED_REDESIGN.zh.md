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
- `PluginRegistry`：按事件名注册处理器并排序。  
- `Handler Chain`：标准化处理函数（行业通用责任链）。  
- `IoPipeline`：可选中间件链，用于通用横切。

### L3 运行时内核（Runtime Core）
**职责**：本地状态、写入管线、变更应用、回写处理。  
**不依赖具体后端**：仅调用“按事件名注册”的处理器链。

### L4 默认插件集（Default Plugins）
**职责**：提供一组官方插件，覆盖常见场景。  
**注意**：默认插件**不是 fallback**；必须显式加入插件列表。  
**典型职责**：注册 endpoints、handlers，并按需注入中间件。

### L5 客户端门面与插件（Client Facade & Plugins）
**职责**：提供对外 API、插件扩展、易用性封装。  
**约束**：插件只能依赖上下文接口，不能直接触碰内部状态。

---

## 4. 核心抽象（概念接口）

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
  mirror?: MirrorHandler
  observe?: ObserveHandler
}
```
**说明**：核心只认事件名与处理器类型，不认具体插件 key。  
**约束**：`sync` / `notify` 不属于核心拦截点，由插件自行扩展 API。

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
    hints?: { readOnly?: boolean; priority?: 'low' | 'normal' | 'high' }
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
    meta?: Record<string, any>
}

// ---- L2: Plugins ----
export type EndpointRegistry = {
    register: (ep: Endpoint) => () => void
    getById: (id: string) => Endpoint | undefined
    getByRole: (role: string) => Endpoint[]
    list: () => Endpoint[]
}

export type Next<T> = () => Promise<T>

export type IoHandler = (req: OperationEnvelope, ctx: IoContext, next: Next<ResultEnvelope>) => Promise<ResultEnvelope>
export type PersistHandler = (req: PersistRequest, ctx: PersistContext, next: Next<PersistResult>) => Promise<PersistResult>
export type ReadHandler = (req: ReadRequest, ctx: ReadContext, next: Next<QueryResult>) => Promise<QueryResult>
export type MirrorHandler = (req: MirrorRequest, ctx: MirrorContext, next: Next<void>) => Promise<void>
export type ObserveHandler = (req: ObserveRequest, ctx: ObserveContext, next: Next<ObservabilityContext>) => Promise<ObservabilityContext>

export type HandlerName = 'io' | 'persist' | 'read' | 'mirror' | 'observe'
export type HandlerMap = {
    io: IoHandler
    persist: PersistHandler
    read: ReadHandler
    mirror?: MirrorHandler
    observe?: ObserveHandler
}

export type Register = <K extends HandlerName>(
    name: K,
    handler: HandlerMap[K],
    opts?: { priority?: number }
) => () => void

export type HandlerEntry<K extends HandlerName = HandlerName> = {
    name: K
    handler: HandlerMap[K]
    priority: number
}

export type PluginRegistry = {
    register: Register
    list: (name: HandlerName) => HandlerEntry[]
}

export type IoMiddleware = (next: IoHandler) => IoHandler
export type IoPipeline = { use: (mw: IoMiddleware) => () => void; execute: IoHandler }

export type IoContext = { clientId: string; endpointId?: string; storeName?: string }
export type PersistContext = { clientId: string; store: string }
export type ReadContext = { clientId: string; store: string }
export type MirrorContext = { clientId: string; store: string }
export type ObserveContext = { clientId: string }

export type PluginContext = {
    clientId: string
    endpoints: EndpointRegistry
    pipeline: IoPipeline
    runtime: RuntimeCore
}

export type ClientPlugin = {
    id: string
    priority?: number
    setup: (ctx: PluginContext, register: Register) => void
}

// ---- L3: Runtime Core ----
export type RuntimeCore = {
    registry: PluginRegistry
    pipeline: IoPipeline
    query: (args: { store: string; query: Query; context?: ObservabilityContext }) => Promise<QueryResult>
    write: (args: { store: string; action: WriteAction; items: WriteItem[]; context?: ObservabilityContext }) => Promise<WriteResultData>
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
    use: (plugin: ClientPlugin) => void
    dispose: () => void
}
```

---

## 5. 配置模型（ClientConfig）
```ts
export type BackendInput = { baseURL: string; key?: string }

export type ClientConfig = {
    schema?: AtomaSchema
    backend?: string | BackendInput
    plugins?: ClientPlugin[]
}
```
**要点**：  
- `schema` 置于第一层，作为最小初始化输入。  
- `backend` 是显式“默认插件预设”，不是 fallback。  
- 其余能力（endpoints/middleware/runtime）由插件管理。  
- 配置对象最多两层嵌套。

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
2. 若提供 `backend`，生成并追加官方默认插件（显式预设）。  
3. 构建 `EndpointRegistry`。  
4. 构建 `PluginRegistry` 与 `IoPipeline`。  
5. 依次执行插件 `setup`，调用 `register(name, handler, { priority })`。  
6. 按 `priority` 升序、安装顺序进行排序，生成各 scope 处理链。  
7. 校验必需 scope（`io/persist/read`）存在且终结处理器唯一，否则直接失败。  
8. 构建 `RuntimeCore`（注入 registry 与 pipeline）。  
9. 返回 `Client` 门面对象。

## 7. 全流程调用（详细）

### 7.1 写入流程（write）
1. `StoreFacade.write(...)` 生成写入意图。  
2. `RuntimeCore.write` 构建 `PersistRequest`。  
3. `PersistHandler` 链按优先级执行（可拦截或调用 `next`）。  
4. 终结 `PersistHandler` 构造 `OperationEnvelope` 并调用 `IoPipeline.execute`。  
5. `IoHandler` 链执行，终结处理器调用 `Driver.executeOps`。  
6. `RuntimeCore` 应用 `writeback` 更新内存态。  
7. 若存在 `MirrorHandler` 链，则按序执行。  
8. 发出 commit 事件、返回结果。

### 7.2 查询流程（query）
1. `StoreFacade.query(...)` 构建 `ReadRequest`。  
2. `ReadHandler` 链按优先级执行（可拦截或调用 `next`）。  
3. 终结 `ReadHandler` 调用 `IoPipeline.execute`。  
4. `IoHandler` 链执行并调用 `Driver.executeOps`。  
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
register('persist', handler, { priority: 10 })
```
- `priority` 越小越先执行；相同 `priority` 按插件安装顺序。  
- 未提供 `priority` 时，默认 `0` 或继承插件自身优先级。

### 7B.2 链式执行约定
- 每个处理器接收 `next`，调用 `next()` 进入后续处理器。  
- **不调用 `next()` 即终止链路**，由该处理器承担“最终执行”。  
- 必需 scope（`io/persist/read`）必须存在且**仅一个终结处理器**。  
- 可选 scope（`mirror/observe`）可为空或多段链式处理。
- 若链路执行到末尾仍调用 `next()`，应直接抛错。

### 7B.3 推荐分工
- `persist`：组织写入、组装 `OperationEnvelope`，决定何时调用 `io`。  
- `io`：统一执行 I/O（鉴权/重试/批处理/调用 driver）。  
- `read`：组织查询、结果校验/转换。

### 7B.4 中间件注入（可选）
```
ctx.pipeline.use(async (req, ctx2, next) => {
    // 统一鉴权/重试/打点
    return await next()
})
```
中间件由插件注入，核心不提供默认实现。

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
     await ctx.pipeline.execute(...)
```
关键点：
- `writeStrategy` 由插件内部定义与解释。  
- 角色端点缺失时**直接失败**，无 fallback。

### 7C.4 HTTP + SSE 的组合方式
- `HttpBackendPlugin` 只负责 ops。  
- `NotifySsePlugin` 只负责 notify（EventSource 逻辑在插件内部）。  
- 普通 HTTP 场景不需要安装 `NotifySsePlugin`。  
- 插件之间不相互探测，依赖由角色端点显式表达。

### 7C.5 IndexedDB 场景
- 只安装本地存储插件（注册 `role=ops` 的本地 driver）。  
- 不安装 sync/notify 插件；若误装，必须报错。


### 7.4 错误与取消
- 任何层抛出的错误统一包装为标准错误结构返回。  
- `AbortSignal` 贯穿 `OperationEnvelope`，中间件必须遵守。
- 必需 scope 为空或链末仍调用 `next()` 时，直接抛错。

---

## 8. 数据流（示意）

### 写入（write）
```
Client API
  -> Runtime Core
    -> PersistHandler 链
      -> IoPipeline
        -> IoHandler 链
          -> Driver.executeOps(...)
    -> Writeback (apply local state)
    -> MirrorHandler 链（可选）
```

### 查询（query）
```
Client API
  -> Runtime Core
    -> ReadHandler 链
      -> IoPipeline -> IoHandler 链 -> Driver
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
- 中间件对 `OperationEnvelope` 工作，避免重复适配。

---

## 12. 可测试性与演进
- 通过 mock 插件与驱动可进行单元测试。  
- 通过调整插件组合与 `priority` 模拟离线/在线/多端点场景。  
- 逐步替换：先引入插件层，再替换旧通道逻辑。

---

## 13. 重构路线（不兼容版本）
1. 定义插件拦截点与标准 Handler 接口。  
2. 迁移 `IoPipeline` 到插件体系，改为 `IoHandler`。  
3. 重写 `Runtime` 为按处理器链调度。  
4. 提供默认插件集合（HTTP/IndexedDB/Memory）。  
5. 清理旧 `store/remote` 硬编码路径。

---

## 14. 风险与需要决策
- 是否强制每个必需 scope **恰好一个**终结处理器？  
- 插件之间是否允许互相调用？
- 错误与重试是否必须由 `IoHandler` 统一处理？
- 插件 `priority` 是否允许运行期切换？

---

## 15. 小结
该方案将“策略与执行”完全交给插件，以“事件名 + 处理器链”显式接管核心流程，取消能力推断与硬编码通道。默认插件集合提供常见实现，但**不作为 fallback**，避免语义歧义。核心运行时保持中性、可替换，适合重构与长期演进。
