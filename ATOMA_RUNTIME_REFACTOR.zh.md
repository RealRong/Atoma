# Atoma Runtime 重构建议（以 Runtime 为核心）

## 目标与范围
- 目标：以 Runtime 为唯一流程核心，减少跨文件跳转和概念分裂，让新手从 1-2 个入口文件即可理解读写全流程。
- 范围：仅覆盖 `packages/atoma-runtime/src` 内部实现（Runtime、Store、Mutation、IO、Persistence、Observability、Transform）。
- 非目标：兼容性与外部 API 不作为约束（当前无用户）。

## 现状架构地图（基于 atoma-runtime 代码）

### Runtime 构造与依赖装配
- `runtime/Engine.ts`
  - 负责创建并持有 `io` / `write` / `mutation` / `persistence` / `observe` / `transform` / `stores`。
  - 依赖：`MutationPipeline`、`WriteCoordinator`、`StrategyRegistry`、`Io`、`DataProcessor`、`Stores`。

### Store API 与状态
- `store/Stores.ts`
  - 懒加载 store handle，并拼装 CRUD API（add/update/delete/get/query 等）。
  - 读取逻辑（query/get）与写入逻辑（dispatch）分散在 `store/ops/*`。
- `store/internals/*`
  - `storeHandleManager.ts`: handle 结构、索引、opId、observability context。
  - `StoreStateWriter.ts`: Jotai Map 写回与索引增量更新。
  - `StoreWriteUtils.ts`: 写入工具、合并策略等。

### 读流程（Store ops）
- 入口分散于 `store/ops/*`
  - `createQuery`/`createGetMany`/`createFetchAll` 等直接访问 `io`，并自行处理缓存、transform、写回。
  - 本地查询逻辑落在 `store/ops/findMany/*`。

### 写流程（Mutation Pipeline）
- 入口：`store/ops/addOne/updateOne/...` -> `Runtime.write.*` -> `MutationPipeline` -> `Scheduler` -> `MutationFlow`。
- 核心文件：
  - `mutation/MutationPipeline.ts`: 调度入口和 ticket 管理
  - `mutation/pipeline/Scheduler.ts`: opContext 归一化、分段、队列
  - `mutation/pipeline/MutationFlow.ts`: 乐观更新、持久化、ack/回滚
  - `mutation/pipeline/LocalPlan.ts`: base/optimistic/patches
  - `mutation/pipeline/MutationProgram.ts`: plan -> program
  - `mutation/pipeline/WriteIntents.ts`: dispatch/patch -> intents
  - `mutation/pipeline/WriteOps.ts`: intents -> protocol ops -> io.executeOps
  - `mutation/pipeline/Persist.ts`: runtime.persistence.persist
  - `mutation/pipeline/WritebackCollector.ts`: ack 聚合
  - `mutation/pipeline/WriteTicketManager.ts`: ticket/ack/timeout

### Transform / Observability / Persistence
- `store/internals/dataProcessor.ts`: inbound/outbound/writeback pipeline。
- `runtime/Observability.ts`: per-store context。
- `runtime/StrategyRegistry.ts`: persistence 策略路由。
- `runtime/Io.ts`: local/remote IO，包含 transform 出站逻辑。

## 关键流程（当前阅读路径）

### 写流程（简化路径）
Store API -> WriteCoordinator.prepare -> Mutation.begin -> dispatch
-> Scheduler.enqueue -> MutationFlow
-> LocalPlan -> MutationProgram -> WriteIntents -> WriteOps
-> runtime.persistence.persist -> ack 写回 -> callbacks / rollback

### 读流程（简化路径）
Store API -> store/ops/query/get
-> runtime.io.query -> transform.writeback -> StoreStateWriter.commit

## 可读性问题（核心痛点）
1. **Runtime 不是“流程中心”**
   - Runtime 只装配子系统，真正的业务流程分散在 Store ops 与 Mutation pipeline 中。
   - 新人从 `Engine` 跳到 `Store ops` / `Mutation` 需要跨多个目录才能拼出完整流程。

2. **写流程过多中间对象与层级**
   - LocalPlan、MutationProgram、WriteIntents、WriteOps、Persist、WritebackCollector 多层封装。
   - 每层职责略有重叠（如 write ops 构建 + transform + ack），导致理解成本偏高。

3. **读流程分散 & 缺乏统一入口**
   - 每个 read op 自己处理缓存、transform、写回、observability，不易形成一致的心理模型。

4. **策略与上下文穿透分散**
   - writeStrategy、writePolicy、opContext 在多个文件间穿插传递，概念耦合但位置分散。

5. **Observability / Transform 触发点分布不一致**
   - 读写两条链路中，context 和 transform 的触发位置不同，新手容易困惑。

## 重构目标（Runtime 优先）
- Runtime 作为**唯一流程入口**，读写路径都从 Runtime 进入并收敛。
- 降低“中间概念数量”，把写流程合并为一条“单文件可读”的步骤流。
- Store 仅为轻量 API 层，逻辑全部下沉 Runtime。
- 统一 Observability / Transform / Persistence 的触发点，保证一致性。

## 重构建议（核心结构）

### 1) 统一入口：Runtime 负责读写流程
新增（或替换）明确入口：
- `Runtime.read.query` / `Runtime.read.getMany` / `Runtime.read.fetchAll`
- `Runtime.write.add` / `Runtime.write.update` / `Runtime.write.remove` / `Runtime.write.patches`

Store 层只做薄封装：
- `store.addOne()` -> `runtime.write.add(handle, ...)`
- `store.query()` -> `runtime.read.query(handle, ...)`

