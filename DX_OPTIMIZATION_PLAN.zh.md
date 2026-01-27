# DX 优化方案（代码优先，不处理文档问题）

> 目标：提升 Atoma 在“客户端 API / devtools / server 宿主集成 / 类型系统”上的开发体验（DX），并给出可分阶段落地的代码改造清单。  
> 明确：本文件**不讨论也不修复** README/示例/指南的任何不一致，因为代码在快速迭代；所有建议以“代码自身更自解释、更稳健、更少踩坑”为准。

---

## 0. 术语与现状基线

### 0.1 AtomaClient（对外 API 形状）

当前对外导出（简化）：

- `client.stores.<name>` / `client.stores(name)`：store CRUD（store 无状态 facade；写入策略由每次 options 决定）。
- `client.sync.*`：同步引擎控制（start/stop/pull/push/status）。
- `options.writeStrategy: 'queue' | 'local-first'`：队列写入/离线优先语义（不再通过派生入口暴露）。
- `client.History.*`：undo/redo/clear/canUndo/canRedo（按 scope 分区）。

DX 的核心约束：

- `Entities`/`Schema` 提供强类型：`name` 的补全来自 `keyof Entities & string`，relations 由 schema 推导。
- direct vs queued/local-first 属于“写入策略面”；应尽量通过统一的 `options.writeStrategy` 表达，避免额外入口造成误解。

### 0.2 Devtools Inspector（库内）与 overlay（独立包）

Inspector（`atoma-devtools`）的设计偏好：

- **client first + snapshot first**：事件用于触发刷新，数据以 snapshot 为准。
- registry 维护多个 client entry，并可 `global().clients.list/get/snapshot`。

overlay（`atoma-devtools`）的设计偏好：

- Shadow DOM 隔离样式；挂载即启用 `devtools.enableGlobal()`，并提供 React UI。

### 0.3 Server（协议内核）

当前 server 的定位：

- 只吃 Web 标准 `Request/Response`。
- 暴露两个 handler：`ops(request)` / `subscribe(request)`。
- 鉴权/策略/宿主路由适配由宿主承担（server 只提供 hook/plugin 扩展点）。

---

## 1. DX 优化目标（按重要性）

### G1：减少“顺序依赖 / 隐式前置条件”

典型：devtools 必须先 enableGlobal，再 createClient 才能自动注册。该类问题会导致“看起来坏了”，而且排查成本高。

### G2：让 API 名称表达语义，避免误用

典型：queued writes/outbox 其实是“写入策略面”，如果挂在 `Sync` 里会与“同步状态/同步控制”混在一起。

### G3：让类型系统提前报错，而不是运行时报错

典型：server config 的必需项与 feature flag（如 `sync.enabled`）之间的依赖目前主要靠运行时 `throw`。

### G4：让调试/观测更系统化（可选择，不强耦合）

典型：devtools/observability/debugEvent 都需要明确边界：默认不污染生产、可开关、可插拔、可收集。

---

## 2. 现存 DX 痛点清单（代码层）

### 2.1 Devtools：client 注册存在“时间窗口”

现状（行为层面）：

- `createClient()` 时会尝试通过全局 hook 注册，但仅在 hook 已安装时生效（目前代码里仍残留 `*VNEXT*` 命名）。
- 若先创建 client、后启用 devtools（enableGlobal/mount），早期 client 不会自动补注册。
- `devtools.inspect(client)` 可以创建 entry，但如果拿不到 runtime/providers，stores/indexes/history/sync 的信息会不完整（或为空），导致“inspect 了但啥也没有”。

根因：

- registry 与 client/runtime 的桥接是“单向 + 仅创建时触发”，缺乏“可重放/可补注册”的机制。

### 2.2 AtomaClient：History 的类型约束与实现语义不一致

现状：

- 实现层已经在多个入口使用 `String(scope || 'default')` 的容错语义。
- 但类型层强制 `scope: string`，导致调用点多写样板，且新手会默认把 scope 当成必填强概念。

结果：

- “严格但无收益”的类型噪音。

### 2.3 AtomaClient：Sync 命名承载多种语义

现状：

