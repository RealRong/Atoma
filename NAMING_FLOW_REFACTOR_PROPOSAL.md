# Atoma 读写主链命名优化提案（基于 CODE_QUALITY_VALIDATION_STANDARD）

> 日期：2026-02-12  
> 目标：对当前 `runtime/client/plugins/backends/sync/observability` 主链做命名收敛，降低术语噪音与认知切换成本。  
> 原则：不考虑兼容包袱，直接收敛到终态命名。

---

## 1. 审计范围

本次扫描覆盖：

- `packages/atoma-types/src/runtime/*`
- `packages/atoma-runtime/src/runtime/*`
- `packages/atoma-client/src/createClient.ts`
- `packages/atoma-client/src/plugins/*`
- `packages/atoma-client/src/defaults/LocalBackendPlugin.ts`
- `packages/plugins/atoma-backend-{http,memory,indexeddb}/*`
- `packages/plugins/atoma-sync/src/persistence/*`
- `packages/plugins/atoma-observability/src/plugin.ts`

---

## 2. 命名问题总览（按标准）

### 2.1 同域术语混用（P0）

- 同一策略域同时使用 `query / persist / writePolicy` 三套词根：
  - `PersistRequest` / `PersistResult`
  - `StrategyQueryRequest` / `StrategyQueryResult`
  - `WritePolicy`
- 这会让“策略层到底在处理 write 还是 persist”语义不稳定。

### 2.2 描述对象命名不清（P0）

- `StrategyDescriptor` 语义偏泛。
- `descriptor.write` 实际是策略选项（policy），不是 write handler，语义冲突。

### 2.3 单通道后仍保留泛型噪音（P1）

- `PluginRegistry` 已经是 `ops-only`，但仍有 `HandlerMap/HandlerName/execute(name, ...)` 这套多通道抽象痕迹。

### 2.4 API 语义与行为不完全一致（P1）

- `ReadFlow.getAll` 实际行为是“远端拉取+本地对齐写回”，更像 `sync` 语义。
- `getAll/fetchAll` 名字对缓存副作用表达不够直观。

---

## 3. 你点名的 6 个命名：统一方案（推荐）

## 推荐词根

- 统一策略域主词根：`query / write / policy / spec`
- 在策略域中，统一输入输出命名范式：`Input / Output`
- **前缀规则**：仅在少量“域锚点”保留 `Strategy`（如 `StrategyRegistry`、`StrategySpec`），其余类型去前缀

| 当前名 | 建议名 | 理由 |
|---|---|---|
| `PersistRequest` | `WriteInput` | `persist` 语义收敛为 `write`，更直观 |
| `PersistResult` | `WriteOutput` | 与 `WriteInput` 对称，输入输出一致 |
| `StrategyDescriptor` | `StrategySpec` | 保留一个域锚点，避免 `Spec` 过泛 |
| `StrategyQueryRequest` | `QueryInput` | 去冗余前缀，靠模块上下文表达语义 |
| `StrategyQueryResult` | `QueryOutput` | 与 `QueryInput` 对称，短且清晰 |
| `WritePolicy` | `Policy`（或保留 `WritePolicy`） | 策略域内可进一步简化；若担心歧义可保留 `WritePolicy` |

### 同步建议（同一批次改）

- `StrategyQueryHandler` -> `QueryExecutor`
- `PersistHandler` -> `WriteExecutor`
- `StrategyRegistry.persist` -> `StrategyRegistry.write`
- `StrategyRegistry.query(req: StrategyQueryRequest)` -> `StrategyRegistry.query(input: QueryInput)`
- `StrategyDescriptor.write`（当前是 policy）-> `StrategySpec.policy`

> 说明：如果希望“最小改名”，可保留 `Request/Result` 后缀（`WriteRequest/WriteResult`），但不建议再加 `Strategy` 前缀。

---

## 4. 除上述 6 个外，建议一并优化的命名

## 4.1 Strategy 与 Runtime（P0/P1）

| 位置 | 当前名 | 建议名 | 级别 | 备注 |
|---|---|---|---|---|
| `runtime/strategy` | `setDefaultStrategy` | `setDefault` | P1 | 上下文已在 `StrategyRegistry`，去冗余 |
| `runtime/strategy` | `resolveWritePolicy` | `resolvePolicy` | P1 | 若策略域仅一类 policy，可简化 |
| `runtime/persistence` | `Persistence` | `WritePort` | P1 | `Persistence` 过泛，语义不聚焦 |
| `runtime/persistence` | `StrategyQueryRequest/Result` | `QueryInput/Output` | P0 | 去除重复域前缀，统一输入输出范式 |
| `runtime/persistence` | `PersistRequest/Result` | `WriteInput/Output` | P0 | 同域术语统一到 `write` |

