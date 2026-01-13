# Atoma Core（`src/core`）优化建议清单

> 目标：在不牺牲语义正确性的前提下，优化 `src/core` 的**类型边界**、**性能**、**架构可维护性**与**开源可理解性**。  
> 范围：仅覆盖 core（store/mutation/indexes/query/relations/history），不讨论 UI（react）与 server 的优化细节。

---

## 0. 现状基线（便于对齐讨论）

### 0.1 Core 并非对外 API，但它决定了 DX/性能上限

- 对外入口是 `src/index.ts`（面向 client + react hooks）。
- `src/core/index.ts` 通过 `#core`（package.json `imports`）给库内部模块使用；虽然不对外 export，但它的导出面会：
  - 放大内部耦合（任何模块都能随手 import 内部类型/函数）
  - 放大 d.ts 体积与编译负担
  - 让阅读者难以分辨“公共/内部/私有”的边界

### 0.2 写入链路是性能与一致性的核心

核心链路（简写）：

`store ops` → `mutation Scheduler`（分段/合批）→ `Reducer`（plan + patches）→ `Executor`（optimistic commit → persist → commit/rollback）  

其中：

- **Scheduler** 会按 `scope|origin|actionId|persistMode` 分段合批，并在缺省时自动补 `actionId`。
- **Reducer** 用 Immer patches 生成 plan（`nextState/patches/inversePatches/appliedData`）。
- **Executor** 先写入 atom（乐观），再持久化（direct/outbox/custom via middleware），成功后 commit、失败 rollback。

---

## 1. 类型与导出边界优化（可理解性 + 维护性 + d.ts 体积）

### 1.1 建议为 core 建立“导出分层”

把 core 的导出分为三层（即使不对外 export，也能显著降低内部耦合）：

1) **Public（对外）**：由 `src/index.ts` 统一再导出（当前已在做）  
2) **Internal（库内部可用）**：`#core` 入口导出的稳定内部 API（给 client/controllers/sync 用）  
3) **Private（core 内部私有）**：仅在 `src/core/**` 内部可引用，不从 `src/core/index.ts` 导出

落地方式（建议）：

- `src/core/index.ts` 不再 `export type * from './types'`（这是“无限扩大”耦合的根源）
- 新增（或拆分）两个 barrel：
  - `src/core/public.ts`（只放**对外**允许暴露的少量类型/工具）
  - `src/core/internal.ts`（只放给库内部用的稳定接口）
- 通过 `tsup.config.ts` 的 entry map 决定产物暴露层级（目前 core 不在 package `exports`，但内部 `imports` 会生成 d.ts；仍值得收敛）

### 1.2 哪些类型“不应该”从 core 入口导出（建议清单）

这些类型/结构建议视为 **Private**（不从 `src/core/index.ts` 导出），避免上层依赖内部细节：

- `StoreDispatchEvent`：它把 mutation 运行时事件协议暴露出去，容易被滥用绕过 store API，导致 invariants 被破坏。
- `WriteTicket` / `WriteItemMeta`：属于 pipeline 的内部 await/ack 协议；外部不应耦合“票据如何实现”。
- `StoreHandle`：应视为运行时私有对象；上层应通过更窄的查询/调试接口获取所需信息（否则会到处拿 handle 改策略/读 atom）。
- `StoreOperationOptions.__atoma`：这是明确的内部保留字段；建议从 public 类型中彻底移除（或用 symbol/opaque 类型隐藏），避免用户侧“发现后依赖”。
- `PatchMetadata`：更偏 observability/commit 的内部载体，除非明确作为扩展点，否则不宜导出。

建议仍可作为 **Internal** 导出的（给库内部模块用）：

- `PersistResult/BeforePersistContext/BeforeDispatchContext`（middleware 扩展点）
- `applyStoreWriteback`（sync ack/reject/pull 的统一落地工具）
- `OutboxPersister`（如需让 client/controllers 可替换实现）

### 1.3 对外类型（`src/index.ts`）建议更“极简”

对外只保留用户真正需要理解与书写的类型：

- `Entity/StoreKey/FindManyOptions/FindManyResult/OperationContext/CreateOpContextArgs`
- store CRUD 结果类型（例如 `WriteManyResult`）
- relations include 的输入/输出推导类型（如果这是核心卖点）

其余复杂运行时类型（handle、dispatch event、mutation hooks 细节）尽量不外露，以免用户绕过语义层。

