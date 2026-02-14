# Atoma 统一运行时架构 V5（Single-Path + ServiceRegistry）

> 状态：提案（建议作为下一阶段落地基线）  
> 目标：在极简主链前提下，保留极致扩展性与插件解耦能力  
> 范围：`atoma-client` / `atoma-runtime` / `atoma-types` / `plugins/*`

---

## 0. 结论先行

V5 固定为三层：

1. **单一路径主链**：所有 query/write 只走 `Runtime -> Execution -> Executor`。  
2. **共享服务层（ServiceRegistry）**：插件共享能力统一通过强类型服务，不参与主链路由。  
3. **事件旁路层（Event Bus）**：sync/debug/history/telemetry 仅通过事件协作，不反向控制路由。

核心判断：

1. 不删能力共享机制。  
2. 只删无边界能力查找和多控制面混用。  
3. 内外都不保留 `register*/bind*/setDefault*` 命令式装配 API。

---

## 1. 当前问题（基于现状代码）

1. Execution 对外 API 过宽，调用方要理解注册、绑定、默认策略、图解析等细节。  
2. 路由仍有 `strategy -> graph -> node` 双层映射，语义不直观。  
3. sync 语义泄漏到 execution（如 graph 中的 `outbox`）。  
4. 插件上下文混入 execution 装配、operation middleware、capabilities 三条控制线。  
5. capabilities 机制有价值，但字符串 key + 动态查找导致边界松散。

---

## 2. V5 目标

1. 请求路径只有一个决策平面（Execution）。  
2. 写入路由统一字段为 `route`（替代 `writeStrategy`）。  
3. ServiceRegistry 负责跨插件共享，不参与主链决策。  
4. sync/debug/observability 只走旁路。  
5. transport 细节下沉到 remote executor 内部。  
6. 新增插件保持线性扩展，不改 runtime 主干。

## 2.1 命名统一（旧 -> 新）

1. `PortHub` -> `ServiceRegistry`  
2. `PortToken` -> `ServiceToken`  
3. `definePortToken` -> `createServiceToken`  
4. `provide/consume` -> `register/resolve`  
5. `profileId` -> `route`  
6. `ExecutionProfileId` -> `RouteId`  
7. `ExecutionProfile` -> `RouteSpec`  
8. `defaultProfileId` -> `defaultRoute`  
9. `ExecutionNodeId` -> `ExecutorId`  
10. `ExecutionTopology` -> `ExecutionSnapshot`  
11. `ExecutionComposer.extend` -> `ExecutionBuilder.apply`  
12. `PluginPorts` -> `PluginServices`  
13. `consumes` -> `requires`

---

## 3. 架构总览

## 3.1 三平面模型

1. **Execution Plane（主链）**：按 route 选择 executor 并执行 query/write。  
2. **Service Plane（共享）**：通过 ServiceRegistry 共享 debug、sync transport 等服务。  
3. **Event Plane（旁路）**：监听 execution/runtime 事件驱动后台能力。

硬约束：

1. Service Plane 不参与主链路由。  
2. Event Plane 不修改主链决策。  
3. 主链只受 `route + executor` 影响。

---

## 4. 主链：Single-Path 执行模型

## 4.1 执行路径

### Query

1. `store.query/get*` 进入 `ReadFlow`。  
2. `ReadFlow` 调用 `execution.query(...)`。  
3. Execution 根据 route 选择 query executor。  
4. executor 返回 `QueryOutput`。  
5. runtime 完成 writeback/merge 并返回。

### Write

1. `store.add/update/delete/upsert` 进入 `WriteFlow/WriteCommitFlow`。  
2. `WriteCommitFlow` 调用 `execution.write(...)`。  
3. Execution 根据 route 选择 write executor。  
4. executor 返回 `WriteOutput`。  
5. runtime 处理 optimistic/writeback/rollback 并返回。

## 4.2 Route 模型

```ts
export type RouteId = string
export type ExecutorId = string

export type RouteSpec = Readonly<{
    query: ExecutorId
    write: ExecutorId
    policy?: Policy
}>
```

约束：

1. `write.route === RouteId`。  
2. route 全局唯一，冲突启动即失败。  
3. route 不承载 sync/debug 字段。

## 4.3 Executor 组合（替代内核级 fallback）

`fallback/retry/timeout` 不进入 execution 公共模型，改为 executor 组合器：

1. `withRetry(executor, config)`  
2. `withFallback(primaryExecutor, fallbackExecutor)`  
3. `withTimeout(executor, ms)`

## 4.4 写入路由输入（最小形态）

```ts
export type WriteRoute = Readonly<{
    route?: RouteId
}>
```

规则：

1. 传 `route`：精确命中。  
2. 不传 `route`：使用 `defaultRoute`。  
3. route 不存在：fail-fast。