- `client.sync.start/stop/pull/push/status` 是引擎控制面。
- `options.writeStrategy: 'queue' | 'local-first'` 是写入策略面（队列写/离线优先），且对能力有约束（例如 enqueue 阶段的“是否允许隐式补读”）。

结果：

- 新手容易将 `Sync.*` 误解为“业务读写入口”，或认为“要用 Sync 才能正确工作”；因此“写入策略面”应保持为写入 options，而不是另起一个 API 入口。
- 熟手也需要在每个项目里重复“direct vs queue/local-first”的解释与封装。

### 2.4 createClient：配置字段映射存在“别名/翻译层”

现状：

- 高层输入字段（如 `pullIntervalMs`）会映射到底层字段（如 `periodicPullIntervalMs`）。
- 同类字段在不同层可能出现不同命名（interval vs periodicPullInterval；queue vs queueWriteMode）。

结果：

- 类型提示虽然存在，但“脑内翻译”成本偏高；也容易在排查时找不到对应字段。

### 2.5 Server：Config 的类型未形成“可判别的能力矩阵”

现状：

- `sync.enabled` 与 `adapter.sync`、`adapter.orm.transaction` 的依赖关系主要靠运行时校验。

结果：

- 编译期无法提前发现“启用了 sync 但没配 sync adapter / transaction”。
- 宿主集成时，错误往往在运行到某条路径才出现。

---

## 3. 方案总览（分阶段落地）

本节给出按影响面与收益排序的落地路线。所有阶段都遵循：

- 以“可维护性/一致性优先”，必要时允许 breaking 一步到位（当前阶段假设尚无外部用户包袱）。
- devtools/observability 相关改造默认只影响开发环境（或显式 enable 时才生效）。

### Phase 0（最高优先级）：清理旧迁移后缀命名残留（已完成）

目标：

- 迁移已完成的前提下，彻底消灭代码库里“旧迁移后缀”相关命名残留，避免：
  - 新同学以为存在“旧版 vs 新版”的两套系统；
  - 误把旧后缀当成 feature flag/实验性开关；
  - 未来重构时出现“同一概念多命名”的持续熵增。

范围（只改代码命名，不改行为）：

- 常量/全局 hook key、内部 symbol key、类型名、注释、错误信息、事件 type、包内 export 等所有出现旧迁移后缀的地方。
- 明确：**不允许任何兼容层/别名/双读双写**；必须一次性全量替换并移除旧命名。

统一命名（已落地，2026-01-08）：

- 全局 hook key：统一为 `__ATOMA_DEVTOOLS__`
- “Inspector”命名：统一称为 `Inspector`（overlay/UI 继续叫 `Atoma DevTools`）

验收标准（已满足）：

- 全仓不再出现旧迁移后缀字样（零命中）。

### Phase 1（高优先级）：消灭 devtools “时间窗口”

目标：

- 无论 `enableGlobal()` 在 `createClient()` 之前还是之后，devtools 都能完整看到 client + runtime/providers。

候选实现（推荐顺序从稳到激进）：

#### 3.1-A 推荐：给 client 绑定“可选的 runtime/provider 私有通道”，让 `devtools.inspect(client)` 能补齐 attach

做法：

- 在 client 对象上挂载一个 symbol 属性（例如 `Symbol.for('atoma.devtools')`），仅在内部创建时设置：
  - `runtime`
  - `syncDevtools`
  - `historyDevtools`
  - `meta`
- `devtools.inspect(client)` 检测该 symbol，若存在则自动 `attachRuntime/attachSyncProvider/attachHistoryProvider`。

优点：

- 不需要全局列表，不需要拦截所有 client 创建，也没有“内存泄漏”的强风险（symbol 属性跟随对象生命周期）。
- 支持“先 createClient，后 inspect”得到完整信息。

注意：

- 需要保证 symbol key 稳定，且不出现在 public typings（或以 `internal` 命名+非导出类型存在）。
- 需要明确：这是 devtools 用的“非官方字段”，用户不应该依赖。

#### 3.1-B 可选：在 enableGlobal 时安装 hook 的同时，补齐“已存在 client 的发现机制”

做法：

- 维护一个 WeakSet/WeakMap 追踪已创建的 client（仅用于 devtools），`enableGlobal()` 时把它们批量注册。

