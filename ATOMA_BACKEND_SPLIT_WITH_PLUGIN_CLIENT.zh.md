# Backend 拆分与 Plugin/Client 结合设计（一次到位，无兼容层）

本文基于：
- `ATOMA_PACKAGE_SPLIT_PLAN.zh.md`
- `ATOMA_BACKEND_EXTRACTION_PLAN.zh.md`

目标：把“backend（实现层）”从核心中抽离成独立包，并明确它与当前 `createClient + plugin` 架构的结合方式与边界，避免循环依赖与职责漂移。

---

## 1. 结论（先讲清楚）

1) backend 必须拆：它是“运行时实现层”（HTTP/IDB/Memory/SQLite/批处理/重试），不应污染 core。
2) `atoma-client` 负责“装配与扩展”：接收 **backend 对象**（由 backend 自己关注配置与依赖）→ 建立 `store/remote` 通道 → 提供 plugin 上下文与 I/O middleware 管线。
3) plugin 永远不直接触达 backend/ops/meta：只能用 `ctx.store/ctx.remote/ctx.writeback.commit`，以及 `ctx.io.use` 安装 middleware。
4) 依赖方向必须单向：`atoma-core` 绝不依赖 `atoma-backend`；`atoma-sync` 依赖 `atoma-client`（插件 API），但 `atoma-client` 不依赖 `atoma-sync`（避免环）。

---

## 2. 当前（已存在）的 Client/Plugin 架构摘要

> 这部分是后续拆包时“不能破坏”的契约。

### 2.1 I/O 管线（单一拦截点）
- client 内部维护一条 I/O pipeline（middleware 链）。
- pipeline 的职责：统一注入 trace/meta、统一校验协议结果、统一错误归一化、统一做 auth/限流/审计等横切。
- plugin 只能通过 `ctx.io.use(mw)` 安装 middleware，不能直接执行 ops。

### 2.2 插件可用的高阶 Channel API
插件只使用：
- `ctx.store.query/write`（通道=store）
- `ctx.remote.query/write` + `ctx.remote.changes.pull` + `ctx.remote.subscribeNotify?`
- `ctx.writeback.commit(storeName, writeback)`：一次调用完成“内存 apply +（Store=local durable 时）落盘 mirror”

### 2.3 “backend”在当前架构中的真实位置
backend 不应该暴露给 plugin：
- backend 只提供 `opsClient.executeOps(...)` 这一类“怎么发 op”的能力
- client 负责把 backend 接到 pipeline 上，并向 plugin 暴露高阶 API

---

## 3. Backend 拆分的包边界（什么进 atoma-backend，什么留在 atoma-client）

### 3.1 `atoma-backend`（实现层，纯 runtime）
只放“如何发 op/如何订阅通知/如何批处理”的实现，典型包括：
- `HttpOpsClient`（fetch/headers/retry/interceptors/responseParser）
- `IndexedDBOpsClient`、`MemoryOpsClient`（本地 durable/内存实现）
- `BatchEngine`（批处理 lane、合并 query/write、背压）

`atoma-backend` 不做：
- 不解析“用户配置对象”成 `ResolvedBackend`（解析/校验属于 client 装配层）
- 不知道 plugin，不提供 plugin API
- 不包含任何 server 生态依赖（typeorm/prisma/hono/express 等一律在 server 包）

### 3.2 `atoma-client`（装配层 + 扩展层）
只要满足一句话：**把实现层装起来，给上层一个稳定、可扩展、可拦截的 Client API**。

它负责：
- 接收 `backend: Backend`（已装配完成，包含 `store/remote` 端点与能力声明）
- 建立 `store/remote` 两条通道，并统一走一条 I/O pipeline（middleware 链）
- 产出 `ClientPluginContext`（插件 API）与 `client.use(plugin)`
- 负责 `writeback.commit` 的 durable 语义（Store=local durable 时落盘；否则仅内存 apply）

它不负责：
- 具体 HTTP/IDB/SQLite 的实现细节（归 atoma-backend）

---

## 4. 推荐 workspace 拆包结构（围绕 backend + client + plugin）

结合两份规划文档，建议最终形态按“能力层”拆：

```
packages/
  atoma-shared/           # 可选：最底层工具（url/errors/version/zod glue）
  atoma-protocol/         # 协议（ops build/validate/http/sse）
  atoma-observability/    # trace/debug types + runtime
  atoma-core/             # 本地状态核心（store/mutation/history/indexes/relations/runtime io）
  atoma-backend/          # 实现层（http/idb/memory/sqlite/batch）
  atoma-client/           # createClient + wiring + plugin system（依赖 core/protocol/backend）
  atoma-sync/             # 同步插件（依赖 atoma-client 的 plugin API；不反向依赖 client）
  atoma-react/            # React bindings
  atoma-server/           # server handlers + adapters（typeorm/prisma/...）
```

