# Atoma 全链路优化总清单（Master Plan）

> 目标：在“不考虑兼容成本”的前提下，进一步把当前架构收敛到更简洁、职责更清晰、可维护性更高的形态。

## 1. 当前链路（基线）

- 客户端入口：`createClient` 负责创建 `Runtime`、组装 plugin chains、注册 `ops capability`、注册 `direct` 写策略。
- 读链路：`runtime.read.query` -> `runtime.io.query`（read chain）-> `transform.writeback` ->（按缓存策略）写回 store -> hooks。
- 写链路：`runtime.write.*`（WriteFlow 编排）-> `WriteCommitFlow`（optimistic/persist/writeback/rollback）-> `strategy.persist`（persist chain）。
- 协议桥：backend plugins 通过 `queryViaOps` / `persistViaOps` 统一走 `ops client`。
- 状态提交：所有状态变化最终进入 `StoreState.commit`，统一计算 `changedIds` 并驱动索引更新。
- 本地查询：统一由 `runQuery` 执行，indexes 仅用于候选集缩小。

---

## 2. 优化项总览（按优先级）

## P0（高收益、低风险，建议优先）

### P0-1 收敛 `Runtime` 可变面（去掉 `runtime.io` 二次赋值，已完成 ✅）
- **现状**：`Runtime` 先以占位 `io` 初始化，再在 `createClient` 中覆盖赋值。
- **问题**：存在生命周期中间态；概念上 `Runtime` 构造后仍可被“半重配”。
- **目标**：`io` 构造期一次注入并只读。
- **建议**：改为 `createClient` 先准备好 `PluginRuntimeIo` 再创建 `Runtime`，或引入 RuntimeBuilder 一次性装配。

### P0-2 精简 `StrategyRegistry.persist` 的 `next` 语义（已完成 ✅）
- **现状**：`next` 当前总是返回 `{ status: 'confirmed' }`。
- **问题**：中间件接口存在“伪链式”；增加理解成本。
- **目标**：语义真实化。
- **建议**：二选一：
  - A. 去掉 `next`，改单阶段 handler；
  - B. 真正实现 descriptor 链（可组合 fallback）。

### P0-3 统一 `queryViaOps/persistViaOps` 的强类型边界（已完成 ✅）
- **现状**：存在 `as any`、宽松 envelope 解析。
- **问题**：类型噪音高，错误晚发现。
- **目标**：协议输入输出“入口即校验”。
- **建议**：抽 `ops-client codec`（request/result 统一 decode/encode），共享给 backend-shared。

### P0-4 清理 `LocalBackendPlugin` 的重复查询路径（已完成 ✅）
- **现状**：`ops.query` 与 `read` 各自实现一遍本地 query 逻辑。
- **问题**：重复逻辑，后续改动易漂移。
- **目标**：单一 helper，双入口复用。
- **建议**：抽 `runLocalQuery(ctx, storeName, query)`。

---

## P1（中等改动，高价值）

### P1-1 `StoreState.commit` 支持外部传入 `changedIds`
- **现状**：每次 commit 都全量 diff `before/after`。
- **问题**：大 map 下 O(n) 开销明显，写链路很多场景已知 changed keys。
- **目标**：避免重复 diff。
- **建议**：
  - `commit({ before, after, changedIds? })`；
  - 若传入则直接用；否则回退内部 diff。

### P1-2 `buildPatchWritePlan` 并发化 outbound transform
- **现状**：按 id 串行执行 transform/outbound。
- **问题**：大 patch 批量写时吞吐受限。
- **目标**：可控并发提速。
- **建议**：按 `concurrency`（默认 4/8）批处理，保证输出 entry 顺序稳定。

### P1-3 读缓存策略更细粒度（替代“select/include 即 skip store”）
- **现状**：`select/include` 直接跳过缓存写回。
- **问题**：过于保守，命中率下降。
- **目标**：提高缓存利用率且保持语义安全。
- **建议**：增加策略：
  - `none | full | id_version_only | partial_safe`；
  - 默认 `full`，`select/include` 走 `id_version_only`。

