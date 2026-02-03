# Atoma 当前架构与进一步解耦方案

本文总结当前 atoma-runtime / atoma-client / plugin 体系的架构现状，并给出可进一步解耦、便于扩展维护的优化空间与落地方向。

> 目标：减少耦合、清晰职责边界、降低新手理解成本、提升扩展性与可维护性。

## 1. 当前架构概览

### 1.1 atoma-runtime（CoreRuntime 为中心）
- **CoreRuntime**：唯一运行时上下文，统一挂载：`read/write/io/persistence/observe/transform/stores`。
- **StrategyRegistry**：负责写策略注册与路由，`executeWriteOps` 直接走 `io.executeOps`。
- **Store handle & StateWriter**：runtime 内部持有 handle/状态写入接口，并连接到 store 读写流程。
- **Transform/DataProcessor**：位于 runtime 上，为写入前/后数据转换提供入口。

### 1.2 atoma-client（createClient 统一入口）
- **插件生命周期**：两阶段
  - `register(ctx, register)`：注册 handler（io/persist/read/observe）。
  - `init(ctx)`：返回 `extension` 和 `dispose`。
- **HandlerChain**：按优先级组合 handler，驱动 runtime 的 `io/persist/read/observe`。
- **EndpointRegistry**：管理 driver 端点（仅 `ops` 角色）。
- **devtools 注入**：通过 capabilities registry 注入 registry/meta。

### 1.3 atoma-sync（合并式插件）
- **syncPlugin**：直接作为 client 插件使用。
- **driver/transport**：默认 ops driver（`executeOps`）构建 sync transport。
- **策略接管**：注册 `queue/local-first` 等持久化策略到 runtime。
- **devtools**：通过 registry 注入 sync 状态。

### 1.4 devtools
- 依赖 capabilities registry（`devtools.registry`/`devtools.meta`），插件 init 时注册 provider。

## 2. 现有架构的优势
- **单一 runtime 上下文**，便于统一调用链和状态管理。
- **插件驱动 I/O 与持久化**，扩展和替换成本低。
- **同步能力插件化**，支持按需启用。
- **清晰的 handler chain**，可扩展新的读写策略或拦截逻辑。

## 3. 进一步解耦空间（重点）

### 3.1 Endpoint/Driver 扩展能力下沉到插件层
**现状问题**：
- endpoint driver 只有 `executeOps`，sync 通过 `driver.sync` 这类扩展字段绕开类型系统。
- 如果把能力模型放到 core/client，会迫使核心包理解所有插件能力（sync/stream/…），导致耦合爆炸。

**建议方向**：
- **core/runtime/client 只定义 ops 能力**（`executeOps` + ops 协议），保持最小接口。
- **client 仅提供通用扩展位**（如 plugin registry / capabilities registry / extension map），不定义任何具体 capability 类型。
- **插件自行维护能力与类型**：\n  - 插件包内定义 `SyncDriver`、`StreamDriver` 等类型\n  - 插件自行注册/读取能力（如 `capabilities.register('sync.driver', driver)`）\n  - 插件对外提供类型安全 accessor（如 `getSyncDriver(ctx)`）

**收益**：
- core/client 不被插件生态绑架，依赖关系清晰稳定。
- 新能力完全插件化，扩展无需改核心包。
- 类型安全由插件自主管理，避免“万能 driver”污染。

**落地结果**：
- sync 不再注册 `EndpointRegistry` 的 `sync` endpoint，仅通过插件内的 driver/transport 运行。\n- `EndpointRegistry` 回归为 ops 端点的最小能力集合，扩展能力不进入 core/client 类型。

### 3.2 runtime 进一步变薄：从“逻辑中心”变为“编排中心”
**现状问题**：
- runtime 仍持有 handle / state writer / data processor / transform 等偏“业务/数据层”能力。

**建议方向**：
- 将纯数据逻辑与 store 内部处理下沉到 core：
  - 索引、id 生成、写入合并、patch 应用等
- runtime 只保留“跨 store 的编排与策略路由”职责：
  - read/write 流程调度、策略分发、io 调用

**收益**：
- runtime 更易理解、更可替换。
- 便于独立测试数据逻辑（core）与流程编排（runtime）。

**落地结果**：
- `WriteEvent`、`buildOptimisticState`、写入 op 组装算法已下沉到 `atoma-core/store`。\n- runtime 只保留流程编排与 transform/outbound 调用，写入数据规则由 core 统一维护。

### 3.3 Persistence 策略体系进一步插件化
**现状问题**：
- StrategyRegistry 位于 runtime，策略实现仍与 client 侧紧耦合。

**建议方向**：
- runtime 保留 StrategyRegistry（仅做路由与策略解析）。
- 所有策略实现（direct/local-first/queue）均由 client 插件注册。

**收益**：
- runtime 变成真正“无策略假设”的引擎。
- server 或其它运行环境可注入不同策略，实现复用。

**落地结果**：
- runtime 不再隐式假设默认策略，新增 `setDefaultStrategy` 由插件/调用方显式指定。\n- client 初始化时设置 `direct` 为默认策略，sync 插件仅注册自身策略（`queue/local-first`）。

### 3.4 Observability 依赖倒置
**现状问题**：
- runtime 直接依赖 observability 具体类型。

**建议方向**：
- 抽出最小观测接口（trace/context），由 observe plugin 注入实现。
- runtime 对 observability 的依赖只保留接口形态。

**收益**：
- observability 更可替换（例如换实现或关闭）。

