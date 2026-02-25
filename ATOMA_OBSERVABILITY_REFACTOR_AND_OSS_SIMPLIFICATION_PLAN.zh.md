# ATOMA Observability 设计与重构方案（含开源库简化）

## 1. 背景与目标

`plugins/atoma-observability` 当前实现功能完整，但复杂度主要集中在一个编排入口文件，导致维护成本上升、扩展路径不清晰。

本方案目标：

- 在不牺牲现有能力的前提下，降低插件复杂度与认知负担。
- 将“事件编排、状态缓存、导出上报、查询分页”拆分为独立职责模块。
- 用成熟开源库替代可替代的通用基础能力（采样、trace、队列、日志、LRU）。
- 遵循仓库约束：不保留兼容别名，不做双路径长期并存，重构一步到位收敛。

非目标：

- 不把 observability 回灌到 core/runtime 业务语义层。
- 不引入与 `atoma-types` 边界冲突的逆向依赖。

---

## 2. 现状复杂度诊断（基于当前代码）

### 2.1 文件与职责分布

- `packages/plugins/atoma-observability/src/plugin.ts`（约 407 行）
  - 同时负责：事件订阅、context 缓存、trace 记录、分页查询、devtools source 广播、用户 sink 透传。
- `packages/plugins/atoma-observability/src/runtime/observability-runtime.ts`（约 209 行）
  - 同时负责：trace slot、采样判断、active/inactive context、事件序号、payload 摘要/脱敏。
- `packages/plugins/atoma-observability/src/store-observability.ts`（约 47 行）
  - 负责每 store runtime 缓存与配置注册。
- `packages/plugins/atoma-observability/src/trace/*`、`sampling/*`、`utf8/*`
  - 基础工具，边界相对清晰。

### 2.2 关键复杂点（锚点）

- `plugin.ts:112` `emitWriteLifecycle`：写入与变更生命周期共用路径，耦合 context 获取与释放。
- `plugin.ts:134` `pushTraceEvent`：trace 缓冲、修剪、revision 推进、panel 广播揉在一起。
- `plugin.ts:198` `snapshot`：过滤、搜索、分页手写循环与游标逻辑集中。
- `plugin.ts:258` 开始：`_ctx.events.on(...)` 大段事件路由与 payload 映射重复。
- `observability-runtime.ts:65` `createContext`：采样/激活态/解释模式/traceId 分配分支密集。
- `observability-runtime.ts:98` `getTraceSlot`：手写 LRU-like 淘汰。

### 2.3 根因总结

- 编排层与数据层未分离：`plugin.ts` 既是 orchestrator，也是数据处理器。
- “读写生命周期”和“导出策略”耦合：想新增导出目标时必须改动核心编排代码。
- 通用基础能力自研：采样、LRU、队列导出、日志等均可由成熟库承接。

---

## 3. 目标架构（收敛版）

### 3.1 模块边界

1. `plugin.ts`（入口编排）
- 仅负责 wiring：注册 source、装配 bridge/store/exporter、统一 dispose。
- 不持有业务状态数组，不写过滤分页算法。

2. `lifecycleBridge.ts`（事件桥）
- 负责 `_ctx.events` 到 `ObservabilityContext.emit` 的映射。
- 维护 `readContextByQuery` / `writeContextByAction` 生命周期。

3. `traceStore.ts`（trace 缓存与查询）
- 负责 `record(event)`、`snapshot(query)`、`revision/timestamp`。
- 仅返回结构化快照，不感知 `_ctx.events`。

4. `exporter/*`（导出通道）
- 统一接口：`export(event)` / `flush()` / `dispose()`。
- 可实现：`devtoolsExporter`、`pinoExporter`、`otlpExporter`。

5. `runtime/observability-runtime.ts`（轻量运行时）
- 聚焦：trace context、emit 事件标准化。
- LRU/采样/上报策略尽量交由开源库。

### 3.2 建议目录

```text
packages/plugins/atoma-observability/src/
  plugin.ts
  lifecycle/
    lifecycleBridge.ts
  storage/
    traceStore.ts
    traceQuery.ts
  exporter/
    types.ts
    devtoolsExporter.ts
    pinoExporter.ts
    otlpExporter.ts
  runtime/
    observability-runtime.ts
    runtimeFactory.ts
  trace/
  sampling/
  utf8/
```

---

## 4. 用开源库简化：替换映射

| 当前自研点 | 代码锚点 | 建议开源库 | 替换方式 | 预期收益 |
|---|---|---|---|---|
| 采样判定 `isSampled` | `sampling/fns.ts` | `@opentelemetry/core`（Sampler） | 用 OTel Sampler 接管采样策略 | 统一语义，减少自定义哈希与边界判断 |
| context/span 语义 | `runtime/observability-runtime.ts` | `@opentelemetry/api` + `@opentelemetry/sdk-trace-base` | `ObservabilityContext` 内部映射到 Span/Context | 减少 active/inactive 分支状态机 |
| LRU-like trace slot 淘汰 | `observability-runtime.ts:98` | `quick-lru` | 以 `QuickLRU<string, TraceSlot>` 代替手写 Map 淘汰 | 代码更短，行为更稳定 |
| 事件导出缓冲/并发控制 | `plugin.ts` 中手写 push/broadcast | `p-queue`（仓库已存在锁） | exporter 内统一排队、限流、批量 flush | 降低阻塞风险，便于扩展远端上报 |
| 日志 sink | `registerStore` 中 `debugSink` 直连 | `pino` | 新增 `pinoExporter` 实现结构化日志导出 | 可观测事件可直接落盘/接日志平台 |
| 重试策略（远端上报） | 当前无统一策略 | `p-retry`（仓库已存在） | `otlpExporter` 中包裹重试策略 | 提高导出可靠性 |