---

## 5. ServiceRegistry：受限共享服务层

## 5.1 设计原则

1. 保留共享能力。  
2. 禁止裸字符串查找。  
3. 使用强类型 `ServiceToken`。  
4. 插件显式声明 `provides/requires`，启动期校验。  
5. 服务只表达契约，不泄漏领域实现细节。

## 5.2 契约（示意）

```ts
declare const SERVICE_TOKEN_TYPE: unique symbol

export type ServiceToken<T> = symbol & {
    readonly [SERVICE_TOKEN_TYPE]?: T
}

export function createServiceToken<T>(name: string): ServiceToken<T> {
    return Symbol.for(`atoma.service.${name}`) as ServiceToken<T>
}

export type ServiceRegistry = Readonly<{
    register: <T>(token: ServiceToken<T>, value: T) => () => void
    resolve: <T>(token: ServiceToken<T>) => T | undefined
}>
```

实现约束：

1. 内部存储使用 `Map<symbol, unknown>`。  
2. 插件间必须共享同一个 token 常量或同名 `Symbol.for`。  
3. 仅按 token 身份匹配。

## 5.3 常用服务

1. `DEBUG_HUB_TOKEN`（或 `OBSERVABILITY_TOKEN`）  
2. `SYNC_TRANSPORT_TOKEN`  
3. `SYNC_SUBSCRIBE_TRANSPORT_TOKEN`

---

## 6. 插件模型收敛

## 6.1 单入口插件模型

```ts
export type PluginContext = Readonly<{
    execution: ExecutionBuilder
    services: PluginServices
    events: PluginEvents
    runtime: PluginRuntime
}>

export type ClientPlugin = Readonly<{
    id: string
    provides?: ReadonlyArray<ServiceToken<unknown>>
    requires?: ReadonlyArray<ServiceToken<unknown>>
    setup?: (ctx: PluginContext) => void | PluginInitResult
}>
```

覆盖能力：

1. execution 扩展。  
2. service 注册/解析。  
3. 事件订阅和扩展挂载。

移除内容：

1. 顶层 `operations/transport` 公共控制面。  
2. execution 命令式装配 API（register/bind/setDefault*）。  
3. execution/policy/operations/events 多入口插件生命周期。

## 6.2 依赖声明

```ts
export type PluginMeta = Readonly<{
    id: string
    provides?: ReadonlyArray<ServiceToken<unknown>>
    requires?: ReadonlyArray<ServiceToken<unknown>>
}>
```

装配规则：

1. 缺失依赖直接 fail-fast。  
2. 服务冲突默认报错，仅允许显式 override。

---

## 7. Transport 与观测定位

## 7.1 远端协议细节下沉

`OperationPipeline` 不再是全局插件控制面，只作为 `RemoteExecutor` 内部细节。

收益：

1. 主链只看 executor，不看 middleware。  
2. backend-http/memory/indexeddb 不再争抢全局 pipeline 语义。  
3. 新传输实现只改 remote executor。

## 7.2 观测注入点

trace/meta 注入迁移到：

1. remote executor 内部拦截器。  
2. execution 事件旁路（推荐）。

## 7.3 失败语义收敛

建议移除 `ReadFlow.query` 的隐式本地兜底：

1. 默认失败即失败。  
2. 需要降级时显式使用 `withFallback`。  
3. fallback 仅在 executor 层出现，不在 read flow 重复出现。

---

## 8. Sync 在 V5 的边界

1. sync 是旁路编排，不是执行路由器。  
2. outbox 入队只依据 sync 自身配置（如 `enqueueRoutes`），不读取 execution 内部元信息。  
3. push/pull/subscribe 通过 ServiceRegistry 注入 transport。  
4. 回写通过 `runtime.stores.applyWriteback`。  
5. sync 不注册或覆盖默认 route。

推荐配置：

```ts
syncPlugin({
    enqueueRoutes: ['local'],
    transport: ...,              // 或通过 ServiceRegistry.resolve 获取
    subscribeTransport: ...
})
```

---

## 9. Debug/Devtools 的耦合结论

问题：`ctx.devtools.debugHub` 这种显式字段是否耦合？  
结论：不建议在 `PluginContext` 增加领域字段。

V5 做法：

1. debug 能力通过 ServiceRegistry 提供。  
2. 基础设施插件 `register(DEBUG_HUB_TOKEN, hub)`。  
3. 业务插件按需 `resolve(DEBUG_HUB_TOKEN)`。  
4. 替换 devtools 实现时不影响插件接口。

---

## 10. 对外最小 API（目标态）

## 10.1 Runtime 侧

