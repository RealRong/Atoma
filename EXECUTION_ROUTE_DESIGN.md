# Execution Route 设计说明（简化版）

## 1. 目标

在保证开源可理解性的前提下，给出一套尽量简单的 execution route 设计，核心原则：

- 不引入过多新类型；保留 `ExecutionRoute` 即可。
- 对外术语统一使用 `route` / `defaultRoute`，不引入 `routeId` 命名。
- 用户配置保持直观，避免“只为抽象而抽象”。
- 内部实现继续可序列化、可调试、可追踪。

---

## 2. 现状链路（完整）

当前 route 配置贯穿如下链路：

1. `CreateClientOptions.execution.defaultRoute`（`packages/atoma-types/src/client/options.ts`）
2. `createClient` 读取并校验，再通过 `runtime.execution.apply({ defaultRoute })` 覆盖（`packages/atoma-client/src/index.ts`）
3. 插件在 `setup` 期通过 `ctx.runtime.execution.apply(...)` 注册 executors/routes，且很多插件也会设置 `defaultRoute`（`packages/plugins/atoma-backend-*/src/plugin.ts`）
4. `StoreFactory` 把 schema 的 `write.route` 存入 `handle.config.defaultRoute`（`packages/atoma-runtime/src/store/StoreFactory.ts`）
5. 读写流程优先级统一是：`options.route ?? handle.config.defaultRoute`（`ReadFlow` / `WriteFlow` / `prepareWriteInput`）
6. `ExecutionKernel` 负责 route 解析、冲突校验、默认 route 生效（`packages/atoma-runtime/src/execution/kernel/ExecutionKernel.ts`）

---

## 3. 核心判断：传 string 还是 `xxxPlugin.xxxRoute` 风格？

结论：**对外仍使用 `ExecutionRoute`（string），但推荐“插件导出 route 常量”作为主用法。**

- 保持 string 的优点：日志、序列化、事件、调试都天然友好。
- 避免裸字符串硬编码：插件提供常量，用户直接引用，减少拼写错误。
- 不建议 `xxxPlugin.xxxRoute` facade 对象风格（会引入额外 API 层）；建议 named export 常量。

推荐示例（仅风格）：

```ts
// plugin package
export const HTTP_ROUTE: ExecutionRoute = 'direct-http'

// app
createClient({
    plugins: [httpBackendPlugin(...)],
    defaultRoute: HTTP_ROUTE
})
```

---

## 4. 是否需要 `execution.setDefaultRoute(...)` 单独 API？

结论：**默认不需要新增该 API。**

原因：

1. 现有 `execution.apply({ defaultRoute })` 已可表达同一能力。
2. 新增 API 会扩大公开面，增加“与 apply 的优先级和生命周期关系”解释成本。
3. 当前是层叠模型（bundle 可注册/卸载），`setDefaultRoute` 仍需处理可回滚语义，本质不会更简单。
4. 对开源用户而言，学习一个入口（`apply`）比两个入口（`apply` + `setDefaultRoute`）更清晰。

更优做法：

- 保留单入口 `apply`。
- 在约定层面收敛默认路由控制权：**默认 route 由 `createClient` 决定，插件默认只注册 route，不主动设置 defaultRoute**。

---

## 5. 最优简化方案（建议）

### 5.1 配置面

将 client 配置从：

- `execution?: { defaultRoute?: ExecutionRoute }`

简化为：

- `defaultRoute?: ExecutionRoute`

说明：

- 少一层对象，用户更容易发现和理解。
- 依然不需要新类型。
- `route` 与 `defaultRoute` 命名保持全链路一致。

### 5.2 命名面

- 保留类型名：`ExecutionRoute`
- 全部参数统一：
  - 单次调用：`route?: ExecutionRoute`
  - 默认值：`defaultRoute?: ExecutionRoute`
- 插件常量建议：
  - `LOCAL_ROUTE`
  - `HTTP_ROUTE`
  - `MEMORY_ROUTE`
  - `INDEXEDDB_ROUTE`

### 5.3 责任面

- `createClient`：唯一默认路由入口（用户配置 -> runtime apply）。
- 插件：注册 executors/routes，不抢默认。
- runtime kernel：继续只做解析与校验，不新增并行入口语义。

---

## 6. 开源友好性结论

在不引入额外复杂度的前提下，最开源友好的路线是：

- **保留 `ExecutionRoute` string 模型**
- **推荐插件导出 route 常量引用**
- **默认路由策略收敛到 `createClient`**
- **不新增 `execution.setDefaultRoute(...)` API**

这套方案能同时满足：简单、可理解、可维护、可序列化、低认知负担。