问题：

- WeakSet 无法枚举，无法在 enableGlobal 时“列出所有已存在对象”；因此必须同时有一个可枚举的强引用容器（会引入泄漏风险）或依赖宿主提供列表（DX 不友好）。

结论：

- 除非能接受强引用容器（且仅 dev 环境），否则不推荐作为主方案。

验收标准：

- 顺序 A：`enableGlobal()` -> `createClient()`：能看到完整 client snapshot。
- 顺序 B：`createClient()` -> `enableGlobal()` -> `devtools.inspect(client)`：能看到完整 client snapshot。
- 顺序 C：`createClient()` -> `mountAtomaDevTools()`（内部 enableGlobal）：在 UI 里可通过“手动添加 client（inspect）”完整显示。

### Phase 2（高优先级）：改善 API 语义表达，减少误用

#### 3.2-A 将 “queued writes store” 一步到位改名为语义化入口（breaking）

（已采用）把“队列写/离线优先”收敛为写入 options，而不是另起一个入口：

- 删除 `sync` 下的 store 双入口（不做 alias）。
- 不提供 `Outbox` 这类派生入口。
- queued/local-first 统一使用 `options.writeStrategy: 'queue' | 'local-first'`。
- `sync` 只保留引擎控制面（start/stop/pull/push/status）。

#### 3.2-B History：让 scope 在类型层变为可选，并显式定义默认值

做法：

- 把 `History.canUndo/canRedo/clear` 的入参从 `(scope: string)` 改为 `(scope?: string)`。
- 把 `undo/redo` 的参数从 `{ scope: string }` 改为 `{ scope?: string }`。
- 在 typings 中写清楚默认 scope 的常量名（例如 `DEFAULT_HISTORY_SCOPE = 'default'`，是否导出视需要）。

好处：

- 调用更贴近实际语义，也更符合“先上手再深入”的路径。

### Phase 3（中优先级）：降低配置“翻译层”认知成本

#### 3.3-A 收敛同类字段命名，提供单一权威字段

做法：

- 为 interval/periodicPullInterval 之类字段确定一套唯一命名。
- 旧字段直接移除；如需迁移成本更低，可提供一次性的 codemod/批量替换建议（但代码层不保留兼容路径）。

验收标准：

- IDE 补全时优先出现“权威字段”。
- 旧字段不可用（编译期/类型层直接报错），且内部不保留兼容读取路径。

#### 3.3-B 提供“配置诊断快照”

做法：

- 在 `createClient` 返回的 client 上提供一个轻量的只读 `client.Config.snapshot()`（或 devtools snapshot 里增强）：
  - 展示最终生效的 sync mode、queueWriteMode、derived sync target 等关键派生值。

目标：

- 让用户无需翻代码就能知道“你最后到底启用了什么”。

### Phase 4（中优先级）：Server config 类型化能力矩阵（让 TS 提前报错）

#### 3.4-A 使用判别联合（discriminated union）表达 sync 能力依赖

做法：

- 将 `AtomaServerConfig` 拆成两种：
  - `SyncDisabledConfig`：`sync.enabled === false`（或默认禁用形态），允许 `adapter.sync` 省略，`adapter.orm.transaction` 不强制。
  - `SyncEnabledConfig`：`sync.enabled !== false`，强制要求 `adapter.sync` 与 `adapter.orm.transaction` 存在。

注意：

- 当前语义是 `sync.enabled ?? true`（默认启用）。类型设计需要与默认行为一致，避免 TS 误导用户。
- 可考虑将默认改为“显式 enable 才启用”（breaking），或保持默认启用但要求类型上写清楚“你没写 sync.enabled 也算 enabled”。

#### 3.4-B 为宿主提供可选的 `assertConfig()` 开发期校验

做法：

- 在 server 包导出一个 `assertServerConfig(config)`，把运行时 throw 的信息聚合得更友好。

目标：

- 更早、更集中地暴露配置问题；并且在测试中可单测这一层。

---

## 4. 破坏性与兼容性策略

### 4.1 当前阶段策略：一步到位（无兼容层）

由于当前阶段假设“还没有用户”，本方案默认允许 breaking，并且**不引入兼容层**（避免两套命名/两套入口并存造成持续熵增）。

