# Runtime Write 极简方案（5 步 + 1 结构 + 1 ctx）

## 1. 目标

保留你确认的职责边界，但把实现复杂度压到最低：

1. 步骤减少到 5 步。
2. 中间结构只保留 1 个。
3. 全流程只传 1 个 `ctx`。
4. `opId` 只做内部关联，不扩散为复杂类型体系。

---

## 2. 最终链路（极简）

```text
Intent[]
  -> preflight
  -> hydrate
  -> build
  -> commit
  -> reconcileEmit
```

说明：

1. `build` 内部完成：`draft + compileRemote`。
2. `reconcileEmit` 内部完成：`normalize + applyReconcile + emit`。
3. 这样保持职责不丢失，但避免拆太细导致实现反而复杂。

---

## 3. 唯一中间结构

只保留一个数组 `rows`，按输入顺序存储：

```ts
type Row<T extends Entity> = {
    opId: string
    intent: IntentCommand<T>
    base?: T
    change?: StoreChange<T>
    output?: T
    entry?: WriteEntry
    remoteResult?: WriteOutput['results'][number]
    optimistic?: ReadonlyArray<StoreChange<T>>
}
```

设计要点：

1. `rows` 即执行顺序。
2. `rows` 即关联容器（通过 `opId`）。
3. 不再引入 `DraftWrite`、`RemoteWriteEntry`、`NormalizedResult` 等额外类型。

---

## 4. 唯一流程上下文

每一步都只接收同一个 `ctx`：

```ts
type WriteCtx<T extends Entity> = {
    runtime: Runtime
    scope: WriteScope<T>
    source: WriteEventSource
    rows: Row<T>[]
    status: WriteStatus
    results: WriteManyResult<T | void>
    changes: ReadonlyArray<StoreChange<T>>
}
```

统一签名：

```ts
type Step<T extends Entity> = (ctx: WriteCtx<T>) => Promise<void>
```

---

## 5. 五步职责

## 5.1 `preflight(ctx)`

职责：

1. 基础校验（空输入、action 合法性）。
2. 批量冲突检查（重复 id 规则）。
3. 生成 `rows` 与 `opId`。

写入字段：`ctx.rows`。

## 5.2 `hydrate(ctx)`

职责：

1. 为 `update/delete`（和需要 base 的 upsert）填充 `row.base`。
2. snapshot 命中优先；缺失时按 consistency 批量补读。
3. 补读结果统一 `processor.writeback`。

写入字段：`row.base`。

## 5.3 `build(ctx)`

职责：

1. 领域推导（create/update/upsert/delete）得到 `row.change`、`row.output`。
2. inbound processor。
3. 远端协议编译，得到 `row.entry`（含 outbound/meta/options）。

写入字段：`row.change`、`row.output`、`row.entry`。

## 5.4 `commit(ctx)`

职责：

1. 若 optimistic：先 apply `row.change`，记录到 `row.optimistic`。
2. 若有远端 executor：提交 `row.entry`，回填 `row.remoteResult`。
3. local-only：跳过远端提交。

写入字段：`row.optimistic`、`row.remoteResult`。

## 5.5 `reconcileEmit(ctx)`

职责：

1. 归一化远端结果（如 writeback 数据处理）。
2. 根据 `row.remoteResult` 保留或回滚 optimistic。
3. 汇总 `ctx.results`、`ctx.changes`、`ctx.status`。
4. 发送 `writeStart/writeCommitted/writeFailed`。

写入字段：`ctx.results`、`ctx.changes`、`ctx.status`。

---

## 6. Orchestrate（唯一入口）

```ts
async function orchestrateWrite<T extends Entity>(args: {
    runtime: Runtime
    scope: WriteScope<T>
    source: WriteEventSource
    intents: ReadonlyArray<IntentCommand<T>>
}): Promise<{
    status: WriteStatus
    results: WriteManyResult<T | void>
    changes: ReadonlyArray<StoreChange<T>>
}>
```

内部固定顺序：

1. `preflight(ctx)`
2. `hydrate(ctx)`
3. `build(ctx)`
4. `commit(ctx)`
5. `reconcileEmit(ctx)`

---

## 7. 为什么这版是最简

1. 步骤最少：从 8-9 个阶段收敛到 5 个。
2. 类型最少：只新增 `Row` 和 `WriteCtx`。
3. 参数最少：每步只传 `ctx`。
4. 关联稳定：`opId` 只在 `rows` 内使用，不扩散。
5. 仍保留你要求的职责边界（补读/构建/远端提交/收敛完全分离）。

---

## 8. 命名策略（最小重构噪音）

1. 对外与上层保留：`orchestrateWrite`。
2. 内部阶段函数采用短名：
   - `preflight`
   - `hydrate`
   - `build`
   - `commit`
   - `reconcileEmit`
3. 不强制一次性重命名全部文件；先按逻辑落地，再做命名收敛。

---

## 9. 最小迁移路径

1. 先引入 `rows`，把现有 `prepared` 数据搬到 `rows`。
2. 把 `resolveWriteBase` 抽到 `hydrate`。
3. 把现有 prepare 与 remote entry 组装合并成 `build`。
4. 把 optimistic + remote commit 合并成 `commit`。
5. 把 normalize/reconcile/event 合并到 `reconcileEmit`。
6. 最后删掉旧的 `PreparedWrite` 混合结构。

---

## 10. 验证清单

1. `pnpm --filter atoma-runtime run typecheck`
2. `pnpm --filter atoma-runtime run build`
3. `pnpm --filter atoma-client run typecheck`
4. `pnpm typecheck`

测试重点：

1. 批量补读只触发一次远端查询。
2. optimistic 模式下部分失败按 `opId` 精确回滚。
3. local-only 与 remote 两路径结果一致。
4. 单条与批量的输出顺序与输入顺序一致。

---

## 11. 结论

这是在不牺牲职责清晰度前提下的最低复杂度版本：

1. 5 步流程；
2. 1 个中间结构 `rows`；
3. 1 个贯穿上下文 `ctx`；
4. 无多余中间概念。
