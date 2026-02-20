# atoma-types 类型清理清单（全量扫描）

## 扫描范围
- 路径：`packages/atoma-types/src/**`
- 统计口径：
  - `export type` 声明行：291
  - 直连同义别名（`A = B`）行：13
  - map 索引别名（`A = Map['k']` / `A = Map[keyof Map]`）行：6
  - 函数签名别名（`A = (...) => ...`）行：7

## 判定规则（本清单使用）
- 规则 1：单层转发别名（不提供额外语义）应内联或删除。
- 规则 2：`PayloadMap` 索引型 `Args` 别名应删除，直接使用索引访问类型。
- 规则 3：标量 token / 领域语义类型（即便是 `string` 别名）默认保留。
- 规则 4：涉及公开语义分层、判别联合可读性的类型默认保留。

## 必须清理（第一批，建议直接落地）

| 类型 | 定义位置 | 当前定义 | 建议动作 | 主要影响点 |
| --- | --- | --- | --- | --- |
| `EventRegister` | `packages/atoma-types/src/client/plugins/contracts.ts:9` | `(events: StoreEvents) => () => void` | 内联到 `PluginEvents.register`，删除该别名导出 | `packages/atoma-types/src/client/plugins/contracts.ts:12`, `packages/atoma-types/src/client/plugins/index.ts:2` |
| `ReadStartArgs` | `packages/atoma-types/src/runtime/store/events.ts:50` | `StoreEventPayloadMap<T>['readStart']` | 删除别名，消费方直接写 map 索引类型 | `packages/atoma-types/src/runtime/index.ts:34`, `packages/plugins/atoma-observability/src/plugin.ts:6`, `packages/plugins/atoma-observability/src/plugin.ts:213` |
| `ReadFinishArgs` | `packages/atoma-types/src/runtime/store/events.ts:51` | `StoreEventPayloadMap<T>['readFinish']` | 删除别名，消费方直接写 map 索引类型 | `packages/atoma-types/src/runtime/index.ts:35`, `packages/plugins/atoma-observability/src/plugin.ts:5`, `packages/plugins/atoma-observability/src/plugin.ts:225` |
| `WriteStartArgs` | `packages/atoma-types/src/runtime/store/events.ts:52` | `StoreEventPayloadMap<T>['writeStart']` | 删除别名，消费方直接写 map 索引类型 | `packages/atoma-types/src/runtime/index.ts:36`, `packages/plugins/atoma-observability/src/plugin.ts:9`, `packages/plugins/atoma-observability/src/plugin.ts:242` |
| `WriteCommittedArgs` | `packages/atoma-types/src/runtime/store/events.ts:53` | `StoreEventPayloadMap<T>['writeCommitted']` | 删除别名，消费方直接写 map 索引类型 | `packages/atoma-types/src/runtime/index.ts:37`, `packages/plugins/atoma-observability/src/plugin.ts:7`, `packages/plugins/atoma-observability/src/plugin.ts:253` |
| `WriteFailedArgs` | `packages/atoma-types/src/runtime/store/events.ts:54` | `StoreEventPayloadMap<T>['writeFailed']` | 删除别名，消费方直接写 map 索引类型 | `packages/atoma-types/src/runtime/index.ts:38`, `packages/plugins/atoma-observability/src/plugin.ts:8`, `packages/plugins/atoma-observability/src/plugin.ts:263` |
| `ClientRuntime` | `packages/atoma-types/src/client/client.ts:6` | `Runtime` | 删除别名，直接使用 `Runtime` | 仅定义处命中（仓内无其他消费） |
| `WriteEntryResult` | `packages/atoma-types/src/protocol/operation.ts:154` | `WriteItemResult` | 删除别名，统一使用 `WriteItemResult` | `packages/atoma-types/src/protocol/index.ts:31` |
| `ChangesPullResultData` | `packages/atoma-types/src/protocol/operation.ts:161` | `ChangeBatch` | 删除别名，统一使用 `ChangeBatch` | `packages/atoma-types/src/protocol/index.ts:33` |

