# Atoma Server 架构说明（Web `Request`/`Response`，zh）

本目录的 `atoma/server` 实现是一个**协议内核**：只处理 Atoma client 协议（ops + subscribe SSE），不内置路由框架、不内置鉴权策略。

## 入口

对外入口：`createAtomaHandlers(config)`（`src/server/createAtomaHandlers.ts`）

它返回两个 handler（宿主框架自行路由到对应 handler）：
- `ops(request: Request): Promise<Response>`
- `subscribe(request: Request): Promise<Response>`（SSE）

## 安全模型（重要）

`atoma/server` **不实现**行级数据隔离（Row-Level Security / 多租户隔离）的通用方案，也不提供 forced where、field policy 等策略实现。

你需要在宿主应用/数据库侧承担安全边界：
- **ops 资源控制**：由宿主框架决定是否允许调用某 resource/某操作；字段级脱敏建议通过 `op` 插件做
- **subscribe 变更流隔离**：优先由 DB/RLS 或 `ISyncAdapter` 保证“只拉取可见 changes”，否则会泄露变更流

## 目录分层（当前实现）

1) `src/server/runtime/*`
   - runtime 创建（trace/requestId/logger/context）
   - 顶层错误格式化（统一 envelope）
   - HTTP 辅助（body 读取、HandleResult、basePath 工具）

2) `src/server/core/*`
   - 默认执行器：`opsExecutor`、`subscribeExecutor`
   - 写语义：`write.ts`
   - 其他内核工具

3) `src/server/adapters/*`
   - 端口契约：`adapters/ports.ts`（`IOrmAdapter/ISyncAdapter/AtomaChange`）
   - 具体实现：Prisma/TypeORM

## 调用关系（概念）

- `createAtomaHandlers(config)`
  - `runtime.createRuntime(...)` 创建 per-request runtime
  - `core.opsExecutor.handle(...)` 执行 ops 并返回标准 envelope
  - `core.subscribeExecutor.subscribe(...)` 输出 SSE（`event: changes`）

## 插件模型（中立扩展点）

`AtomaServerConfig.plugins` 提供三类插件：
- `plugins.ops[]`：围绕整个 `ops()`，处理 `Response`
- `plugins.subscribe[]`：围绕整个 `subscribe()`，处理 `Response`
- `plugins.op[]`：围绕每个 op（query/write/changes.pull），处理结构化结果（适合做资源控制后的字段级过滤/审计打点）