```ts
export type ExecutionRuntime = Readonly<{
    query: <T extends Entity>(input: QueryInput<T>) => Promise<QueryOutput>
    write: <T extends Entity>(input: WriteInput<T>) => Promise<WriteOutput<T>>
    resolvePolicy: (route?: RouteId) => Policy
    subscribe: (listener: (event: ExecutionEvent) => void) => () => void
}>
```

## 10.2 插件侧

```ts
export type ExecutionBuilder = Readonly<{
    apply: (bundle: ExecutionBundle) => () => void
}>

export type PluginServices = Readonly<{
    register: ServiceRegistry['register']
    resolve: ServiceRegistry['resolve']
}>
```

说明：命令式 API（register/bind/setDefault*）在内外均删除。

## 10.3 内核实现方案（明确）

### 快照模型

```ts
export type ExecutionSnapshot = Readonly<{
    executors: ReadonlyMap<ExecutorId, ExecutionSpec>
    routes: ReadonlyMap<RouteId, RouteSpec>
    defaultRoute: RouteId
}>
```

内核只维护一个当前快照引用：

1. 执行阶段只读。  
2. 不保留策略映射表。  
3. 不保留可变命令式注册状态。

### 扩展与回滚

```ts
export type ExecutionBundle = Readonly<{
    id: string
    executors?: Readonly<Record<ExecutorId, ExecutionSpec>>
    routes?: Readonly<Record<RouteId, RouteSpec>>
    defaultRoute?: RouteId
    allowOverride?: boolean
}>
```

`apply(bundle)` 步骤：

1. 校验 bundle（id、route 引用完整性）。  
2. 添加一层 bundle。  
3. 重建 `ExecutionSnapshot` 不可变快照。  
4. 原子替换当前快照。  
5. 返回 disposer，移除该层后再次重建快照。

### 合并规则

1. 默认禁止同名 executor/route 冲突。  
2. 仅 `allowOverride: true` 允许覆盖。  
3. `defaultRoute` 必须存在于最终快照。  
4. 任一规则失败，整次 apply 失败且不污染当前快照。

### 执行流程

`query/write` 统一流程：

1. 解析目标 route（显式入参或默认值）。  
2. 从快照获取 route 和 executor。  
3. 执行 executor。  
4. 发出 execution event。  
5. 返回标准输出。

---

## 11. 分阶段实施方案

## Phase 1：Execution 接口收敛

1. 引入 `execution.apply(bundle)` 作为唯一扩展入口。  
2. 删除 `register*/bind*/setDefault*` 的内外类型与实现。  
3. 写入路由统一为 `route`。  
4. 引入 `ExecutionSnapshot` 快照模型。

验收：

1. 新增 route 只需一次 `apply`。  
2. route 不存在立即报错。

## Phase 2：Execution 去 sync 语义

1. 从 execution 模型移除 `outbox` 等 sync 字段。  
2. sync 入队改为 `enqueueRoutes` 或 `shouldEnqueue(event)`。

验收：

1. execution 类型不出现 sync 字段。  
2. sync 行为与 execution 解耦。

## Phase 3：ServiceRegistry 替换 capabilities

1. 引入 `ServiceToken/ServiceRegistry`。  
2. 迁移 `debug.hub`、`sync.driver`、`sync.subscribe`。  
3. 移除字符串 key 直取能力。

验收：

1. 编译期可推导服务类型。  
2. 启动期可校验依赖缺失。

## Phase 4：Transport 控制面下沉

1. 将 `operations/transport` 顶层扩展面下沉到 remote executor 内部。  
2. backend-http/memory/indexeddb 改为提供 executor。  
3. 插件契约统一为单入口 `setup(ctx)`。

验收：

1. 插件上下文不再暴露 operation middleware 注册接口。  
2. 插件不存在多入口生命周期。  
3. 主链完全由 route 决定。

## Phase 5：旁路插件重构

1. sync 改走 `services + events`。  
2. devtools/history 改走 `DEBUG_HUB_TOKEN`。  
3. observability trace 注入迁移到 remote executor 或 execution event 层。

验收：

1. 旁路插件不修改执行路由。  
2. 可单独启停，不影响主链。

## Phase 6：兼容层删除

1. 删除 legacy contracts 与旧入口。  
2. 更新文档与 demo。  
3. 执行全量 typecheck/build/test。

---

## 12. 最终验收清单

1. 请求主链只有 `Runtime -> Execution -> Executor`。  
2. 写入路由统一字段为 `route`。  
3. execution 内外都无 `register*/bind*/setDefault*`。  
4. 插件共享能力全部通过 typed `ServiceRegistry`。  
5. sync/debug/history/observability 仅走 `events + services`。  
6. 新增后端插件无需修改 runtime 主流程。

---

## 13. 一句话版本

V5 的最小复杂度形态是：

**Single-Path 主链 + ServiceRegistry 共享服务 + Event Bus 旁路协作**，  
在最低认知成本下保持最高扩展性。

