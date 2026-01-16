# Mutation 链路可读性优化方案（收敛“跳转成本”）

目标：打开 `src/core/mutation/` 目录，新手能在 **2 分钟内**理解“它在做什么、数据怎么流、Direct/Outbox 的差异在哪里”，而不是在 `Executor/Reducer/Scheduler/Ticket/Persister` 之间反复跳转。

> 本文是“架构/组织方式”的方案，不强依赖当前实现细节；落地时以最小破坏性迁移为主，允许大改（你已表示不在乎改动成本）。

---

## 1. 当前链路（用“意图”描述，而不是文件名）

把 mutation 的职责拆成 6 个阶段（这是阅读入口应该呈现给人的顺序）：

1) **Collect**：收集一次用户写入（一个 actionId 下的多条 StoreDispatchEvent）
2) **Plan**：把操作序列变成可提交的 `Plan`（nextState/patches/operationTypes…）
3) **Optimistic Commit**：本地先乐观提交（UI 立即更新）
4) **Persist**：把 plan 变成可持久化写入（Direct=立即发 ops；Outbox=enqueue）
5) **Confirm/Ack**：异步确认（direct 立即确认；outbox 等 sync 推送后确认）
6) **Finalize**：把 confirmed 结果（created/writeback/versionUpdates）写回 store，并 settle tickets

阅读上最痛的是：这些阶段分散在多个文件里，同时“翻译/执行/解释”的细节又被拆成小文件，导致需要频繁跳转。

---

## 2. 目标组织方式：把“读入口”做成一条直线

### 2.1 一个“主入口”文件：`Flow.ts`（推荐）

在 `src/core/mutation/pipeline/` 下新增一个只为可读性服务的文件（例如 `Flow.ts` 或 `RunMutation.ts`），把完整链路用 80~150 行串起来：

- 输入：`ExecutorRunArgs<T>`
- 依次调用：`plan → commitOptimistic → persist(mode) → afterPersist → commitAfterPersist/rollback`
- 只保留 1 层跳转：
  - 需要看细节时，跳到对应模块（Planner/Committer/Persist）。

核心原则：**新人只读这个文件也能说清楚链路**，不需要先理解 Scheduler、TicketTracker 的内部。

### 2.2 把“实现细节”压到同目录内部，但不强迫阅读

把 pipeline 内部模块按“读者关心度”分层：

- L0（必读入口）：`pipeline/Flow.ts` + `pipeline/types.ts`（数据结构）  
- L1（理解差异）：`pipeline/Persist.ts`（Direct vs Outbox 的差别）  
- L2（实现细节）：Reducer/Scheduler/TicketTracker/Persisters/…

这样打开目录时，就能立刻看到“入口/差异/细节”三层。

---

## 3. Persist 子系统的收敛：把“三段式”合并成一个文件（降低跳转）

你当前的 persist 链路已经按最佳实践拆成：

- Translator：plan → `TranslatedWrite[]`
- Sink：direct 执行 or outbox enqueue
- Interpreter：direct 返回结果 → created/writeback/errors

这是好的架构，但对“阅读入口”确实太散。

### 3.1 推荐：把 persisters 内的 3 个文件合并为 1 个“Ops.ts”

把以下文件合并为一个文件（名字建议：`Ops.ts` 或 `WriteOps.ts`）：

- `src/core/mutation/pipeline/persisters/writePlanTranslation.ts`
- `src/core/mutation/pipeline/persisters/writeSink.ts`
- `src/core/mutation/pipeline/persisters/writeResultInterpreter.ts`

合并后的组织建议：

```ts
// Ops.ts（对外只导出 3~5 个符号）
export type TranslatedWrite = ...
export function translatePlanToWrites(...)
export class DirectWriteSink ...
export class OutboxWriteSink ...
export function interpretDirectWriteResponses(...)
```

并把所有 helper（metaForIndex/readEntityId/collect*）做成文件内私有函数。

收益：
- 阅读 persist 逻辑时不再在 3 个文件间跳转
- 依旧保留“翻译/执行/解释”的边界（通过代码分区/region/注释即可）

### 3.2 `Direct.ts` / `Outbox.ts` 进一步“只剩 20 行”

让 `DirectPersister.persist()` / `OutboxPersister.persist()` 只体现语义：

- Direct：`writes = translate(...direct)` → `responses = directSink.write(writes)` → `return interpret(...)`
- Outbox：`writes = translate(...outbox)` → `outboxSink.write(writes)`