依赖方向（必须保持单向）：

```
shared
  ↑
protocol      observability
  ↑              ↑
  └── core ──────┘
        ↑
     client  ← backend
        ↑
      sync
      react
```

关键约束：
- `core -> backend` 禁止（核心不能知道“怎么发请求/怎么落盘”）
- `client -> sync` 禁止（否则 sync 也依赖 client 会形成环；sync 必须是“外置插件”）

---

## 5. Backend 与 Client/Plugin 的结合点（接口与数据流）

### 5.1 backend 对 client 的最小接口
backend 最终只需要提供“执行协议 ops”的对象（端点级别），以及一个顶层 `Backend` 组合这些端点：

```ts
type OpsClientLike = {
  executeOps(input: {
    ops: Operation[]
    meta: Meta
    signal?: AbortSignal
    context?: ObservabilityContext
  }): Promise<{ results: OperationResult[]; status?: number }>
}
```

> `atoma-backend` 的 `HttpOpsClient/IndexedDBOpsClient/...` 实现这个接口即可。

### 5.2 client 如何装配 store/remote 两个通道
client 不再解析“多 backend union config”。它只接收一个已装配完成的：

```ts
type Backend = {
  key: string
  store: { opsClient: OpsClientLike }
  remote?: { opsClient: OpsClientLike }
  capabilities?: { storePersistence?: 'ephemeral' | 'durable' | 'remote' }
  dispose?: () => void | Promise<void>
}
```

装配规则变为：
- 统一把请求送入 I/O pipeline（middleware 链）
- pipeline 最终把请求分发到对应通道的 `opsClient.executeOps`

### 5.3 plugin 如何“结合 backend”但不耦合
plugin 永远不 import backend，也不持有 opsClient：
- 想改请求：用 `ctx.io.use(mw)`（例如注入 token、打点、mock、重试）
- 想做业务动作：用 `ctx.store/ctx.remote` 高阶 API

这能保证 backend 拆包后：
- plugin 不需要变
- backend 不需要知道 plugin 的存在

---

## 6. 与 atoma-sync 的结合（重点：不形成环）

### 6.1 sync 的定位
`atoma-sync` 是一个“纯插件包”：
- 依赖 `atoma-client` 暴露的 `ClientPluginContext`
- 通过 `ctx.remote.*` 与 `ctx.writeback.commit` 工作

### 6.2 notify/subscribe 的边界
notify 的 SSE 连接属于“远端能力”，但实现不应该进 sync：
- backend 可以提供中性的 `notify.subscribe(...)`（具体底层可以是 SSE/WS/自定义）
- client 负责把它包装为 `ctx.remote.subscribeNotify?`（统一解码/错误归一化/trace 注入）
- sync 只调用 `ctx.remote.subscribeNotify?`，不关心 EventSource/解析细节

---

## 7. 导入/别名策略（拆包后仍保持清晰）

规则（直接沿用拆包规划）：
- 跨包：只用包名导入（例如 `import { Backend } from 'atoma-backend'`）
- 包内：只用包前缀别名（例如 `#client/*`、`#backend/*`、`#sync/*`）

这样能避免多包后 `#/` 根别名冲突，也更符合 Node/TS 工具链。

---

## 8. 落地步骤（不写兼容层，一次到位）

1) 定义并固定 `Backend`/`BackendEndpoint`/`OpsClientLike` 最小接口（建议放到轻量包或 client 公共类型里，避免污染与环）。
2) `createClient` 入参改为只接收 `backend: Backend`（不再接收 union config / store.role / storeBatch 等）。
3) `atoma-client` 内置 `createHttpBackend(...)`（零依赖）；其余 backend 通过独立包提供 `createXxxBackend(...) => Backend`。
4) 确保 `atoma-core`/runtime 只依赖 `OpsClientLike`（最小接口）与 `protocol/observability` 的类型，不依赖 backend 实现包。
5) `atoma-sync` 只依赖 `atoma-client` 的 plugin API（不依赖 backend，不依赖 core 内部实现）。

---

## 9. 关键检查清单（拆分后必须成立）

- `atoma-core` 的依赖树不包含 fetch/IDB/sqlite 等实现依赖
- 插件只能通过 `ClientPluginContext` 工作（无 `ctx.runtime`、无 `io.executeOps`）
- `atoma-client` 不依赖 `atoma-sync`
- `atoma-backend` 不依赖 `atoma-client`
