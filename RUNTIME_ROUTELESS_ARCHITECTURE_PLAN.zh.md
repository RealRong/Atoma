# Atoma Runtime 无 Route 化架构方案

## 1. 决策结论

### 1.1 是否保留 route

结论：**不在 runtime 公共语义中保留 route**。

原因：

1. `route` 属于后端接入策略，不是本地状态机核心语义。
2. 将 `route` 暴露在 `StoreOperationOptions` 会把网络拓扑决策泄漏到业务写读调用。
3. runtime 的目标应是“纯内存状态框架 + 可插拔执行后端”，而不是“请求路由器”。

### 1.2 是否有多后端需求

结论：**有，但不是默认主路径**。

1. 常见场景是“单后端 + 本地缓存/同步”。
2. 多后端属于高级场景（灰度、读写分离、多租户、多区域），应由插件层处理。
3. 默认 API 不应要求每次读写都携带后端路由参数。

### 1.3 对齐开源库实践

主流库大多采用：**核心单入口 + 扩展层支持多后端**，而非 operation 级 route。

1. RTK Query：通常按 baseURL/服务域拆 API slice。
2. TanStack Query：强调稳定 `QueryClient`，以 client 作为环境边界。
3. SWR：默认全局 fetcher 配置，可局部覆盖，但不鼓励在每次调用传路由。
4. Relay：通过 `Environment` 作为执行边界。
5. Apollo：可通过 Link 组合/分流实现多后端，但在网络层完成。
6. RxDB：本地优先，复制同步为独立层，后端可替换。

结论映射到 Atoma：runtime 应保持单一内核语义；后端差异放入 plugin。

## 2. 目标架构

### 2.1 分层边界

1. `atoma-runtime`：纯内存状态引擎，负责 read/write/change 编排与本地一致性收敛。
2. `atoma-client`：负责装配 runtime 与 plugins，不提供 route 级调度 API。
3. `packages/plugins/*`：负责后端接入（memory/http/indexeddb/atoma-server），可选实现多后端选择器。

### 2.2 单一版本模型

1. 仅保留 `version:number` 一套模型。
2. runtime 只做本地 version 推进与 writeback 合并，不做协议级 CAS 策略判断。
3. `baseVersion/expectedVersion` 注入与校验放在后端适配层（例如 `atoma-backend-shared`）。

## 3. 一步到位改造范围

## 3.1 类型层（删除 route 公共语义）

目标：移除 `ExecutionRoute/defaultRoute/StoreOperationOptions.route` 等对外字段。

主要文件：

1. `packages/atoma-types/src/core/store.ts`
2. `packages/atoma-types/src/runtime/persistence.ts`
3. `packages/atoma-types/src/runtime/execution.ts`
4. `packages/atoma-types/src/runtime/store/events.ts`
5. `packages/atoma-types/src/runtime/store/handle.ts`
6. `packages/atoma-types/src/client/options.ts`
7. 所有引用 `ExecutionRoute` 的导出入口

结果：

1. `ExecutionOptions` 仅保留 `signal`。
2. store/read/write/change 事件 payload 去掉 `route` 字段。
3. `createClient` 去掉 `defaultRoute` 选项。

## 3.2 Runtime 执行层（从路由器改为单后端挂载）

主要文件：

1. `packages/atoma-runtime/src/execution/ExecutionKernel.ts`
2. `packages/atoma-runtime/src/execution/bundle.ts`
3. `packages/atoma-runtime/src/execution/resolver.ts`
4. `packages/atoma-runtime/src/execution/kernelTypes.ts`

改造原则：

1. `execution.apply` 从 `routes + executors` 改为单执行器注册语义。
2. 允许“未注册执行器”状态存在（纯内存模式）。
3. 运行时如无执行器，读写流走本地路径；如有执行器，走远端执行路径。
4. 若重复注册后端执行器，直接报冲突（一步到位，不做兼容并存）。

## 3.3 读写流程（无后端时本地闭环）

主要文件：

1. `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
2. `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
3. `packages/atoma-runtime/src/runtime/flows/ChangeFlow.ts`
4. `packages/atoma-runtime/src/runtime/flows/write/commit/commitWrites.ts`
5. `packages/atoma-runtime/src/runtime/flows/write/commit/commitRemoteWrite.ts`
6. `packages/atoma-runtime/src/runtime/flows/write/types.ts`
7. `packages/atoma-runtime/src/runtime/flows/write/utils/prepareWriteInput.ts`

