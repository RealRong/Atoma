# Outbox 架构解耦优化建议

本文基于现有实现（`src/client/internal/create/buildClient.ts`、`src/sync/store.ts`、`src/core/mutation/pipeline/Persist.ts`、`src/sync/engine/SyncEngine.ts`、`src/sync/lanes/PushLane.ts`、`src/client/internal/controllers/SyncController.ts` 等）总结 outbox 的职责边界与当前耦合点，并提出可逐步落地的解耦优化方向。本文仅给出结论与建议，不涉及代码修改。

## 现状职责与耦合概览

### OutboxStore 的核心职责
- **持久化写入队列**：持久化 `SyncOutboxItem`，浏览器默认 IndexedDB，非浏览器内存 fallback。
- **队列规则**：去重、限长淘汰（drop oldest）、事件回调、inFlight 管理与超时恢复。
- **协议适配**：`enqueueOps` 负责将 core 生成的 ops 标准化为 outbox item。
- **冲突缓解**：`rebase` 以服务端 ack 的版本重写后续同实体的 baseVersion。

### 主要耦合路径
- **ClientRuntime ↔ Outbox**：mutation pipeline 在 `persistMode='outbox'` 依赖 `outbox.enqueueOps`。
- **SyncController ↔ Outbox**：绑定 outbox events（queue change/full），并在队列增长时触发 push flush。
- **SyncEngine ↔ Outbox**：push lane 需要 outbox；同一 outboxKey 的单实例 lock 也与 outbox key 绑定。
- **PushLane ↔ Outbox**：peek/ack/reject/releaseInFlight/rebase 形成强功能依赖。

### 耦合的结构性原因
Outbox 是 “写入管线（core） ↔ 同步推送（sync）” 的共享边界，既承担 **写入持久化**，又承担 **推送消费队列**。因此多个层必须共享状态与语义（idempotencyKey、inFlight、rebase）。这在现状下合理，但会放大装配层（buildClient/SyncController）的实现细节耦合。

## 优化目标
- **减少跨层“实现细节”耦合**，让各层依赖更小的接口集合。
- **保持现有语义与兼容性**（队列语义、inFlight、rebase、锁、事件）。
- **让构建层只负责装配**，而非创建/感知具体 store 类型。

## 优化方向（分阶段可落地）

### 1) 接口分层：读写职责拆分（优先级：高）
**问题**：`OutboxStore` 被 core 与 sync 同时依赖，接口过宽。

**建议**：拆成多个更小接口并分配给不同层。
- `OutboxWriter`（供 core）
  - `enqueueOps(ops)`
  - `queueMode`
- `OutboxReader`（供 sync/push lane）
  - `peek/ack/reject/markInFlight/releaseInFlight/rebase/size`
- `OutboxEvents`（供 devtools/监控）
  - `setEvents` 或 `subscribe`

**收益**：
- core 与 sync 的依赖解耦，避免 runtime 依赖 push 侧细节。
- 后续可引入不同存储实现而不影响核心逻辑。

### 2) 事件下沉：队列增长触发 flush（优先级：高）
**问题**：`SyncController` 负责监听 outbox 并触发 push flush，造成 controller 过多“队列语义”认知。

**建议**：将“队列变化 → flush 请求”逻辑下沉到 SyncEngine / PushLane / OutboxScheduler。
- 同步层订阅 outbox 事件，自行决定是否触发 push。
- controller 只负责生命周期、配置与 devtools 的桥接。

**收益**：
- controller 变薄，减少与 outbox 事件的耦合。
- push 语义集中在同步层，职责更一致。

### 3) 装配解耦：buildClient 不直接依赖 DefaultOutboxStore（优先级：中）
**问题**：`buildClient` 直接 new `DefaultOutboxStore`，使装配层锁定具体存储。

**建议**：支持注入或工厂模式：
- `createSyncStores({ keys, options })` 返回 `{ outbox, cursor }`
- `buildClient` 只接受 “已构建的 store” 或 “store factory”

**收益**：
- 易于替换存储实现（SQLite/自定义KV/服务端持久化）。
- buildClient 只关心 wiring，而非具体实现。

### 4) 统一资源解析：SyncResources 模块（优先级：中）
**问题**：`outboxKey/cursorKey/lockKey` 在 buildClient 中计算，逻辑分散。

**建议**：抽出 `SyncResources`（或 `SyncStoresConfigResolver`）模块：
- 输入：`syncDefaults + backend key + deviceId`
- 输出：`outboxKey/cursorKey/lockKey + storage options`

**收益**：
- 资源解析集中，减少装配层复杂度。
- 便于复用与测试（尤其是 deviceId / session fallback 逻辑）。

### 5) 可选：Outbox API 规范化（优先级：低）
**问题**：`enqueueOps` 与 PushLane 的 op 结构约束在 outbox 中隐含。

**建议**：将“outbox item 格式 + op 约束”文档化并外显为类型/断言模块。

**收益**：
- 第三方 outbox 实现更容易对齐协议。
- 提高系统整体可插拔性。

## 兼容性与风险
- 接口拆分可通过 **类型别名 + 适配层** 逐步推进，避免一次性大改。
- 事件下沉需保证：队列变化仍能触发 push（尤其是 `sync.start()` 后）。
- 构建层解耦不影响现有默认实现，保持零配置可用性。

