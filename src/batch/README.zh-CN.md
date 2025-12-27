# Atoma Batch（客户端批处理）

本目录实现 Atoma 的**客户端批处理引擎**（BatchEngine），主要被适配器（最常见是 HTTPAdapter）用来把大量小操作合并为更少的 `POST /ops` 请求。

## 能力概览

- **两条独立 lane**
  - **Query lane**：批处理 QueryOp。
  - **Write lane**：批处理 WriteOp。
- **合并式 flush（coalesced flush）**
  - 默认用 microtask 同 tick 合并。
  - 可通过 `flushIntervalMs` 延迟 flush，提高合批率。
- **背压（Backpressure）**
  - `maxQueueLength` 可全局或按 lane 配置。
  - Query lane 溢出策略可选：拒绝新入队 / 丢弃最旧 query。
- **并发控制**
  - `queryMaxInFlight` / `writeMaxInFlight` 分别限制两条 lane 的并发请求数。
- **可观测性对接**
  - 当 task 携带 `traceId` + `debugEmitter` 时，会发出 `adapter:request/adapter:response` 事件。

## 主要模块

- `BatchEngine.ts`
  - 对外入口：`enqueueOp` / `enqueueOps`、`dispose`。
  - 负责生命周期与共享 transport（headers + fetch + JSON 解析）；lane 的调度/队列算法在 `QueryLane`/`WriteLane` 内部。
- `queryLane.ts`
  - drain QueryOp 任务并发送 `POST /ops`。
  - 保持 FIFO 边界，并避免把“有 trace/无 trace”的任务混到同一个请求里。
- `writeLane.ts`
  - drain WriteOp 任务并发送 `POST /ops`。
- `internal.ts`
  - 内部辅助：配置归一化、小工具、adapter 事件 fan-out，以及 `executeOpsTasksBatch`（组 payload → 发送 → 解析 → results 映射/兜底）。
- （不在本目录）`src/adapters/http/transport/queryParams.ts`
  - 把 `FindManyOptions<T>` 翻译为服务端 ops 协议需要的 `QueryParams`（要求 `params.page`），供 HTTP ops 路由层构造 QueryOp 使用。

## 运行流程（端到端）

### 1）适配器入队（enqueue）

启用 batch 的适配器会创建 `BatchEngine`，然后调用：

- `enqueueOp(op, internalContext?)`
- `enqueueOps(ops, internalContext?)`

其中 `internalContext` 是内部可观测性上下文；若包含 `traceId` 与 `emitter`，会被复制到 task 上用于后续埋点与归因。

### 2）调度与 flush（coalesced）

调度策略由 `BatchEngine` 统一持有：

- 每条 lane 各自维护 `*Scheduled` 和可选 `*Timer`。
- 默认：同一 tick 的多次 enqueue 会合并到一次 microtask flush。
- `flushIntervalMs > 0`：允许延迟 flush，提高合批率。
  - 设计目标是：在 `flushIntervalMs` 窗口内尽量合并更多 enqueue，减少请求次数。

### 3）drain 为 HTTP 请求

每次 drain 会：

- 选出一批 task（query/write 各自 FIFO）
- 构造 payload
- 通过 `BatchEngine` 内部 transport（fetch）发送 `POST /ops`
- 把服务端 results 映射回每个 task 的 promise

### 4）trace/requestId 与请求头规则

为了保持 trace 语义干净，一个 batch request 只有在满足“**该请求内所有任务都带相同且非空的 traceId**”时，才会写入：

- 请求头：`x-atoma-trace-id` / `x-atoma-request-id`
- payload `meta`：`traceId` / `requestId`

若该请求内存在混用（不同 traceId，或 trace + no-trace 混用）：

- 不会写入 trace 相关 header/payload meta 字段
- debug 事件会标记 `mixedTrace: true`

### 5）adapter 事件（adapter:request / adapter:response）

当 task 带 `debugEmitter` 时，query/write 两条 lane 都会发 request 级 adapter 事件。

这里的设计取舍是：

- **按 emitter/store fan-out**（而不是“每个 HTTP request 只发一条事件”），避免混合批次时丢 trace。
- payload 同时包含：
  - emitter 维度的计数（`opCount`，写入还会带 `taskCount`）
  - request 维度的计数（`totalOpCount`）

## 配置建议

- 追求低延迟：保持 `flushIntervalMs = 0`（默认）。
- 追求更高合批率：设置较小的 `flushIntervalMs`（例如 5–20ms），并调 `maxOpsPerRequest` / `maxBatchSize`。
- 追求严格背压：为 `maxQueueLength`（尤其 write lane）设置上限，防止内存增长。
