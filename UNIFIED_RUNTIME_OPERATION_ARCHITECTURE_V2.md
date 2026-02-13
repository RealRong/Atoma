# Atoma 统一运行时执行架构 V2 方案（详细版）

> 文档状态：提案  
> 适用范围：`atoma-client` / `atoma-runtime` / backend plugins（http/indexeddb/memory）/ `atoma-sync` / `atoma-types`  
> 目标：在不考虑重构成本的前提下，达到更解耦、更可扩展、更易理解的长期架构

---

## 0. 一句话结论

将当前「runtime 语义 + strategy + operation pipeline + sync」的混合执行模型，重构为四层清晰架构：

1. `Runtime Semantic Core`：只管 query/write 语义，不认识远端协议。  
2. `Execution Kernel`：只管执行策略与路由，不管业务语义。  
3. `Protocol Adapter Layer`：只管把通用执行请求映射到 HTTP/gRPC/IDB/Memory 协议。  
4. `Sync Orchestrator`：只管增量同步与冲突处理，通过公开回写端口和 runtime 交互。  

---

## 1. 现状问题复盘（基于代码链路）

## 1.1 当前真实链路

1. `createClient` 初始化 `Runtime`、`OperationPipeline`、`PluginContext`，随后安装 `direct` 策略。  
2. `direct` 的 query/write 默认走 `pipeline.executeOperations`。  
3. `pluginLifecycle` 自动注入 `localBackendPlugin` 作为末端兜底。  
4. `runtime.read/write` 最终通过 `runtime.strategy.query/write` 进入上述路径。  
5. `sync` driver 通过 `ctx.operation.executeOperations` 走同一操作总线。  

## 1.2 关键问题

1. 语义层绕路：默认 direct 不是纯本地执行，必须经过 operation pipeline。  
2. 隐式行为：`localBackendPlugin` 自动注入，系统行为不完全显式。  
3. 协议泄漏：runtime 写流程对 `WriteItemResult.entryId` 等 protocol 结构有硬耦合。  
4. 错误掩盖：策略缺失时存在静默 fallback（空数据或 confirmed）。  
5. sync 入侵：sync 通过注册 runtime strategy 影响主写入链路。  
6. 扩展不线性：新增 gRPC 需要穿透 batch/transport/operation 既有假设。  

---

## 2. 设计目标与硬约束

## 2.1 架构目标

1. runtime 仅依赖稳定执行端口，不依赖 `RemoteOp`/`RemoteOpResult`。  
2. execution 统一管理本地优先、远端优先、混合、重试、降级、熔断。  
3. transport/协议可插拔，HTTP 和 gRPC 同级接入。  
4. sync 与写主链路解耦，不通过覆盖 runtime strategy 注入行为。  
5. `createClient` 仅做 composition root，不携带业务策略细节。  

## 2.2 与仓库规则对齐

1. 不引入兼容别名与双路径长期共存。  
2. 不新增 root import `from 'atoma-types'`。  
3. 依赖方向保持单向，不让 runtime 反向依赖 plugin 实现细节。  
4. 公共抽象命名短且单义，避免历史兼容命名膨胀。  

---

## 3. 目标架构总览

## 3.1 四层模型

1. `Runtime Semantic Core`（语义内核）  
职责：query/write 语义、transform、writeback、store state、hooks。  
边界：只依赖 `QueryExecutionPort`、`WriteExecutionPort`、`RuntimeApplyPort`。

2. `Execution Kernel`（执行内核）  
职责：路由、策略图、重试、超时、并行、fallback、执行可观测。  
边界：输入通用请求，输出通用结果，不包含业务语义。

3. `Protocol Adapter Layer`（协议适配层）  
职责：将通用请求映射到 HTTP/gRPC/IDB/Memory，做 envelope/transport 编解码。  
边界：只依赖 execution port 与 protocol-tools，不触碰 runtime 内部状态。

4. `Sync Orchestrator`（同步编排层）  
职责：outbox/pull/push/subscribe/rebase/conflict 处理。  
边界：订阅执行事件，调用 `RuntimeApplyPort` 回写，不覆盖 runtime strategy。

## 3.2 逻辑关系

