# Atoma Server 架构说明（zh）

本文描述 `src/server/` 目录下当前的 server 架构：各模块如何组合、调用链路如何流动、以及这些设计的核心意图（低耦合、可扩展、易维护）。

> 入口：`createAtomaServer(config)`（`src/server/createAtomaServer.ts`）

---

## 1. 总览：三层结构

Atoma Server 以“三层”组织代码与依赖方向：

1) **Engine（编排层）**
    - 负责：路由调度、中间件链、runtime 生命周期、错误边界与观测 hooks
    - 目标：把“框架/运行时相关”的通用能力集中到一个地方，避免散落在各个路由实现里

2) **Services（服务层 / 业务执行入口）**
    - 负责：把“路由请求”转成“具体业务动作”（batch/rest/sync），并协调 policies、adapter、executor、writeSemantics
    - 目标：把路由变薄，让“业务逻辑”可测试、可替换、可组合

3) **Policies（策略层）**
    - 负责：鉴权/过滤/写校验（`AuthzPolicy`）、限流与 payload 限制（`LimitPolicy`）等
    - 目标：把规则从业务流程中抽离出来，变成可注入、可复用、可替换的策略对象

依赖方向约束（推荐理解方式）：

`routes -> services -> policies -> adapters/executor/writeSemantics`

而 `engine` 只负责把这些东西组装起来并调度运行。

---

## 2. 关键组件与职责

### 2.1 createAtomaServer：唯一 server 入口（组装器）

文件：`src/server/createAtomaServer.ts`

职责：
- 读取 `AtomaServerConfig`，确定 routing（basePath、各 path、开关、trace header）
- 创建 `runtime` 工厂与顶层错误格式化器
- 创建 `services`（包含 policies + 业务服务实现）
- 组装 `plugins`（用户插件 + 内置 `default-routes`）
- 收集插件产出的 `routes` 与 `middleware`，交给 router 统一调度

设计意图：
- **核心不再回到“巨石函数”**：入口只做组装，不承担业务流程细节
- **扩展优先走插件**，而不是不断向 config 里塞分叉逻辑

### 2.2 Router：纯路由调度 + middleware 链

文件：`src/server/engine/router.ts`

职责：
- 标准化请求上下文 `RouteContext`（解析 URL、pathname、method、trace/request header）
- 按 routes 注册顺序进行 match，命中后执行 `handle(ctx)`
- 提供 `RouterMiddleware` 链：`middleware(ctx, next)`，在 route match/handle 的“外层”包裹一次请求
- 提供 `onError` 兜底：捕获 route handler 抛出的异常并转为 `HandleResult`

设计意图：
- `Router` 不理解业务语义（batch/rest/sync），只负责“把请求交给谁处理”
- middleware 链让横切能力（metrics、CORS、额外认证网关等）**不必侵入业务逻辑**

### 2.3 Plugins：路由与中间件的模块化扩展

文件：`src/server/engine/plugins.ts`、`src/server/plugins/defaultRoutesPlugin.ts`

插件接口（概念）：
- `ServerPlugin.setup({ config, services, routing }) => { routes?, middleware? }`

内置插件：
- `default-routes`：提供 `/sync/pull`、`/sync/subscribe`、`/sync/push`、以及 batch/rest catch-all（通过 `parseHttp` 判断是 REST 还是 `/batch`）

设计意图：
- 用“可组合模块”替代“before/after 路由注入”，扩展能力更清晰
- 插件按顺序 setup，用户插件放前面可实现覆盖/拦截

### 2.4 Runtime：生命周期与观测统一入口

文件：`src/server/engine/runtime.ts`、`src/server/engine/handleWithRuntime.ts`

职责（概念上）：
- 为每次请求创建 runtime：`traceId/requestId/logger/ctx/debug emitter/hooks`
- 统一触发 observability hooks：`onRequest/onValidated/onAuthorized/onResponse/onError`
- 统一错误捕获与顶层错误格式化（与 router 的 `onError` 配合）
- 提供阶段上报（Phase）：validated/authorized 的触发点集中在 engine

设计意图：
- “同一套生命周期语义”覆盖所有路由（batch/rest/sync）
- route/service 不需要重复写一堆 hooks/emitter 模板代码

### 2.5 Services：业务路由的执行实现

目录：`src/server/services/`

核心容器：
- `src/server/services/types.ts`：`AtomaServerServices`（包含 `authz/limits/batchRest/sync/runtime/config`）
- `src/server/services/createServerServices.ts`：创建默认 services（默认策略 + 默认实现）

具体服务：
- `src/server/services/batchRest/createBatchRestService.ts`
    - 做 parse/validate/fieldPolicy/authz/execute/toRestResponse
- `src/server/services/sync/createSyncService.ts`
    - pull/subscribe：读取 changes 并走 authz.filterChanges
    - push：limits 校验 + authz 校验/validateWrite + 事务内 writeSemantics 执行