任何 meta、key、options、patches restore 细节都不出现在 persister 文件里。

---

## 4. Direct vs Outbox 语义统一：把差异“显式化为一处”

理想状态：**Direct 与 Outbox 的差异只有“写入落点不同”**。

因此建议将 persist mode 差异集中到一个地方（例如 `pipeline/Persist.ts`）：

- `resolvePersistMode(...)`
- `persistDirect(...)`
- `persistOutbox(...)`

其它地方只拿 `PersistResult` 做 commit/settle。

### 4.1 关于 meta：建议在“翻译阶段”补齐，而不是 sync engine 再补

你提出“meta 在 outbox 里补上是否更好？”——是的，建议把每个 `WriteItemMeta` 的稳定字段（clientTimeMs/idempotencyKey）在翻译时就补齐：

- Direct：立即发 ops，也需要 meta
- Outbox：enqueue 后会重试/重放，也需要 meta 稳定

这样 sync engine 不需要“猜”写入来源或补 meta，职责更干净。

> 落地注意：如果历史上 outbox 允许 meta 缺失并在发送时生成，需要明确规则：缺失则补齐，但建议逐步迁移到“enqueue 时必须有 meta”。

---

## 5. 目录级“2 分钟读懂”：加一个 README（强烈建议）

虽然你这次要根目录文档，但为了达到“打开目录就懂”，建议同时在：

- `src/core/mutation/README.md`
- `src/core/mutation/pipeline/README.md`

加入极短说明（每个 30~60 行）：

- 一张图：Collect → Plan → Commit → Persist → Settle
- Direct/Outbox 差异：只差 Sink
- 关键类型入口：`StoreDispatchEvent`、`Plan`、`PersistResult`、`WriteTicket`
- 常见问题：为什么 patches 会翻译为 upsert+delete

这会比任何代码重构更立竿见影。

---

## 6. 落地路线（允许大改但保证可控）

按“先收敛阅读入口，再重构内部”推进：

### Phase A（1~2 次提交）：收敛入口与导出
1) 新增 `pipeline/Flow.ts`，让 `Executor.run` 变成对 `Flow.runMutation(...)` 的薄包装  
2) 新增 `pipeline/Persist.ts`，把 direct/outbox 分支逻辑集中
3) 在 `pipeline/index.ts` 只导出入口（避免暴露过多 internal）

### Phase B（1~3 次提交）：收敛 persisters 内部文件
1) 合并 `writePlanTranslation/writeSink/writeResultInterpreter` → `Ops.ts`
2) `Direct.ts` / `Outbox.ts` 变薄
3) 对应测试文件只改 import，不改语义

### Phase C（可选）：进一步减少“隐式知识”
1) 把 `TicketTracker` 的关键不变量写进 README（何时 settle enqueued/confirmed）
2) 把 `Reducer` 输出的 `Plan` 字段解释写进 `types.ts` 注释（尤其是 patches/inversePatches）

---

## 7. 设计准则（避免未来又碎回去）

1) **入口文件必须线性**：读者不需要先理解任何策略类就能理解大流程  
2) **差异集中**：Direct/Outbox 的差异最多出现在一个文件里  
3) **内部细节私有化**：避免在 barrel export 里暴露过多 helper  
4) **测试只覆盖语义**：测试围绕“输入 operations/plan → 输出 writes/sideEffects”，不要绑实现文件结构  
5) **命名优先表达意图**：`translatePlanToWrites` / `persistDirectWrites` / `enqueueOutboxWrites` 这种动词结构优先

---

## 8. 你想要的“打开目录就懂”的最终观感（示例）

`src/core/mutation/`
- `README.md`（一屏读懂）
- `MutationPipeline.ts`（对外 runtime/接口）
- `pipeline/`
  - `Flow.ts`（主流程）
  - `Persist.ts`（direct/outbox 分支）
  - `types.ts`（关键类型）
  - `Ops.ts`（plan→ops→execute/enqueue，全在一个文件）
  - 其它：Reducer/Scheduler/TicketTracker（实现细节）

---

如果你认可这套方向，我下一步建议先做 **Phase A**（加 `Flow.ts` + `Persist.ts`）——这是“读起来立刻变清晰”的最大杠杆点；然后再做 **Phase B** 把 persisters 的 3 个文件合并为 `Ops.ts`，把跳转次数从 5~8 次降到 1~2 次。