1. runtime 发起 query/write。  
2. execution kernel 根据策略图选择执行节点。  
3. 协议适配器实际执行并返回标准结果。  
4. runtime 根据标准结果完成 writeback。  
5. sync 仅作为旁路编排，不侵入 runtime 主语义入口。  

---

## 4. 核心抽象（V2 契约）

## 4.1 运行时只依赖三类端口

```ts
export interface QueryExecutionPort {
    execute(input: QueryExecutionInput): Promise<QueryExecutionOutput>
}

export interface WriteExecutionPort {
    execute(input: WriteExecutionInput): Promise<WriteExecutionOutput>
}

export interface RuntimeApplyPort {
    applyWriteback(input: RuntimeWritebackInput): void
}
```

## 4.2 通用执行输入输出（非 protocol 绑定）

```ts
export interface QueryExecutionInput {
    storeName: StoreName
    query: Query
    context: OperationContext
    signal?: AbortSignal
}

export interface QueryExecutionOutput {
    items: readonly unknown[]
    meta?: {
        source: 'local' | 'remote' | 'mixed'
        traceId?: string
        cursor?: string
    }
}

export interface WriteExecutionInput {
    storeName: StoreName
    entries: readonly RuntimeWriteEntry[]
    policy: RuntimeWritePolicy
    context: OperationContext
    signal?: AbortSignal
}

export interface WriteExecutionOutput {
    status: 'confirmed' | 'partial' | 'rejected'
    items: readonly RuntimeWriteItemResult[]
    meta?: {
        source: 'local' | 'remote' | 'mixed'
        traceId?: string
    }
}
```

## 4.3 协议映射放到 adapter

```ts
export interface ProtocolOperationAdapter {
    toRemoteOps(input: WriteExecutionInput | QueryExecutionInput): RemoteOp[]
    fromRemoteResults(results: RemoteOpResult[]): WriteExecutionOutput | QueryExecutionOutput
}
```

说明：`RemoteOp`/`RemoteOpResult` 只存在于 adapter 层，runtime 不再直接引用。

---

## 5. 执行内核（Execution Kernel）设计

## 5.1 执行图（Execution Graph）

执行图由显式节点组成，不再使用隐式 fallback：

1. `LocalQueryNode`：基于 `runtime.engine.query.evaluate` 或本地索引执行。  
2. `LocalWriteNode`：本地写入模拟或事务写。  
3. `RemoteHttpNode`：HTTP adapter。  
4. `RemoteGrpcNode`：gRPC adapter。  
5. `OutboxNode`：写入镜像到 outbox。  
6. `MergeNode`：聚合多节点结果并输出统一格式。  

## 5.2 策略图（Policy Graph）

策略图定义为可组合链，而不是 `strategy.register` 覆盖：

1. `direct-local`：`LocalQueryNode` / `LocalWriteNode`。  
2. `direct-http`：`RemoteHttpNode`。  
3. `local-first`：先本地，再异步远端确认。  
4. `remote-first`：先远端，失败才本地兜底。  
5. `sync-queue`：本地提交 + OutboxNode 入队 + 异步 push。  

## 5.3 明确失败语义

1. 无执行节点时启动失败（fail-fast），禁止 silent empty/confirmed。  
2. partial 成功必须显式返回 `status: 'partial'` 与失败条目。  
3. fallback 必须可观测，输出 `meta.source` 与策略节点轨迹。  

---

## 6. Runtime 语义层重构点

## 6.1 ReadFlow

1. `ReadFlow.query` 调用 `QueryExecutionPort.execute`。  
2. `ReadFlow.getAll` 的清理策略改为可配置模式。  
3. 不再假设远端全量天然覆盖本地。  

建议新增：

```ts
type GetAllMergePolicy = 'replace' | 'upsert-only' | 'preserve-missing'
```

## 6.2 WriteFlow 与 WriteCommitFlow

1. `WriteCommitFlow` 基于 `RuntimeWriteItemResult` 处理，不依赖 protocol entryId 细节。  
2. entry 相关映射由 execution adapter 负责。  
3. optimistic/rollback 仍保留在 runtime，但失败分类由 execution output 给出。  

## 6.3 StrategyRegistry 去角色化

