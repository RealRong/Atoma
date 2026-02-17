# Intent -> Change -> Plan 统一写入架构（最优方案）

更新时间：2026-02-17

## 1. 目标

把 runtime 写入统一为一条主链路：

1. `业务意图（intent）` 先归一为 `StoreChange[]`
2. 再由统一 planner 把 `StoreChange[]` 变成 `WritePlanEntry[]`
3. 最后进入同一 `WriteCommitFlow`

同时满足：

- 公共类型保持简洁（`StoreChange` 不扩展，不新增复杂公共类型）
- 不牺牲语义（保留 create/update/upsert/delete 的策略差异）
- 历史回放与业务写入共享同一底层 plan 生成器

---

## 2. 现状问题

当前有两条产出 `WritePlan` 的路线：

- `WriteEntryFactory`：业务意图 -> plan entry
- `changePlan`：changes 回放 -> plan

问题不是“结构不一致”，而是“语义与规则散落”：

- `meta/baseVersion/outbound` 规则在两处维护
- 未来新增策略时，容易两边行为漂移

---

## 3. 目标态分层

### 3.1 Public API（保持稳定）

不新增公共复杂类型，继续保留：

- `addOne/addMany`
- `updateOne/updateMany`（updater）
- `upsertOne/upsertMany`
- `deleteOne/deleteMany`
- `applyChanges(handle, changes, direction, options)`

`StoreChange` 继续保持最小形态：

```ts
type StoreChange<T> = Readonly<{
    id: EntityId
    before?: T
    after?: T
}>
```

### 3.2 Runtime Internal API（新增统一入口）

新增内部统一入口（仅 runtime 内部）：

```ts
type IntentAction = 'add' | 'update' | 'upsert' | 'delete'

type IntentPayload<T extends Entity> = {
    add: { item: Partial<T> }
    update: { id: EntityId; updater: StoreUpdater<T> }
    upsert: { item: PartialWithId<T> }
    delete: { id: EntityId }
}

type IntentOptions = {
    add: StoreOperationOptions
    update: StoreOperationOptions
    upsert: StoreOperationOptions & UpsertWriteOptions
    delete: StoreOperationOptions
}

type IntentInput<T extends Entity, A extends IntentAction = IntentAction> = {
    kind: 'intent'
    action: A
    handle: StoreHandle<T>
    opContext: OperationContext
    options?: IntentOptions[A]
} & IntentPayload<T>[A]

type ReplayInput<T extends Entity> = {
    kind: 'change-replay'
    handle: StoreHandle<T>
    opContext: OperationContext
    options?: StoreOperationOptions
    direction: ChangeDirection
    changes: ReadonlyArray<StoreChange<T>>
}

type WriteInput<T extends Entity> = IntentInput<T> | ReplayInput<T>

type PlanBuildResult<T extends Entity> = Readonly<{
    plan: WritePlan<T>
    output?: T
}>

function buildWritePlan<T extends Entity>(input: WriteInput<T>): Promise<PlanBuildResult<T>>
```

原则：`WriteInput` 为 runtime 核心内部 API，禁止使用 `payload: unknown`；公共字段（`handle/opContext/options`）只保留一处，通过 `kind + action` 判别联合完成收敛。

---

## 4. 核心设计：两级适配 + 单一 planner

## 4.1 第一级：输入适配（语义层）

- `intent` 路径：先做校验/归一化/transform，产出 `StoreChange[]` + `IntentHints`
- `change-replay` 路径：直接把 `changes + direction` 转成目标变更序列

> 关键点：**先统一变化事实，再做 plan**，但不丢失意图策略。

### 4.2 第二级：统一 planner（执行层）

统一 planner 只负责：

1. 按变更序列决定 `upsert/delete`
2. 计算 `baseVersion`
3. 生成 `meta`
4. 生成 `WritePlanEntry[]`

统一 planner 不再关心“调用来自 add 还是 history”。

---

## 5. 明确 API 设计（建议）

## 5.1 新内部模块

建议目录：

- `packages/atoma-runtime/src/runtime/flows/write/planner/buildWritePlan.ts`
- `packages/atoma-runtime/src/runtime/flows/write/planner/planCommon.ts`
- `packages/atoma-runtime/src/runtime/flows/write/adapters/intentToChanges.ts`
- `packages/atoma-runtime/src/runtime/flows/write/adapters/replayToChanges.ts`

## 5.2 公共函数签名

```ts
// 只做“intent -> changes + output”，不接受 unknown payload
function adaptIntentToChanges<T extends Entity>(args: {
    runtime: Runtime
    input: IntentInput<T>
}): Promise<{
    changes: ReadonlyArray<StoreChange<T>>
    output?: T
    policy: {
        preferDeleteAsUpdate?: boolean
        upsertMode?: 'strict' | 'loose'
        merge?: boolean
    }
}>

// 只做“changes(+direction) -> 标准目标变化序列”
function adaptReplayChanges<T extends Entity>(args: {
    changes: ReadonlyArray<StoreChange<T>>
    direction: ChangeDirection
}): ReadonlyArray<StoreChange<T>>

// 单一计划器：唯一负责生成 plan entries
function buildPlanFromChanges<T extends Entity>(args: {
    runtime: Runtime
    handle: StoreHandle<T>
    opContext: OperationContext
    options?: StoreOperationOptions
    changes: ReadonlyArray<StoreChange<T>>
    policy?: {
        forceDelete?: boolean
        upsertMode?: 'strict' | 'loose'
        merge?: boolean
    }
    createEntryId: () => string
}): Promise<WritePlan<T>>
```

## 5.3 WriteFlow 对外方法如何调用

```ts
addOne/updateOne/upsertOne/deleteOne
  -> adaptIntentToChanges(...)
  -> buildPlanFromChanges(...)
  -> commitWrite(...)

applyChanges(...)
  -> adaptReplayChanges(...)
  -> buildPlanFromChanges(...)
  -> commitWrite(...)
```

---

## 6. 为什么这是“最优”而不是“过度设计”

1. **公共层不变简单**：不新增公共复杂类型，`StoreChange` 仍最小。
2. **职责清晰**：意图适配与 plan 生成分离，定位问题更快。
3. **避免双实现漂移**：`meta/baseVersion/outbound/entry` 只有一套。
4. **扩展性好**：后续 sync/reconcile 只需新增 adapter，不改 commit 主链路。

---

## 7. 落地步骤（一步到位）

1. 新增 `buildPlanFromChanges`，迁入 `changePlan` 中共性规则。
2. 把 `WriteEntryFactory` 的 entry 拼装逻辑下沉到 `buildPlanFromChanges`。
3. `WriteEntryFactory` 保留为“intent 适配器”（或重命名为 `IntentWriteAdapter`）。
4. `changePlan.ts` 退化为 `replayToChanges`（或删除并并入 adapter）。
5. `WriteFlow` 两条入口都只调用统一 planner。
6. 全仓 typecheck + 行为回归（history undo/redo、delete force/soft delete、upsert merge）。

---

## 8. 命名建议（与现有规范一致）

- `WriteEntryFactory` -> `IntentWriteAdapter`（更贴职责）
- `changePlan.ts` -> `replayToChanges.ts`
- `buildChangeWritePlan` -> `buildPlanFromChanges`

说明：不带 `Runtime` 前缀，不引入冗余上下文词，名称即职责。