---

## 2. 性能优化建议（按收益/风险分层）

### 2.1 低风险/高收益（优先级 P0）

#### P0-1：减少不必要的 Map 拷贝与二次写回

现象：

- core 大量使用“返回新 Map”的方式更新 atom（例如 `atomMapOps`、`commitAtomMapUpdateDelta`）。
- 在写入路径中，有些场景会先把“补读的 base”写回缓存，然后立刻又在同一 action 中写入更新（updateOne/updateMany/deleteMany 的 cache-miss 分支）。

建议：

- 为“写入前补读”提供一种**不触发中间态写回**的路径：只把 base 作为计划生成的输入，最终一次性提交 nextState（减少一次 atom set + indexes 增量更新）。
- 或者至少在同一 tick 内把“补读写回”与“后续 mutation commit”合并（需要结合 Scheduler 的 segment 机制）。

评估指标：

- 写入 cache-miss 场景的 atom set 次数
- indexes 增量更新次数
- React 渲染次数（demo 中可测）

#### P0-2：为 `applyQuery` 的 where 预编译谓词（可选）

现状：

- `QueryMatcher.matchesWhere` 对每个 item 执行 `Object.entries(where)` 与条件解释。

建议：

- 在一次 `findMany` 执行内，把 where 编译成 predicate（尤其是深层 `match/fuzzy`），减少对象枚举与分支判断开销。
- 若 indexes 已返回 `exact` 候选集，可跳过 where（当前已有“exact 候选集跳过 where”的优化，继续保持并扩展到更多场景）。

#### P0-3：避免 explain/observability 导致的“双算”

现状：

- `findMany` 在启用 explain/observability 时可能先本地 evaluate 再远端 fetch（用于对比/诊断）。

建议：

- 明确该行为仅在 debug/explain 时启用，并在文档与代码注释中强调其成本。
- 对 explain payload 做轻量化（只记录关键计数与 plan，而非携带大对象）。

### 2.2 中风险/中收益（优先级 P1）

#### P1-1：`preserveReferenceShallow` 的策略可配置

现状：

- 为了稳定引用，`preserveReferenceShallow` 会遍历对象 key 两轮比较；对“大对象 + 高频更新”可能成为热点。

建议：

- 在 store config 加一个策略开关（例如 `referencePolicy: 'preserve' | 'replace' | 'smart'`），允许性能敏感场景直接替换引用。
- 或只对“经常被 React 订阅的字段集合”做浅比较（需要额外元数据，复杂度更高）。

#### P1-2：indexes 的更新策略更精细

现状：

- `applyPatches` 通过 patches 收集 `changedIds`，但对同一 id 的多字段更新可能重复 remove/add。

建议：

- 在 reducer 阶段已经有 `changedFields`，可辅助 indexes 在“字段未变更”的情况下跳过更新（取决于 index 类型与字段映射）。

### 2.3 高风险/高收益（优先级 P2，可能涉及语义变化）

#### P2-1：将 `MutationPipeline` 从“每 store 一套”提升为“每 client 一套”

现状问题：

- 目前 core store 默认 `new MutationPipeline()`（每 store 一套）。
- 这会导致“缺省 actionId 自动分配”无法跨 store 共享：同一用户动作如果写多个 store，不显式传 opContext 时，会产生不同 actionId，进而影响 history 聚合与可观测性串联。

建议方向：

- 把 `MutationPipeline/Scheduler/TicketTracker` 上移到 client/runtime 层共享；store handle 只持有对 pipeline 的引用。
- Scheduler 仍按 `atom/storeName/opContext/persistMode` 分段，但 actionId 的自动分配可以在“client 级别”统一，从而天然支持跨 store 的 action 聚合。

风险：

- 更复杂的分段与并发控制
- 需要重新梳理 hooks 的作用域（storeName 维度 vs client 维度）

---

## 3. 架构优化建议（降低耦合、减少隐式语义）

### 3.1 彻底封装 persist 路由：移除 `__atoma` 暴露

已完成（当前实现）：

- 已从 `StoreOperationOptions` 中移除 `__atoma`，用户态 options 只保留语义字段（`confirmation/opContext/timeoutMs/force` 等）。
- persist 路由不再通过 options 传递，而是由 store view 在创建 op 时写入 `StoreDispatchEvent.persist`：
  - direct view 固定 `persist='direct'`
  - outbox view 固定 `persist='outbox'`
