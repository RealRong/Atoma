# Atoma 统一执行架构设计（供下一轮 AI 审查）

> 范围：`atoma-client` / `atoma-runtime` / backend plugins（http/indexeddb/memory）/ `atoma-sync`
> 
> 目标：把「query / write 业务语义」与「本地/远程/同步实现策略」解耦，支持未来 gRPC 等插件扩展，同时降低 createClient 与插件系统的认知复杂度。

---

## 1. 背景与核心判断

当前实现已经统一到 operation 中间件模型，但仍存在一个“别扭点”：

1. runtime 的 `ReadFlow/WriteFlow` 语义上只应关心 query/write 执行与状态变更。
2. 现实里默认 `direct` 会走 operation pipeline，再由 `LocalBackendPlugin` 做兜底。
3. 这导致 runtime 语义层间接依赖了“传输/协议路径”的存在，职责边界不够纯。

**核心判断**：

- runtime 不应关心“策略是本地、远程还是混合”；
- runtime 只依赖稳定执行端口（query/write）；
- 具体策略由 client/plugin 组合层负责装配。

这套边界对 `sync + indexeddb + http + 未来 grpc` 同时成立。

---

## 2. 为什么必须这么设计

## 2.1 多后端并存是常态，不是特例

- 本地离线：IndexedDB / Memory
- 在线直连：HTTP（未来 gRPC/WebSocket）
- 混合一致性：Sync（本地写入 + 远端回放 + 冲突处理）

如果 runtime 直接感知“后端类型”，每增加一种传输方式就会扩散修改到 runtime 主干。

## 2.2 Sync 场景天然需要“策略可替换 + 运行时无感”

Sync 既有 push/pull/subscribe，又有 outbox、writeback、冲突回写；
它应作为插件编排问题，而不是 runtime 语义问题。

## 2.3 扩展成本必须线性

未来新增 gRPC 插件时，理想路径是：

1. 实现一个 operation middleware（或 transport driver）
2. 在 createClient 的插件数组注册
3. 不改 runtime query/write 主流程

---

## 3. 当前全流程（按真实代码链路）

## 3.1 组装入口：createClient

`packages/atoma-client/src/createClient.ts`

1. 创建 `runtime`、`pipeline`、`operation`
2. 构建 `PluginContext`（含 `runtime/capabilities/operation/events`）
3. `setupPlugins` 注册 operation middleware 与 runtime hooks
4. `installDirectStrategy` 注册默认 `direct`
5. client API 暴露 `stores(name)` 与 `dispose`

## 3.2 读写主路径

- 读：`runtime.read.query` -> `runtime.strategy.query` ->（当前默认 direct）-> `pipeline.executeOperations`
- 写：`runtime.write.*` -> `runtime.strategy.write` ->（当前默认 direct）-> `pipeline.executeOperations`

## 3.3 operation pipeline 路径

`packages/atoma-client/src/plugins/OperationPipeline.ts`

- 插件按 `priority` 排序执行
- 高优先级 backend（http/indexeddb/memory）先尝试
- 终点结果为空时，`LocalBackendPlugin` 兜底

## 3.4 Sync 路径

- `syncOperationDriverPlugin` 通过 `ctx.operation.executeOperations` 作为 sync transport
- `syncPlugin` 维护 outbox / pull / push / subscribe
- `WritebackApplier` 通过 `ctx.runtime.stores.applyWriteback` 回写本地状态

---

## 4. 目标架构（统一模型）

## 4.1 三层职责平面

1. **Runtime Plane（语义平面）**
   - 只处理 query/write 语义、transform、writeback、store state
   - 不感知 http/indexeddb/grpc/sync

2. **Execution Plane（执行平面）**
   - 负责把 query/write 请求路由到具体执行器
   - 可以是本地执行、operation pipeline、或 sync-aware 执行

3. **Plugin Plane（扩展平面）**
   - 负责注册 middleware、事件监听、能力扩展
   - 后端与 sync 都在此平面装配

## 4.2 稳定边界原则

- runtime 对外只暴露稳定能力：`stores.query` / `stores.applyPatches` / `stores.applyWriteback`
- 插件可使用 runtime API，但**不可直接注册 runtime 中间件/hook 内核**
- 插件注册统一通过 `operations(...register)` 与 `events(...register)`