### 4.2 Breaking 改动的触发条件

以下情况才考虑 breaking（若未来出现外部用户包袱，可回到保守策略）：

- 现有命名导致大量真实误用（线上事故/一致性 bug）。
- 兼容层带来持续复杂度，且难以维护或造成性能/体积问题。

---

## 5. Devtools 事件/快照模型的增强建议（可选）

### 5.1 统一事件类型（降低 UI/集成成本）

现状：devtools 事件是 `{ type: string; payload?: any }`，自由度高但 UI/外部集成需要自行约定。

建议：

- 引入受控的 event type union（例如 `store:registered`、`index:registered`、`sync:event`、`sync:error`、`sync:queue`）。
- 仍允许扩展（string fallback），但库内事件先标准化，提升 UI 可靠性。

### 5.2 快照可配置采样（避免敏感数据/性能损耗）

现状：store snapshot 取 `Map` 前 5 条作为 sample，并估算 size。

建议：

- 允许在 devtools enable 时设置采样策略：
  - `sampleSize`
  - `redact(sample)`（对实体字段脱敏）
  - `includeSamples: boolean`

目标：

- 在真实业务数据环境下也敢开（至少在开发/预发）。

---

## 6. 落地执行清单（可直接拆任务）

### 6.0 Phase 0（清理旧迁移后缀命名残留）任务拆分（已完成）

- 全仓扫描：搜索旧迁移后缀的所有命中并分类（常量 key / 注释 / 类型名 / 事件名 / 字符串）。
- 统一改名：替换为统一命名，保证对外导出与内部引用一致。
- 严格删除：移除所有旧命名引用，不保留 alias，不做双读双写，确保一次性清零。
- 防回归：可选增加轻量检查确保旧后缀不再出现（团队决定是否需要）。

### 6.1 Phase 1（devtools 时间窗口）任务拆分

- 在 client 创建时，把 `runtime/syncDevtools/historyDevtools/meta` 写入 client 的内部 symbol 字段。
- `devtools.inspect(client)`：若发现 symbol 字段，补齐 attach（runtime/providers/meta）。
- 增加最小单测（若当前仓库已形成 devtools 测试模式）：验证 inspect 后 snapshot 包含 stores/indexes/sync/history 的结构。

### 6.2 Phase 2（API 语义）任务拆分

- `AtomaClient` 对外只保留 `client.stores`（不引入 `Outbox/Queue` 额外命名空间）；队列/离线优先通过 `options.writeStrategy` 表达。
- `History` API 类型把 scope 变为可选，与默认 scope 行为对齐。

### 6.3 Phase 4（server 类型能力矩阵）任务拆分

- 重构 `AtomaServerConfig` 为判别联合。
- 保留运行时校验（防止 any/JS 用户绕过 TS），但把信息更结构化。

---

## 7. 风险与回滚（代码层）

### 7.1 风险

- 给 client 挂 symbol 字段会改变对象 shape：极低概率影响某些用户的序列化/拷贝逻辑（通常 client 不应被序列化）。
- server config 判别联合可能导致 TS 推导变严格：需要评估对现有用户的影响，并提供迁移路径。

### 7.2 回滚策略

- Phase 1/2 改动仍然可以“功能开关式”落地（例如 devtools 只在显式 enable 时生效），但不引入对外兼容层/双入口。
- Phase 4 若引发类型破坏，可先以 `assertServerConfig` 方式提供“可选强校验”，再逐步迁移到判别联合。

---

## 8. 验收标准（建议）

最小验收（必须）：

- Phase 0：全仓不再出现旧迁移后缀命名（零命中）。
- devtools：`createClient` 与 `enableGlobal/mount` 的调用顺序不再影响“能否完整 inspect”（至少通过 `devtools.inspect(client)` 可补齐）。
- API：History 默认 scope 的调用不再需要样板代码（类型与实现对齐）。

增强验收（可选）：

- 使用 `options.writeStrategy: 'queue' | 'local-first'` 后，新手无需记多个入口即可理解 direct vs queued 的差异。
- server config 在 TS 下能提前发现 “sync enabled 但缺 adapter/transaction”。