说明：

- 优先级最高的是 OTel + exporter 抽象。它可以把当前“事件定义 + 采样 + 上报”拆成标准组件。
- `p-queue`、`p-retry` 已在仓库锁文件出现，可优先复用现有生态。

---

## 5. 分阶段重构计划（可执行）

### 阶段 0：建立基线（不改行为）

- 记录现有输出行为：`snapshot` 返回结构、`timeline:event` 触发时机、`debugSink` 调用顺序。
- 给 `plugin.ts` 关键路径加单测（读/写/变更成功与失败）。

验收：

- 新旧测试快照一致。

### 阶段 1：拆编排与存储（低风险）

- 新建 `storage/traceStore.ts`，迁移 `traceRecords + snapshot + revision`。
- 新建 `lifecycle/lifecycleBridge.ts`，迁移 `_ctx.events.on(...)` 绑定与 context Map 管理。
- `plugin.ts` 仅保留：组装对象 + dispose 反向清理。

验收：

- 对外 API 不变。
- `plugin.ts` 降至约 150~200 行。

### 阶段 2：引入 exporter 抽象

- 定义 `Exporter` 接口，先落地 `devtoolsExporter`（完全对齐现行为）。
- `registerStore` 中由 exporter 链处理 `debugSink` 透传。

验收：

- devtools 面板数据与原实现一致。
- 用户自定义 `debugSink` 调用时序一致。

### 阶段 3：替换通用基础能力

- `quick-lru` 替换 runtime 手写 trace slot 淘汰。
- `p-queue` 管理导出并发与批处理。
- `p-retry` 引入远端导出重试（如启用 otlp/http exporter）。

验收：

- 高并发读写时无事件丢失（或在可接受策略下有明确统计）。

### 阶段 4：OTel 收敛（可选但推荐）

- runtime 内部改为 OTel Span/Context 模型。
- 保留 Atoma 外部 `observe.createContext` API，不暴露 OTel 细节。
- 事件模型统一映射到语义字段，减少自定义字段分叉。

验收：

- 语义一致：`traceId/requestId/spanId/parentSpanId` 可追踪。
- 业务层无侵入改动。

---

## 6. 建议接口草图

```ts
export type Exporter = {
    export: (event: DebugEvent & { storeName: string }) => void | Promise<void>
    flush?: () => Promise<void>
    dispose?: () => Promise<void> | void
}

export type TraceStore = {
    record: (args: { storeName: string; event: DebugEvent; now: number }) => void
    snapshot: (query: SnapshotQuery, now: number) => SnapshotEvent
    revision: () => number
}

export type LifecycleBridge = {
    mount: () => void
    dispose: () => void
}
```

设计要点：

- `TraceStore` 只处理数据，不处理事件来源。
- `LifecycleBridge` 只处理来源映射，不处理导出与分页。
- `Exporter` 只处理输出，不关心 context 创建策略。

---

## 7. 兼容与命名策略（遵循仓库规则）

- 不保留旧导出别名；模块重命名一次性替换。
- 不引入“临时兼容层”长期存在。
- 路径语义已提供上下文时，避免重复命名前缀。
- 仅使用 `atoma-types/*` 子路径导入，不使用根导入。

---

## 8. 风险与规避

风险点：

- lifecycle 解绑遗漏导致内存泄漏。
- `snapshot` 游标行为变化导致 devtools 翻页异常。
- 多 exporter 并存时出现重复发送或顺序漂移。

规避策略：

- 用一致性测试锁定 `snapshot.page` 语义。
- dispose 统一逆序释放（保持当前 while+pop 反向语义）。
- exporter 链明确“至少一次/至多一次”策略并写入注释与测试。

---

## 9. 验证命令建议

按影响包执行：

1. `pnpm --filter atoma-observability run typecheck`
2. `pnpm --filter atoma-observability run build`
3. `pnpm typecheck`
4. `pnpm test`

---

## 10. 推荐落地顺序（最短路径）

1. 先做阶段 1（拆 `traceStore` + `lifecycleBridge`），快速降复杂度。
2. 紧接阶段 2（exporter 抽象），清理 `plugin.ts` 剩余耦合。
3. 再做阶段 3（quick-lru/p-queue/p-retry），提升稳定性。
4. 最后评估阶段 4（OTel）是否一次切换；若切换，则直接替换，不保留双实现。

该顺序能在最小风险下先获得最大可维护性收益，并为开源标准化（OTel）预留清晰落点。
