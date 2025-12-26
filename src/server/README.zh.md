# Atoma Server 架构说明（vNext-only，zh）

本文描述 `src/server/` 目录下当前的 server 架构与调用链路。

**重要约束（已收敛）：**
- Server **不再提供** legacy REST / `/batch`（也不再存在 `batchRest` 执行链路）。
- 默认只提供 vNext 语义：
  - `POST /ops`（统一 Query/Write/ChangesPull）
  - `GET /sync/subscribe-vnext`（SSE：changes stream）

> 入口：`createAtomaServer(config)`（`src/server/createAtomaServer.ts`）

## 安全模型（重要）

Atoma Server **不实现**行级数据隔离（Row-Level Security / 多租户隔离）的通用方案：
- 不提供 `where` 注入/改写（forced where）
- 不提供 query 字段级白名单/黑名单策略（field policy）

如果你要把它当作“正式可用的通用服务端”，必须在业务侧使用数据库能力保证行级隔离（推荐 **DB RLS**，或等价的视图/存储过程/权限模型），并在应用层的 `authz.resources` / `authz.hooks.authorize` 做资源级访问控制。

---

## 1. 总览：三层结构

Atoma Server 以“三层”组织代码与依赖方向：

1) **Engine（编排层）**
    - 负责：路由调度、中间件链、runtime 生命周期、错误边界与观测 hooks

2) **Services（服务层 / 业务执行入口）**
    - 负责：把“路由请求”转成“具体业务动作”（ops + subscribe-vnext），并协调 policies、adapter、writeSemantics

3) **Policies（策略层）**
    - 负责：鉴权/过滤/写校验（`AuthzPolicy`）、body 读取限制等

依赖方向（推荐理解方式）：

`routes -> services -> policies -> adapters/writeSemantics`

---

## 2. 关键组件

### 2.1 createAtomaServer：唯一 server 入口（组装器）

文件：`src/server/createAtomaServer.ts`

职责：
- 读取 `AtomaServerConfig`，确定 routing（basePath、opsPath、subscribeVNextPath、syncEnabled、trace header）
- 创建 `runtime` 工厂与顶层错误格式化器
- 创建 `services`
- 组装内置路由（`/ops` + `/sync/subscribe-vnext`），交给 router 调度

### 2.2 Router：纯路由调度 + middleware 链

文件：`src/server/engine/router.ts`

职责：
- 标准化请求上下文 `RouteContext`（解析 URL、pathname、method、trace/request header）
- 按 routes 注册顺序进行 match，命中后执行 `handle(ctx)`
- 提供 middleware 链：`middleware(ctx, next)`
- 提供 `onError` 兜底：捕获异常并转为 vNext envelope 错误

### 2.3 Routes：内置 vNext 路由

内置路由：
- `POST /ops`
- `GET /sync/subscribe-vnext`

### 2.4 Services：业务路由的执行实现

目录：`src/server/services/`

- `src/server/services/ops/createOpsService.ts`
  - 解析 `OpsRequest`、校验、authz、执行 query/write/changes.pull，并返回 vNext envelope
- `src/server/services/sync/createSyncService.ts`
  - 仅提供 `subscribeVNext`：SSE 输出 vNext `ChangeBatch`（`{ nextCursor, changes }`）

---

## 3. 调用关系：从请求到响应

1) `createAtomaServer(config)` 组装：
    - `services = createServerServices(...)`
    - `routes = [ops, sync/subscribe-vnext]`
    - `router = createRouter({ routes, onError })`

2) 每次请求进入 `router(incoming)`：
    - middleware 链
    - route match 命中后执行 `route.handle(ctx)`
    - `handleWithRuntime(...)` 统一包 runtime + hooks + 错误边界

3) services 执行：
    - body 读取（`limits.readBodyJson`）
    - 鉴权与过滤（`authz.*`）
    - 写语义（`writeSemantics`）与 ORM adapter
    - 产出 `HandleResult`

---

## 4. 典型链路示例

### 4.1 /ops

入口：内置 route（在 `src/server/createAtomaServer.ts` 内组装）

调用链（概念）：
- `route.handle(ctx)`
  - `handleWithRuntime(...)`
    - `services.ops.handle(...)`
      - validate + authz
      - query/write/changes.pull 执行
      - 返回 vNext envelope

### 4.2 /sync/subscribe-vnext（SSE）

入口：内置 route（在 `src/server/createAtomaServer.ts` 内组装）

调用链（概念）：
- `route.handle(ctx)`
  - `handleWithRuntime(...)`
    - `services.sync.subscribeVNext(...)`
      - 校验 cursor
      - `adapter.sync.waitForChanges(...)`
      - `authz.filterChanges(...)`
      - 输出 `event: changes` + `ChangeBatch`