## 可选清理（第二批，按 API 稳定性决定）

| 类型 | 定义位置 | 当前定义 | 建议动作 | 风险/备注 | 主要影响点 |
| --- | --- | --- | --- | --- | --- |
| `EmitFn` | `packages/atoma-types/src/observability/index.ts:63` | `(type, payload?, meta?) => void` | 可删除并在 `ObservabilityContext.emit` 处直接用函数签名 | 仓内无消费，但属于公开导出，若外部用户依赖会有破坏性变更 | 仅定义处命中 |
| `StoreListener` | `packages/atoma-types/src/runtime/store/state.ts:6` | `() => void` | 可内联到 `StoreState.subscribe` 参数 | 可读性略降；若对外直接 import 该类型会破坏 | `packages/atoma-types/src/runtime/store/state.ts:10`, `packages/atoma-types/src/runtime/index.ts:25` |
| `StoreSnapshot` | `packages/atoma-types/src/runtime/store/state.ts:4` | `ReadonlyMap<EntityId, T>` | 可内联到 `StoreState.snapshot` 返回类型 | 该名在 runtime 实现里被直接使用，删除会有较多替换 | `packages/atoma-runtime/src/store/StoreState.ts:3`, `packages/atoma-runtime/src/store/StoreState.ts:7`, `packages/atoma-runtime/src/store/StoreState.ts:17`, `packages/atoma-types/src/runtime/index.ts:25` |
| `SyncSubscribe` | `packages/atoma-types/src/sync/transport.ts:46` | 订阅函数签名别名 | 可内联到 `SyncSubscribeTransport.subscribe` | 仅 3 处引用，清理收益一般 | `packages/atoma-types/src/sync/transport.ts:70`, `packages/atoma-types/src/sync/index.ts:16` |
| `DataProcessorBaseContext<T>` | `packages/atoma-types/src/core/processor.ts:26` | 带未使用泛型的基础上下文 | 建议去掉未使用的 `<T>`（保留类型名），或并入 `DataProcessorContext` | 不属于纯删除；是类型结构优化 | `packages/atoma-types/src/core/processor.ts:33`, `packages/atoma-types/src/runtime/transform.ts:2`, `packages/atoma-types/src/runtime/transform.ts:14`, `packages/atoma-types/src/core/index.ts:28` |

## 不建议清理（已检查，建议保留）

| 类型组 | 代表类型 | 保留原因 |
| --- | --- | --- |
| 领域标量 token | `EntityId`, `Cursor`, `Version`, `CursorToken`, `ResourceToken`, `StoreToken`, `ExecutionRoute`, `ExecutorId`, `PanelId`, `SourceId` | 这些类型虽然是 `string/number` 别名，但承载明确领域语义，不是噪音别名 |
| 领域行为函数契约 | `StoreUpdater`, `DataProcessorStageFn`, `EventHandler` | 在多处 API 中复用，直接内联会降低可读性与维护性 |
| 判别联合与协议核心组合 | `WriteItem`, `WriteEntry`, `RemoteOp`, `RemoteOpResult`, `ExecutionEvent`, `Envelope` | 承担模型抽象与判别联合语义，非“单层转发” |
| 结构组合类型 | `IndexesLike`, `RelationMap`, `WriteManyResult` | 表达组合语义，删除后通常只会制造重复类型文本 |

## 一步到位执行建议（无兼容层）

1. 先做“必须清理”9 项，删除旧名并同步删掉对应 re-export。
2. 同步修复消费点（重点：`packages/plugins/atoma-observability/src/plugin.ts` 与 `packages/atoma-types/src/runtime/index.ts`）。
3. 再评估“可选清理”5 项，按是否接受公开 API 破坏逐项落地。
4. 验证顺序：
   - `pnpm --filter atoma-types run typecheck`
   - `pnpm --filter @atoma/plugin-observability run typecheck`（若包名与实际不符按 workspace 名称调整）
   - `pnpm typecheck`

