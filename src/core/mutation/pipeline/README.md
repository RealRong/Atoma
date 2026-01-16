# Mutation Pipeline 速读（给新手的入口）

本目录负责把“写入操作序列”跑完一整套生命周期：Compile → Optimistic → Persist → Finalize。

---

## 推荐阅读路径（按顺序）

1) `Flow.ts`：主流程（线性）+ compile + ops + 调度/票据（避免跳转）
2) `Persist.ts`：Direct vs Outbox 的唯一分叉点

（如果你更关心细节，再继续看：`Plan.ts` / `Program.ts` / `Ops.ts` / `Scheduler.ts` / `TicketTracker.ts`）

---

## Flow.ts 在做什么？

`runMutationFlow` 是“读入口”，它负责：

 - compile：`operations → MutationProgram`（调用 `Program.ts`）
- 本地 optimistic（先 set state，再更新 indexes）
- 调用 persist（见 `Persist.ts`，唯一 direct/outbox 分叉）
- finalize（created + versionUpdates 写回 store）
- 产出可用于 history 的 commitInfo（由上层在成功路径统一 record）
- settle tickets（enqueued/confirmed）与触发 onSuccess/onFail

换句话说：**你想知道一次 mutation 到底发生了什么，只需要从这里开始。**

---

## Program.ts（Operations → Program）建议怎么读？

如果你更关心 “operations 怎么变成 program”，建议按这几个阶段看 `compileMutationProgram`：

1) hydrate 预处理：先把 `hydrate/hydrateMany` 合并进 baseState（不覆盖已存在 id）
2) 规则校验：create/patches 不可与其它类型混用；outbox 禁止 server-assigned create
3) optimistic 生成：基于 writeEvents 计算 optimisticState + immer patches/inversePatches + changedIds
4) 写入翻译：把 mutation 翻译成统一的 `Protocol WriteOp[]`（后续 direct/outbox 都只处理这套 ops）

`MutationProgram.kind` 用于快速判断这一段 mutation 的“形态”（noop/hydrate/writes/patches/serverCreate），读日志和写扩展时更直观。

---

## Persist.ts 在做什么？

`persistMutation` 把 program.writeOps 落地到持久化写入，统一输出 `PersistResult`：

- `resolvePersistModeFromOperations`：从 operations 上的 `persist` 字段决定 direct/outbox（禁止混用）
- direct：执行 ops 并解释结果（created/writeback），输出 `{ status:'confirmed', ... }`
- outbox：enqueue（可选 local-first：先 direct 再 enqueue），输出 `{ status:'enqueued', ... }`

原则：**Direct/Outbox 的差异最多只在这里出现一次**，其它地方只处理统一结果。

---

## Flow.ts（你通常不需要先看里面的细节）

`Flow.ts` 内部包含：
- ops 翻译（本地语义 → `Protocol WriteOp`）
- direct 执行 + 解释返回（`created/writeback`）
- Scheduler / TicketTracker（调度与票据）

如果你只想理解“为什么最后是 confirmed/enqueued”，先只看 `Flow.ts` 顶层主流程 + `Persist.ts`。