### P1-4 `getAll` 语义拆分（查询 vs 同步）
- **现状**：`getAll` 会基于远端结果移除本地未命中项。
- **问题**：查询接口混入“对齐同步”副作用。
- **目标**：职责分离。
- **建议**：
  - `listAll()`：纯查询，不 prune；
  - `syncAll()`：显式全量对齐并 prune。

### P1-5 `HookRegistry` 泛型强类型再收紧
- **现状**：为减少样板已改为事件映射，但 `emitEvent` 仍使用 `unknown` 作为内部桥接。
- **问题**：内部类型信息仍有一层丢失。
- **目标**：在不增加样板前提下恢复更强类型。
- **建议**：使用 `event->handler` typed dispatcher（可借助 helper factory 生成）。

### P1-6 `createOpId/nextOpId` 全局唯一性增强
- **现状**：`nextOpId` 为按 store 计数 + 时间戳。
- **问题**：跨 store 同毫秒下可读性/可追踪性一般。
- **目标**：统一全局单调 ID 语义。
- **建议**：全局 seq + runtimeId 前缀（可选保留 store 片段）。

### P1-7 `Debug` 与 `Indexes` 的隐式反射耦合去除
- **现状**：`Probe` 通过 `debugIndexSnapshots/debugLastQueryPlan` 反射式探测。
- **问题**：调试协议不显式。
- **目标**：调试能力显式注册。
- **建议**：在 runtime capability 层注册 `index-debug provider`，`Probe` 只做路由。

---

## P2（架构级重排，改动较大）

### P2-1 读写流统一“策略+缓存决策层”
- **现状**：`ReadFlow` 与 `WriteFlow` 各自散落 cache/policy 判定。
- **问题**：策略逻辑分散。
- **目标**：形成单一决策层。
- **建议**：引入 `FlowPolicyResolver`（read/write 共用）。

### P2-2 `Engine` 子域边界再收敛
- **现状**：`engine.query/relation/mutation/index/operation` 仍偏“工具箱式”暴露。
- **问题**：未来可能继续外溢内部实现细节。
- **目标**：业务流仅依赖最小接口。
- **建议**：为 read/write/relations 定义更窄 facade，减少直接触达底层函数集合。

### P2-3 Backend-shared 进一步协议化
- **现状**：`queryViaOps/persistViaOps` 为函数式桥接。
- **问题**：难以挂统一重试/熔断/限流/诊断。
- **目标**：统一 transport client abstraction。
- **建议**：抽 `OpsTransportClient`（query/persist/sync 共享）。

### P2-4 StoreFactory API 组装再降噪
- **现状**：大量逐个方法绑定（`addOne/updateOne/...`）虽清晰但样板多。
- **问题**：扩展时重复改动。
- **目标**：减少样板但不牺牲可读性。
- **建议**：通过 `bindStoreApi(handle, runtime)` 生成 API 对象，保留显式返回结构。

---

## 3. 建议执行顺序

1. **先做 P0**：P0-1 ~ P0-4（能快速降噪并降低后续改动复杂度）
2. **再做 P1**：优先 P1-1、P1-4、P1-3（性能+语义收益最大）
3. **最后做 P2**：按架构目标统一策略层、抽象层与传输层

---

## 4. 每项落地验收标准（统一）

- 类型：`pnpm typecheck` 全仓通过。
- 行为：读写链路现有用例语义不变（除明确设计变更项）。
- 架构：新增能力必须落在“对应职责层”，不回流到 `createClient` 或单文件大编排。
- 命名：短命名、语义清晰、避免歧义别名。

---

## 5. 当前状态备注

- `P1-4 IndexesLike 收窄`：已完成。
- `P1-5 HookRegistry 去重复`：已完成。
- `P2-1 WriteFlow 再压缩`：已完成。
- 本文档聚焦“下一阶段仍可继续优化”的全集，不受兼容性约束。