- “缓存缺失时是否允许隐式补读”也下沉为 view 配置（而非 options override）：
  - outbox: 默认禁止
  - local-first outbox: 允许（仍可受 handle 写策略约束）
  - 具体实现为 `src/core/store/internals/writeConfig.ts`

### 3.2 `remove` vs `forceRemove` 语义统一与显式化

现状：

- `remove` 是软删除（写入 `{deleted:true}`），`forceRemove` 是硬删除（从 map 删除，并要求 baseVersion）。

建议：

- 对外 API 明确命名：`softDelete`/`hardDelete`（或 `delete`/`purge`），避免用户误解 “force” 的含义。
- 在 core 中把两者的持久化与回放规则写成清晰的 invariants（尤其是 outbox 下 baseVersion 的来源）。

### 3.3 把“server-assigned create”的特殊性前置到类型与 API

现状：

- `createServerAssigned*` 通过运行时 throw 强制 `direct + strict`，并禁止 outbox。

建议：

- API 层面让它成为单独的能力面（例如仅在 `Store(name).Direct` 暴露），从类型上就不允许在 Outbox view 上出现。
- 文档中明确它不参与 optimistic/undo 的原因与限制（幂等/回放/冲突策略）。

---

## 4. 开源可理解性/学习成本优化（最容易立竿见影）

### 4.1 增加“Core 读我”级别文档（建议放入 docs 或根目录）

建议新增一份面向贡献者的简明文档（可从本文件提炼）：

- core 的对象图（StoreHandle / StoreView / MutationPipeline）
- 写入生命周期（planned → beforePersist → committed/rolledBack）
- direct/outbox 的差异与确认语义（optimistic vs strict）
- history 的聚合单位（scope/actionId）与 patches 模型
- indexes 与 query 的配合（candidates exactness）

### 4.2 重命名与模块分区（降低“新手读不懂”的概率）

建议方向：

- `createSyncStoreView` 更名为 `createOutboxStoreView`（或至少在注释里统一称呼 Outbox）。
- 在 `src/core/` 下引入 `internal/` 目录，把 `store/internals/*`、`mutation/pipeline/*` 这类“明显内部”的模块收进去，减少目录噪音。

### 4.3 关键不变量写进注释（比长文更有效）

建议把以下内容写到对应类型/函数附近的注释（不是写博客）：

- “什么时候需要 baseVersion、为什么必须来自缓存/服务端”
- “patches 写入的持久化策略（direct restore/replace vs outbox intent merge）”
- “strict 的 confirmed 在 outbox 下由 remoteAck/remoteReject 驱动”

---

## 5. 推荐落地顺序（减少返工）

### Phase 0：基线测量（不改语义）

- 为写入/查询增加可选的 profiling（计数/耗时/atom set 次数/index 更新次数），默认关闭，只在 debug/explain 下开启。

### Phase 1：导出边界收敛（低风险）

- `src/core/index.ts` 去掉 `export type * from './types'`，改为“白名单导出”。
- 将 `StoreDispatchEvent/StoreHandle/WriteTicket` 等迁移到 private（或 internal-only）导出。
- 对外（`src/index.ts`）保持极简类型面。

### Phase 2：写入链路的结构优化（中高风险）

- 减少 cache-miss 场景的中间态写回（合并补读与最终提交）。
- 若要做大改：把 pipeline 上移到 client 级别共享，统一 actionId 自动分配，从而提升跨 store history/observability 一致性。

---

## 6. 参考入口（便于你快速定位代码）

- `src/core/createStore.ts`：StoreHandle 构建与服务注入
- `src/core/store/createStoreView.ts`：store API 视图
- `src/core/mutation/MutationPipeline.ts`：写入运行时与控制面
- `src/core/mutation/pipeline/Scheduler.ts`：分段合批与 actionId
- `src/core/mutation/pipeline/Reducer.ts`：plan/patches 生成
- `src/core/mutation/pipeline/Executor.ts`：optimistic commit + persist + rollback
- `src/core/mutation/pipeline/persisters/Direct.ts`：direct 持久化与 writeback
- `src/core/mutation/pipeline/persisters/Outbox.ts`：outbox enqueue（intent）
- `src/core/store/ops/findMany/index.ts`：查询策略（本地/远端/缓存写入）
- `src/core/indexes/*`：候选集索引系统
- `src/core/history/HistoryManager.ts`：undo/redo（patches）