**落地结果**：
- `ObservabilityContext/DebugConfig/DebugEvent/Explain` 下沉到 `atoma-core` 类型层，runtime 不再依赖 `atoma-observability`。\n- runtime 默认使用 no-op observability；client 在创建 runtime 时注入 `StoreObservability` 作为默认实现。

### 3.5 Sync Transport 分层
**现状问题**：
- ops driver 并不支持 subscribe，订阅能力缺失。

**建议方向**：
- SyncDriver 拆分为能力组件：`pull/push/subscribe`。
- 提供单独的 SSE/WebSocket driver，用于 subscribe。
- ops driver 仅实现 pull/push。

**收益**：
- sync 方案更清晰，网络层更可替换。

**落地结果**：
- `SyncTransport` 仅保留 `pull/push`；订阅能力拆为 `SyncSubscribeDriver` 并通过 `subscribeTransport` 注入。\n- sync 插件支持传入独立 subscribe driver，并通过 capabilities 注册 `sync.subscribe` 能力。

### 3.6 Devtools 协议标准化
**现状问题**：
- devtools 依赖 capabilities registry 的隐式 key，仍缺少统一协议约束。

**建议方向**：
- 统一 devtools 协议：
  - `DevtoolsRegistry`/`DevtoolsMeta` 的标准定义
  - `devtools.registry`/`devtools.meta` 常量集中到一个包
- runtime 只暴露最小 hook，不直接依赖具体实现。

**收益**：
- devtools 改造更可控，版本兼容更清晰。

**落地结果**：
- devtools 协议常量与注册类型集中到 `atoma-client/src/devtools/protocol.ts`，统一由 `DEVTOOLS_REGISTRY_KEY/DEVTOOLS_META_KEY` 管理。\n- `atoma-types` 统一 re-export devtools 协议常量，供外部直接消费。

### 3.7 Types 出口统一化（新增 atoma-types）
**现状问题**：
- 跨包类型分散在 core/runtime/client/protocol/observability 各处，外部使用方容易产生深路径依赖。

**建议方向**：
- 新增 workspace 包 **`atoma-types`**，作为**跨包类型唯一入口**。\n- 其它包内部仍保留自身类型定义，但**对外只通过 `atoma-types` re-export**。\n- 约束：**禁止跨包 deep import**（如 `atoma-runtime/types/*`、`atoma-client/plugins/*`）。

**建议收敛到 atoma-types 的类型清单（跨包必需）**：
- **Core / Domain**：`Types.Entity`、`StoreToken`、`StoreConfig`、`StoreApi`、`Query`、`QueryResult`、`QueryMatcherOptions`、`FetchPolicy`、`PageInfo`、关系与索引相关类型（Relation schema / Indexes）、`DataProcessor` 相关类型、`WriteStrategy`、`PartialWithId`。\n- **Protocol**：`EntityId`、`Operation`、`OperationResult`、`Meta`、`StandardError`、`WriteAction`、`WriteItemResult`、`WriteResultData`。\n- **Runtime Surface**：`CoreRuntime`、`RuntimeIo`、`RuntimeRead`、`RuntimeWrite`、`RuntimeTransform`、`RuntimePersistence`、`RuntimeObservability`、`StoreRegistry`、`StoreHandle`、`StoreStateWriterApi`、`PersistRequest`、`PersistResult`、`PersistAck`、`PersistStatus`、`StrategyDescriptor`、`WritePolicy`、`TranslatedWriteOp`。\n- **Client / Plugin**：`ClientPlugin`、`PluginInitResult`、handler 类型（`IoHandler`/`PersistHandler`/`ReadHandler`/`ObserveHandler`）、上下文与注册类型（`IoContext`/`PersistContext`/`ReadContext`/`ObserveContext`/`Register`/`HandlerEntry`/`HandlerName`），以及对外需要的 `Endpoint`/`Driver` 类型（如果插件生态直接依赖）。\n- **Observability**：`ObservabilityContext`、`DebugConfig`、`DebugEvent`。

**收益**：
- 外部依赖只需 `atoma-types`，路径稳定、重构成本低。\n- 内部包之间解耦更清晰，避免类型循环依赖。

**落地结果**：
- 新增 `atoma-types` 包，统一对外导出跨包类型（core/runtime/protocol/observability/client）并提供 devtools 协议常量出口。\n- 外部使用方可仅依赖 `atoma-types` 进行类型引用，避免深路径导入。

### 3.8 Store handle 可替换性
**现状问题**：
- handle 与 state writer 强绑定，内聚度高。

**建议方向**：
- handle 只保留最小执行上下文；
- state writer 独立成可插拔模块，由 store 绑定。

**收益**：
- store 可独立演化，runtime 无需关心写入细节。

## 4. 推荐的解耦优先级（从高到低）
1) Endpoint/Driver 扩展能力下沉到插件层
2) Persistence 策略完全插件化
3) runtime 进一步变薄（数据逻辑下沉 core）
4) Sync transport 分层（subscribe 驱动独立）
5) Observability 依赖倒置
6) devtools 协议标准化
7) types 出口统一化
8) store handle/StateWriter 解耦

## 5. 最终形态示意（目标）
- runtime 只做编排和策略路由，不含具体数据处理实现。
- client 插件提供完整 I/O、策略、观测、sync、devtools 能力。
- core 负责数据结构/索引/写入合并等“纯逻辑”。
- 扩展能力只存在于插件层，核心仅保留 ops 能力与通用扩展位。

---

如需继续落地：建议按第 4 节优先级拆成阶段推进，每次只推进 1-2 类解耦，保证可验证与可回滚。