设计意图：
- 路由（`routes/*/create*Route.ts`）只剩“match + delegate”，逻辑集中到 services
- 未来替换执行链（例如不同 executor、不同 sync 策略、不同 transport）只需要替换 services

### 2.6 Policies：规则与约束的可替换策略对象

目录：`src/server/policies/`

当前策略：
- `AuthzPolicy`：资源 allow/deny、authorize、filterQuery、validateWrite、filterChanges
- `LimitPolicy`：body 读取限制、batch/rest 校验、sync push 校验等

设计意图：
- 把“规则”从“流程”中抽离：减少 if/throw 分散在业务链路中
- 支持按部署形态/环境替换策略实现（同一套业务服务可复用）

---

## 3. 调用关系：从请求到响应

下面用一条“抽象调用链”描述模块互相调用的关系（省略细枝末节）：

1) `createAtomaServer(config)` 组装：
    - `services = createServerServices(...)`
    - `plugins = [...config.plugins, defaultRoutes]`
    - `routes/middleware = plugins.flatMap(...)`
    - `router = createRouter({ routes, middleware, onError })`

2) 每次请求 `incoming` 进入：
    - `router(incoming)`：
        - 解析 `url/method/pathname/traceIdHeaderValue/requestIdHeaderValue`
        - 执行 middleware 链（若存在）
        - 依次 match routes，命中后执行 `route.handle(ctx)`

3) route handler（很薄）通常做两件事：
    - 对 sync 路由：调用 `handleWithRuntime(...)` 统一包 runtime + hooks + error
    - 对 batch/rest：直接 delegate 到 `services.batchRest.handleHttp(...)`（其内部再进入 `handleWithRuntime`）

4) services 执行：
    - 解析/校验（validator/limitPolicy）
    - 授权与过滤（authzPolicy）
    - 执行器与写语义（executor / writeSemantics）
    - 形成 `HandleResult`（status/headers/body）

---

## 4. 典型链路示例

### 4.1 batch/rest（REST 与 /batch 共享）

入口 route：`src/server/routes/batch/createBatchRestRoute.ts`

调用链（概念）：
- `route.handle(ctx)`
    - `services.batchRest.handleHttp({ incoming, urlRaw, urlForParse, pathname, method })`
        - `parseHttp(...)` 判别 REST vs batch
        - `handleWithRuntime(...)` 创建 runtime、包 hooks 与错误
        - `validateAndNormalizeRequest(...)`
        - `limits.validateBatchRequest(...)`
        - field policy guard（query）
        - `authz.filterQuery/authorize/validateWrite(...)`
        - `executeRequest(...)`
        - REST 路由时 `toRestResponse(...)`

设计意图：
- REST 与 `/batch` 共享同一条执行链，减少分叉行为
- query 的 fieldPolicy guard 与 authz 分离：一个管字段形态，一个管资源与权限

### 4.2 sync pull / subscribe

入口 routes：
- `src/server/routes/sync/createSyncPullRoute.ts`
- `src/server/routes/sync/createSyncSubscribeRoute.ts`

调用链（概念）：
- `route.handle(ctx)`
    - `handleWithRuntime(...)`
        - `services.sync.pull(...)` / `services.sync.subscribe(...)`
            - parse query（cursor/limit）
            - `phase.validated(...)`
            - `adapter.sync.pullChanges(...)` / `adapter.sync.waitForChanges(...)`
            - `authz.filterChanges(...)`（避免下发不可见资源的 change 摘要）
            - 返回 JSON（pull）或 SSE stream（subscribe）

设计意图：
- cursor 推进以 raw changes 为准，避免过滤导致 cursor 卡住
- subscribe 的 allowCache 在同一连接中复用资源级授权结果，减少开销

### 4.3 sync push

入口 route：`src/server/routes/sync/createSyncPushRoute.ts`

调用链（概念）：
- `route.handle(ctx)`
    - `services.sync.preparePush(...)`：读 body + 校验，并确定初始 trace/request id
    - `handleWithRuntime(...)`
        - `services.sync.push(...)`
            - `phase.validated(...)`
            - `limits.validateSyncPushRequest(...)`
            - per-op：`authz.ensureResourceAllowed` / `authz.authorize(action='sync')`
            - per-op：`authz.validateWrite(...)`（必要时 getCurrent 读取当前值）
            - 事务内：`executeWriteItemWithSemantics(...)`（幂等/冲突/outbox changes）
            - 聚合 acked/rejected 返回

设计意图：
- `/sync/push` 是“强绑定一致性路径”：把幂等/冲突/outbox changes 视为整体语义
- write 校验与语义执行分离：policy 负责“是否允许”，semantics 负责“怎么写且一致”

---

## 5. 设计意图总结（为什么这么拆）

- **低耦合**：路由不直接依赖执行器/写语义/adapter 细节，统一走 services；规则统一走 policies
- **可扩展**：新增路由/中间件优先用插件；替换能力优先替换 services/policies
- **可维护**：生命周期与错误/观测在 engine 统一处理；业务流程集中在 service 文件中，便于定位与测试