## 建议的演进路径（轻重缓急）
1) **接口拆分**（OutboxWriter/Reader/Events）+ 最小改动适配。
2) **事件下沉**，使 SyncController 只做生命周期/配置桥接。
3) **buildClient 装配解耦**，支持注入 outbox/cursor 或工厂。
4) **SyncResources 抽离**，收敛 key 解析逻辑。

## 结论
当前耦合是由 outbox 作为跨层共享边界导致的“结构性耦合”，并非纯粹的架构失误。但通过 **接口分层、事件下沉、装配解耦**，可以显著降低 `buildClient` 与 `SyncController` 对 outbox 实现细节的依赖，同时保持现有同步语义与可用性。

## 分阶段实施方案（包含改动文件与改法）

### Phase 0：准备与对齐（允许重构，不要求兼容）
- 目标：明确最终目标接口与职责，允许破坏式调整以简化后续重构成本。
- 计划改动：
  - `src/sync/types.ts`
    - **怎么改**：新增更细粒度接口类型（如 `OutboxWriter` / `OutboxReader` / `OutboxEvents`），但先不替换现有引用，仅作为类型别名或扩展接口存在。
  - `src/sync/README.zh-CN.md`
    - **怎么改**：补充 outbox item 规范与接口角色说明（避免第三方实现踩坑）。

### Phase 1：接口拆分（核心结构优化）
- 目标：让 core 与 sync 只依赖最小接口集合，彻底移除“过宽依赖”。
- 计划改动：
  - `src/sync/types.ts`
    - **怎么改**：正式引入 `OutboxWriter` / `OutboxReader` / `OutboxEvents`，并以它们替换旧的 `OutboxStore`（允许破坏式替换）。
  - `src/core/types.ts`
    - **怎么改**：将 `OutboxRuntime` 只保留 `OutboxWriter` 所需字段，移除任何与 push 相关的依赖。
  - `src/core/mutation/pipeline/Persist.ts`
    - **怎么改**：类型收敛到 `OutboxWriter`，避免依赖 outbox 的其他方法。
  - `src/client/internal/create/createClientRuntime.ts`
    - **怎么改**：`outbox` 字段类型改为 `OutboxWriter`（不触及行为）。
  - `src/sync/engine/SyncEngine.ts` / `src/sync/lanes/PushLane.ts`
    - **怎么改**：依赖类型替换为 `OutboxReader`，彻底隔离写入侧能力。

### Phase 2：事件下沉（队列变化触发 push）
- 目标：将 “队列变化 → flush” 逻辑完全移至同步层，`SyncController` 不再感知 outbox 事件语义。
- 计划改动：
  - `src/sync/engine/SyncEngine.ts`
    - **怎么改**：新增可选 `outboxEvents` 订阅或 `outboxSubscribe` 机制，在 push 启用时监听队列变化并触发 `PushLane.requestFlush()`。
  - `src/sync/lanes/PushLane.ts`
    - **怎么改**：暴露 `requestFlush()` 的使用入口给引擎（如果需要）。
  - `src/client/internal/controllers/SyncController.ts`
    - **怎么改**：移除对 outbox 事件的直接监听，devtools 只从引擎事件流获取（不再接触 outbox）。

### Phase 3：装配解耦（buildClient 不直接依赖默认存储）
- 目标：buildClient 只装配，不直接创建 DefaultOutboxStore/DefaultCursorStore，强制走统一工厂。
- 计划改动：
  - `src/sync/store.ts`
    - **怎么改**：将 `createStores()` 设为默认且唯一入口，其他地方禁止 `new DefaultOutboxStore/DefaultCursorStore`。
  - `src/client/internal/create/buildClient.ts`
    - **怎么改**：移除直接 new 的代码，统一调用 `syncStoresFactory`（必须提供；或由内部提供唯一默认实现）。
  - `src/client/types/options.ts` / `src/client/types/sync.ts`
    - **怎么改**：更新配置为强制注入或统一工厂配置（不保留旧字段）。

### Phase 4：资源解析抽离（SyncResources）
- 目标：将 outboxKey/cursorKey/lockKey 解析逻辑集中化，buildClient 不再包含任何 key 生成逻辑。
- 计划改动：
  - `src/client/internal/create/buildClient.ts`
    - **怎么改**：抽出 key 计算到独立模块，buildClient 仅调用 resolver。
  - 新增 `src/client/internal/create/resolveSyncResources.ts`（或相似命名）
    - **怎么改**：封装 `resolveSyncInstanceId` 与 key 生成逻辑，提供可测试、可复用 API。

### Phase 5：Outbox 规范化与验证（必做）
- 目标：让 outbox item 的协议约束在代码中显式化，并作为强制校验规则。
- 计划改动：
  - `src/sync/internal.ts` 或新增 `src/sync/outboxSpec.ts`
    - **怎么改**：集中校验 `SyncOutboxItem` 的结构，PushLane 与 DefaultOutboxStore 复用验证逻辑。
  - `src/sync/README.zh-CN.md`
    - **怎么改**：补齐 outbox item 规范（单 item write op、meta.idempotencyKey、clientTimeMs 等）。

## 实施注意事项
- 以 **最优架构为先**，允许破坏式变更；不考虑兼容旧 API。
- 在 Phase 2 之后，确保 `sync.start()` 后队列增长仍能触发 push。