1. `StrategyRegistry` 从“执行实现容器”降级为“策略名 -> execution graph id”索引。  
2. runtime 不再直接执行策略函数，只解析策略并委托 execution kernel。  

---

## 7. Plugin 平面重构点

## 7.1 新插件能力分层

将当前单一 `operations(register)` 拆成明确能力：

1. `execution(registerNode)`：注册执行节点。  
2. `policy(registerPolicy)`：注册策略图。  
3. `transport(registerTransport)`：注册协议驱动。  
4. `events(registerListener)`：注册生命周期事件。  

## 7.2 本地后端显式化

1. 删除自动注入 `localBackendPlugin`。  
2. 提供 `defaultLocalExecutionPlugin()` 供用户显式选择。  
3. `createClient` 未配置可用策略时直接抛启动错误。  

## 7.3 createClient 收口

`createClient` 只做三件事：

1. 初始化 runtime 与 execution kernel。  
2. 执行插件装配。  
3. 绑定默认策略名（若未显式提供则取 `direct-local`）。  

---

## 8. Protocol Adapter Layer 设计

## 8.1 HTTP Adapter

1. 复用现有 envelope 与 protocol-tools。  
2. `BatchEngine` 下沉为 HTTP adapter 内部细节。  
3. execution kernel 只看到标准输入输出。  

## 8.2 gRPC Adapter

1. 定义 `GrpcTransportDriver`：支持 unary 和 stream。  
2. 与 HTTP adapter 共享 `ProtocolOperationAdapter` 映射逻辑。  
3. 不复用 HTTP 专属的 JSON lane/batch 假设。  

## 8.3 IDB/Memory Adapter

1. `StorageOperationClient` 改造成 `LocalExecutionAdapter`。  
2. query/write 直接产出通用执行结果。  
3. 可选再包一层 protocol adapter 用于协议一致性测试。  

---

## 9. Sync Orchestrator V2

## 9.1 核心变化

1. 不再通过 `runtime.strategy.register('queue'|'local-first')` 注入写策略。  
2. 改为订阅 execution kernel 的 `onWriteDispatched` 事件镜像写入 outbox。  
3. push/pull/notify 继续保持 lanes 模型。  

## 9.2 写入链路

1. runtime 调用 execution kernel 写入。  
2. kernel 将可同步条目发给 sync orchestrator（事件方式）。  
3. orchestrator 入 outbox 并异步 push。  
4. ack/reject 通过 `RuntimeApplyPort.applyWriteback` 回写。  

## 9.3 冲突处理边界

1. runtime 只接受标准 writeback patch。  
2. 版本比较、rebase、冲突分类在 sync orchestrator 内完成。  
3. rebase 所需索引与存储优化由 sync 插件独立承担。  

---

## 10. 目录与模块目标布局

## 10.1 atoma-runtime

新增目录建议：

1. `packages/atoma-runtime/src/execution/kernel/ExecutionKernel.ts`  
2. `packages/atoma-runtime/src/execution/kernel/types.ts`  
3. `packages/atoma-runtime/src/execution/policy/policyGraph.ts`  
4. `packages/atoma-runtime/src/execution/events.ts`  

保留并改造：

1. `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`  
2. `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`  
3. `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts`  
4. `packages/atoma-runtime/src/runtime/registry/StrategyRegistry.ts`  

## 10.2 atoma-client

改造重点：

1. `packages/atoma-client/src/createClient.ts`：改为装配 execution kernel。  
2. `packages/atoma-client/src/client/installDirectStrategy.ts`：改为注册策略名，不直接走 pipeline。  
3. `packages/atoma-client/src/plugins/OperationPipeline.ts`：降级为 protocol adapter 内部机制或删除。  
4. `packages/atoma-client/src/plugins/pluginLifecycle.ts`：移除 local backend 自动注入逻辑。  

## 10.3 backend plugins

拆分建议：

1. HTTP：`transport + protocol-adapter + optional-batch`。  
2. IDB/Memory：`local-execution-adapter`。  
3. shared：保留通用写冲突规则与验证器。  

## 10.4 sync plugin

改造重点：