目标行为：

1. 无后端执行器时：
   - query 使用 `runtime.engine.query.evaluate({ state, query })`
   - write 直接本地提交并产生标准 `WriteManyResult`
2. 有后端执行器时：
   - 复用现有 remote commit + reconcile 管线
3. 缓存缺失且无后端时：
   - `update/delete` 直接失败（不允许隐式远端补读）

## 3.4 Client 装配层（删除内置 local route）

主要文件：

1. `packages/atoma-client/src/index.ts`
2. `packages/atoma-client/src/execution/registerLocalRoute.ts`（删除）
3. `packages/atoma-client/src/plugins/PluginContext.ts`

目标：

1. `createClient({ schema })` 默认即纯内存模式，无需 local route 注入。
2. 插件只做“注册执行器/服务”，不做 route 配置。

## 3.5 后端插件层（去 route，保留执行器）

主要文件：

1. `packages/plugins/atoma-backend-memory/src/plugin.ts`
2. `packages/plugins/atoma-backend-http/src/plugin.ts`
3. `packages/plugins/atoma-backend-indexeddb/src/plugin.ts`
4. `packages/plugins/atoma-backend-atoma-server/src/plugin.ts`
5. 对应 `types.ts` 的 route 字段与 route 常量

目标：

1. 插件 setup 时向 runtime 注册执行器。
2. 同时注册多个后端插件时，按冲突策略报错（或后续引入“多路复用插件”统一管理）。
3. version 语义继续下沉到 `atoma-backend-shared` 的写入映射逻辑。

## 3.6 Sync 层（去 route 过滤）

主要文件：

1. `packages/plugins/atoma-sync/src/persistence/SyncWrites.ts`
2. `packages/plugins/atoma-sync/src/types.ts`
3. `packages/plugins/atoma-sync/src/plugin.ts`
4. `packages/atoma-types/src/sync/events.ts`

目标：

1. 去掉 `enqueueRoutes`。
2. 改为根据写事件结果与 store/resource 维度入队。
3. 同步失败事件不再绑定 route 字段。

## 4. 多后端需求如何承接（不回流 route）

推荐两种方式：

1. 多 client 实例（推荐默认）
   - 每个 client 绑定一个后端插件组合。
   - 边界清晰，易排错，适合绝大多数应用。
2. 多路复用插件（高级）
   - 在插件内部按 `storeName/resource/context` 决定落地后端。
   - 选择逻辑封装在插件，不污染 runtime/store API。

禁止方式：

1. 把 `route` 放回 `StoreOperationOptions` 让业务层每次写入手工选择后端。

## 5. 迁移步骤（建议执行顺序）

1. 类型收口：先删 `ExecutionRoute/route/defaultRoute` 公共字段。
2. 执行内核改造：把 execution kernel 改为“可空单执行器”模式。
3. runtime 读写本地闭环：实现“无执行器可正常 CRUD/query”。
4. client 去默认 local route：删除 `registerLocalRoute` 链路。
5. 后端插件迁移：memory/http/indexeddb/atoma-server 去 route API。
6. sync 去 route：改事件与过滤逻辑。
7. 文档与示例更新：README/README.zh.md 统一为“纯内存默认 + 插件扩展后端”。

## 6. 验收标准

1. `createClient({ schema })` 无插件即可完成 CRUD/query。
2. 全仓类型中不再存在 runtime 对外 route 语义。
3. 安装任一后端插件可透明启用远端执行。
4. 版本模型仍只有 `version` 一套。
5. `pnpm typecheck`、关键包 build 与测试通过。

## 7. 风险与控制

1. 风险：大量类型签名变更导致插件/外部调用方 break。
   - 控制：一次性改完并同步升级文档，不保留兼容别名。
2. 风险：无后端模式下 `update/delete` 的补读行为变化。
   - 控制：明确错误语义并补充回归测试。
3. 风险：sync 过去依赖 route 过滤策略。
   - 控制：改为 store/resource 过滤并补充事件断言测试。

## 8. 最终建议

1. 按“runtime 无 route + plugin 承载后端策略”直接收敛，不走双轨兼容。
2. 默认以单后端心智模型服务绝大多数用户。
3. 多后端能力仅在插件层提供高级扩展，不进入 runtime API 面。