## 4.3 operation 的定位

- operation 不是业务语义层，而是“可插拔远端执行协议层”。
- query/write 可以由 operation 承载，但不应强制 runtime 绑定 operation 才能工作。

---

## 5. 多后端统一接入模型

## 5.1 HTTP 插件

- 在 operations 注册高优先级 middleware
- 把 `req.ops/meta/signal` 转发到 HTTP operation endpoint
- 返回统一 `results`

## 5.2 IndexedDB / Memory 插件

- 同样实现 operation middleware
- 本地直接执行 query/write
- 适合离线优先与测试场景

## 5.3 Sync 插件

- sync driver 使用 `ctx.operation.executeOperations`
- pull/push/subscribe 与 outbox 解耦于 runtime
- writeback 通过 `runtime.stores.applyWriteback`

## 5.4 未来 gRPC 插件（推荐）

- 复用 operation envelope 协议
- 新增 `grpcBackendPlugin` 注册 middleware 即可
- runtime 无需修改

---

## 6. 优化点（按落地价值排序）

## 6.1 第一优先：消除默认链路“语义绕路”

问题：默认 `direct` 走 operation，再靠 `LocalBackendPlugin` 兜底，语义层次反了。

建议：

1. 让 `direct` 成为**纯本地执行策略**（直接 runtime local query/write）
2. 停止自动注入 `LocalBackendPlugin`（改为显式注册）

收益：runtime 默认行为回归“本地优先、协议可选”，理解成本显著下降。

## 6.2 第二优先：收敛策略概念到执行层

问题：`StrategySpec` 同时承载 query/write/policy，语义过宽。

建议：

- 保留 runtime 端调用入口不变；
- 在 client 侧将“本地/远端/混合策略选择”集中到执行层装配；
- runtime 只拿最终 query/write executor。

## 6.3 第三优先：插件接口保持单模型并继续收口

已经完成单 `ClientPlugin`，后续保持：

- 不再新增 parallel plugin model
- runtime 能力面只保留必要 API，不回扩底层控制入口

## 6.4 第四优先：命名与流程可审计化

- `createClient` 保持 composition root
- 新增流程图与审查 checklist（见第 8 节）
- 保持“短命名 + 单一语义”规则，避免历史兼容别名回流

---

## 7. 标准执行时序（目标态）

## 7.1 Query

1. `client.stores(name).query(...)`
2. runtime read flow（hook + local state semantics）
3. 调用已装配 query executor
4. transform.writeback + state apply
5. 返回 query result

## 7.2 Write

1. `client.stores(name).create/update/delete/...`
2. runtime write flow（inbound/optimistic/policy）
3. 调用已装配 write executor
4. writeback / rollback / result mapping
5. 返回写入结果

## 7.3 Sync

1. sync engine 通过 driver 发起 operation
2. 远端返回 ack/reject/change
3. applier 调 runtime stores writeback
4. 本地状态与版本推进

---

## 8. 下一轮 AI 审查清单

## 8.1 边界审查

- runtime 是否仍出现“后端类型判断”分支？
- query/write 是否可以在无 operation 插件下工作？
- sync 是否仅依赖公开 runtime API（不触碰内部接线）？

## 8.2 复杂度审查

- createClient 是否只做编排，不承载业务细节？
- 是否还存在自动兜底插件导致的隐式行为？
- operation middleware 优先级是否清晰可解释？

## 8.3 命名审查

- 是否继续保持短而清晰（避免 `xxxList`、避免泛化历史名）？
- 同概念是否只有一套词根（operation/runtime/strategy）？

## 8.4 扩展性审查

- 新增 gRPC 插件是否无需改 runtime？
- http/indexeddb/sync 是否都通过统一 execution plane 挂载？

---

## 9. 一句话结论

**最佳长期形态是：runtime 只维护 query/write 语义，execution 负责策略实现，plugin 负责接入与扩展。**

这样在 `sync + indexeddb + http + grpc` 并存时，系统复杂度随插件数量线性增长，不会反向污染 runtime 主干。