## 4.2 Client/Plugin 单通道化命名（P1）

| 位置 | 当前名 | 建议名 | 级别 | 备注 |
|---|---|---|---|---|
| `atoma-client/plugins/PluginRegistry.ts` | `PluginRegistry` | `OpsHandlerRegistry` | P1 | 现在仅处理 ops，类名应直达职责 |
| 同文件 | `register(name, handler)` | `register(handler)` | P1 | 只剩单通道，无需 `name` 参数 |
| 同文件 | `execute({ name, req, ctx })` | `execute(req, ctx)` | P1 | 同上，移除历史多路抽象噪音 |
| `atoma-client/plugins/PluginOpsClient.ts` | `PluginOpsClient` | `RegistryOpsClient` | P2 | 更贴近“registry adapter”角色 |

## 4.3 createClient 内部辅助命名（P2）

| 当前名 | 建议名 | 理由 |
|---|---|---|
| `ensureDebugHub` | `initDebugHub` | 更短，且保持“确保可用”语义 |
| `WriteGroup` | `EntryGroup` | 上下文已在 write 域，去冗余 |
| `buildWriteOptionsKey` | `optionsKey` | 表达结果即可，避免过程化命名 |
| `groupWriteEntries` | `groupEntries` | 函数所在上下文已限定 write |

## 4.4 ReadFlow 语义对齐（P1）

| 当前名 | 建议名 | 问题 |
|---|---|---|
| `decideQueryCacheWrite` | `queryStorePolicy` | 短且仍表达“query 对 store 的策略” |
| `effectiveSkipStore` | `skipStore` | 语义直接，避免冗余后缀 |
| `getAll`（当前行为） | `syncAll` | 保留核心语义，避免过长 |

## 4.5 Sync / Observability（P1/P2）

| 位置 | 当前名 | 建议名 | 级别 |
|---|---|---|---|
| `sync-persist-handlers.ts` | `SyncPersistHandlers` | `SyncWrites` | P1 |
| 同文件 | `toDirectRequest` | `asDirectWrite` | P2 |
| `observability/plugin.ts` | `attachTraceMeta` | `attachQueryTrace` + `attachWriteTrace` | P1 |

---

## 5. 统一术语字典（建议作为团队约束）

- 读取：`query`
- 写入：`write`
- 策略定义：`spec`
- 策略选项：`policy`
- 输入/输出：`Input` / `Output`
- 执行器（函数签名）：`Executor`
- 注册器（链路管理）：`Registry`
- 策略前缀：仅保留在域锚点（`StrategyRegistry`、`StrategySpec`），数据类型默认不带 `Strategy`

---

## 5.1 最终推荐（唯一选项，短名优先）

> 用于评审直接拍板，避免同一项保留多个备选名。

| 当前名 | 最终推荐 |
|---|---|
| `PersistRequest` | `WriteInput` |
| `PersistResult` | `WriteOutput` |
| `StrategyDescriptor` | `StrategySpec` |
| `StrategyQueryRequest` | `QueryInput` |
| `StrategyQueryResult` | `QueryOutput` |
| `WritePolicy` | `Policy` |
| `StrategyQueryHandler` | `QueryExecutor` |
| `PersistHandler` | `WriteExecutor` |
| `setDefaultStrategy` | `setDefault` |
| `resolveWritePolicy` | `resolvePolicy` |
| `PluginRegistry` | `OpsHandlerRegistry` |
| `PluginOpsClient` | `RegistryOpsClient` |
| `ensureDebugHub` | `initDebugHub` |
| `WriteGroup` | `EntryGroup` |
| `buildWriteOptionsKey` | `optionsKey` |
| `groupWriteEntries` | `groupEntries` |
| `decideQueryCacheWrite` | `queryStorePolicy` |
| `effectiveSkipStore` | `skipStore` |
| `getAll`（当前行为） | `syncAll` |
| `SyncPersistHandlers` | `SyncWrites` |
| `toDirectRequest` | `asDirectWrite` |
| `attachTraceMeta` | `attachQueryTrace` + `attachWriteTrace` |

---

## 6. 落地顺序（建议）

1. **P0**：策略域核心类型改名（本提案第 3 节）
2. **P1**：`PluginRegistry` 单通道命名去泛型噪音
3. **P1**：`ReadFlow` 语义名称修正（尤其 `getAll`）
4. **P1/P2**：sync/observability 与 createClient 辅助命名清理

---

## 7. 预期收益

- 策略域语义统一（不再 `persist/write/query` 混用）
- 主链认知负担下降（看名字即可判断职责）
- 单通道架构与命名一致，不再保留历史抽象痕迹
- 后续扩展（queue/local-first/custom strategy）命名成本更低