这样新人只需要阅读 `Runtime` + `ReadFlow` + `WriteFlow`。

### 2) 写流程合并为单一“WriteFlow”模块
将 LocalPlan/Program/Intents/Ops 合并为单一文件或极少文件：
- `runtime/write/WriteFlow.ts`
  - `buildOptimisticState`
  - `buildWriteOps`（同时处理 patch 与 event）
  - `persist`（调用 runtime.persistence）
  - `applyAck` + `rollback`

保留必要的概念，但减少“层层包装对象”。

### 3) 缩减中间类型数量
建议合并或改名：
- `StoreDispatchEvent` -> `WriteRequest`（单一结构）
- `LocalPlan`/`MutationProgram` -> `WritePlan`
- `TranslatedWriteOp` 与 `WriteIntent` 合并为 `WriteOp`（含 action / entityId / options / meta）

减少“同义概念”数量，让新人一眼能定位数据结构。

### 4) 读流程抽成 ReadFlow
新增：`runtime/read/ReadFlow.ts`
- 输入：`handle + query/options`
- 统一处理：
  - observability context
  - 本地缓存策略（localEvaluate / cachePolicy）
  - IO 读取
  - transform.writeback
  - StoreStateWriter 写回

每个 read op 在 Runtime 内只是一种参数组合，不重复逻辑。

### 5) 明确 Runtime 的“核心上下文”职责
在 Runtime 内统一维护：
- `RuntimeContext`：
  - storeName / handle / opContext / writeStrategy / policy / observability
- 所有流程只传 `RuntimeContext`，避免多处拼装。

### 6) 统一 Transform 触发点
- Outbound：写入前统一在 WriteFlow 里调用一次（不要在 Io 与 WriteOps 两处重复逻辑）。
- Writeback：读、写 ack 都在 Runtime 层统一调用。

### 7) 简化策略与持久化
- `StrategyRegistry` 可以保留，但把调用点固定在 WriteFlow 内。
- `writePolicy` 只在 Runtime 层解析一次，不在各 Store op 内零散调用。

### 8) Scheduler 的定位更明确
- Scheduler 只负责：排队 + 分段 + 串行执行。
- Flow 内部统一处理 opContext normalization，不在外部重复。
- 方案：`Runtime.write.enqueue(request)` -> Scheduler -> `WriteFlow.runSegment`。

### 9) 文档化“新手阅读路径”
在 Runtime 根目录提供 `README`：
1. `Runtime.ts`（装配 + API）
2. `read/ReadFlow.ts`（读流程）
3. `write/WriteFlow.ts`（写流程）
4. `store/StoreHandle.ts`（状态载体）

## 建议文件结构（示意）
```
packages/atoma-runtime/src/
  runtime/
    Runtime.ts            # 统一入口，装配 + API
    context.ts            # RuntimeContext 定义
    read/ReadFlow.ts      # 读流程唯一入口
    write/WriteFlow.ts    # 写流程唯一入口
    write/Scheduler.ts    # 仅排队和分段
    write/Tickets.ts      # ticket 管理
    persistence/Registry.ts
    observability/RuntimeObservability.ts
    transform/DataProcessor.ts
  store/
    StoreHandle.ts        # 纯 handle + state writer
    StoreStateWriter.ts
    ops/                  # 可保留，仅为薄封装
  types/
    runtime.ts            # 统一类型入口
```

## 读写流程（重构后示意）

### 写流程（Runtime-first）
1. Store 调用 `runtime.write.add(...)`
2. Runtime 创建 `RuntimeContext`
3. Scheduler 分段 / 排队
4. WriteFlow 执行：
   - build optimistic state
   - build write ops（含 patch 与 event）
   - persist（StrategyRegistry）
   - apply ack 或 rollback
5. 回调 / ticket settle

### 读流程（Runtime-first）
1. Store 调用 `runtime.read.query(...)`
2. ReadFlow：
   - local evaluate（可选）
   - io.query
   - transform.writeback
   - store commit

## 新手理解路径（重构后）
- 从 `Runtime.ts` 看到可用 API + 主要依赖注入。
- 读流程只看 `ReadFlow.ts`。
- 写流程只看 `WriteFlow.ts`。
- 需要深入时再看 `Scheduler.ts` / `Tickets.ts` / `StoreStateWriter.ts`。

## 分阶段执行建议（不考虑兼容也可采用）
1. **建立新 Runtime 入口**：新增 `Runtime.ts + ReadFlow.ts + WriteFlow.ts`，把核心逻辑迁入。
2. **Store ops 变薄**：将所有 CRUD 逻辑统一改为调用 Runtime。
3. **删除多余 pipeline 层**：逐步合并 LocalPlan/MutationProgram/WriteIntents/WriteOps。
4. **统一 Transform/Observability**：把 transform 与 observability 触发点移动到 Runtime。
5. **清理 types**：减少中间类型数量，统一命名。

## 额外建议（提升可读性的小改动）
- 把“写流程步骤”写成明确的 6-8 个函数，放同一文件，避免跨文件跳转。
- 将 `StoreDispatchEvent` 的 union 改为显式的 `WriteAction + payload` 结构，减少类型分支。
- `WritePolicy` 和 `writeStrategy` 只在 Runtime 入口解析一次。
- 在 Runtime 中提供一个 `debugTrace` 开关，把 observability 的 emit 逻辑集中。

---

如果你希望，我可以在下一步把这个结构映射成更具体的迁移清单（逐文件如何移动/合并），并生成更细的“新目录骨架”建议。