1. `packages/plugins/atoma-sync/src/persistence/SyncWrites.ts`：删除 strategy 注册逻辑。  
2. `packages/plugins/atoma-sync/src/engine/sync-engine.ts`：订阅 execution events。  
3. `packages/plugins/atoma-sync/src/applier/writeback-applier.ts`：保持 runtime apply 端口调用。  

---

## 11. 迁移计划（不考虑成本，直接收敛）

## Phase 1：引入新契约并并行接线

1. 在 `atoma-types/runtime` 新增 execution port 类型定义。  
2. 在 `atoma-runtime` 新增 `ExecutionKernel`，先以 adapter 包裹现有 `pipeline.executeOperations`。  
3. `ReadFlow/WriteFlow` 切到 execution port，runtime 不再直接碰 protocol 结构。  

验收：

1. runtime 编译单独通过。  
2. 无 strategy 时启动报错。  

## Phase 2：本地执行显式化

1. 移除 `pluginLifecycle` 自动 local backend 注入。  
2. 新增 `defaultLocalExecutionPlugin()` 并在模板配置中显式启用。  
3. 删除 `isTerminalResult` 作为默认流程控制的职责。  

验收：

1. 默认行为可被配置文件完全解释。  
2. 无隐式 fallback。  

## Phase 3：协议层下沉

1. `installDirectStrategy` 不再发送 `RemoteOp`，改为绑定 policy graph id。  
2. HTTP/IDB/Memory 分别输出标准执行结果。  
3. `WriteCommitFlow` 去除对 protocol `entryId` 的直接依赖。  

验收：

1. runtime 包内部无 `atoma-types/protocol` import（允许 adapter 层存在）。  
2. query/write 语义测试全绿。  

## Phase 4：sync 去侵入

1. `SyncWrites` 改为 execution 事件订阅。  
2. push/pull 不再依赖 runtime strategy 名称。  
3. rebase 与冲突留在 sync 插件内部闭环。  

验收：

1. 启用/禁用 sync 不改变 runtime 写主流程。  
2. outbox、ack/reject、pull replay 行为保持一致。  

## Phase 5：gRPC 接入

1. 新增 `grpcBackendPlugin`，仅实现 transport 与 adapter。  
2. 注册策略图节点 `remote-grpc`。  
3. 完成 HTTP 与 gRPC 的一致性契约测试。  

验收：

1. 新增 gRPC 不修改 runtime 主流程文件。  
2. 两种远端协议共享同一 execution 输出契约。  

---

## 12. 测试与验证标准

## 12.1 单元测试

1. `ReadFlow` 在不同 `GetAllMergePolicy` 下的行为。  
2. `WriteCommitFlow` 对 `confirmed/partial/rejected` 三态处理。  
3. `ExecutionKernel` 节点路由、fallback、重试、超时。  

## 12.2 集成测试

1. local-only：无 remote adapter 也能完整读写。  
2. http-only：远端读写一致，错误回传准确。  
3. sync-enabled：outbox push/pull/notify 完整闭环。  
4. grpc-enabled：与 http 行为等价。  

## 12.3 架构守护

1. lint rule：runtime 禁止 import `atoma-types/protocol`。  
2. lint rule：禁止 root import `atoma-types`。  
3. 启动期拓扑检查：至少一个 query 节点和一个 write 节点。  

---

## 13. 与现文档方案的差异与优势

1. 现文档强调“execution plane”，本方案补齐了“可执行契约 + 策略图 + adapter 边界”。  
2. 现文档提出“direct 纯本地”，本方案落实为显式节点与显式策略，不靠默认兜底。  
3. 现文档未彻底解决 runtime-protocol 耦合，本方案要求 runtime 完全协议无感。  
4. 现文档未彻底解决 sync 入侵，本方案将 sync 改为事件驱动旁路编排。  
5. 本方案可保证新增 transport 的改动局限于 adapter，不污染 runtime 主干。  

---

## 14. 最终建议

采用本 V2 方案，直接以“runtime 协议无感 + execution 图驱动 + sync 旁路化”为目标收敛。  
如果需要分阶段落地，优先顺序应是：

1. 先切 runtime 到 execution port。  
2. 再移除 local backend 自动注入。  
3. 再做 sync 去 strategy 化。  
4. 最后接入 gRPC 并做跨协议一致性验证。  

