# 写链路批量统一方案（一步到位）

## 1. 文档目标

本文定义 `atoma-runtime` 写链路的最终形态：

1. 单写与批写共用一个提交内核，避免双实现漂移。
2. `*Many` 走真正的多 `entry` 一次提交，不再用循环单写模拟批量。
3. 删除与“假批量”相关的噪音 API 与实现（`runBatch`、`batch.concurrency`）。
4. 命名统一为简短、直观、行业常见词汇（`prepare/commit`）。

默认策略：不保留兼容层，不做过渡别名，直接替换到目标架构。

---

## 2. 现状问题

当前写链路已收敛到 `intent -> prepared`，但 `*Many` 仍存在结构性问题：

1. `commitWrite` 内部固定只提交一个 `entry`（`entries: [prepared.entry]`），单写模型被硬编码。
2. `createMany/updateMany/upsertMany/deleteMany` 通过 `runBatch` 多次调用单写实现，本质是“循环请求”。
3. `runBatch` 只是调度器（默认串行，可并发），不是协议层批提交。
4. 类型层 `WriteRequest.entries` 天然支持批量，但 runtime 主路径未利用。

结果：

1. 多条写入在远端无法作为一个批次优化（吞吐和 RTT 都偏差）。
2. 写路径出现多套概念（single commit / batch runner），理解与维护成本高。
3. `StoreOperationOptions.batch.concurrency` 暗示“批量语义”，实则只是并发控制，语义不准确。

## 2.1 问题根因（职责错位）

当前问题不是由 HTTP transport 的 batch 引起，而是 runtime 先把 many 单条化：

1. `WriteFlow.*Many` 使用 `runBatch` 循环单写（调度层语义）。
2. `commitWrite` 固定 `entries: [entry]`（提交层语义）。
3. 到 `execution.write` 时已经丢失 `entries[]` 批量语义，下游只能按“多个单写请求”处理。

---

## 2.2 两种“批量”必须区分

存在两个不同维度的 batch：

1. 写项批量（业务语义）：同一 store 的多个 `WriteEntry`，应在 runtime 写链路表达为一次 `WriteRequest.entries[]`。
2. 操作批量（传输语义）：多个 `RemoteOp` 合并传输，由 operation client / HTTP batch engine 负责。

当前混淆点：把 many 需求落在了第 2 类，而第 1 类在 runtime 层没有落地。

---

## 3. 目标架构

## 3.1 总览

统一为两层：

1. `prepare`：将 intent 转为 `PreparedWrite`（包含 `entry`、`optimisticChange`、可选 `output`）。
2. `commit`：一次接收 `PreparedWrite[]`，执行一次 `execution.write({ entries })`，按 index 回填结果。

其中：

1. 单写 = 长度为 1 的批写。
2. 批写 = 长度大于 1 的同构流程。

## 3.2 流程图

```text
single:
intent -> prepareWrite -> commitWrites([prepared]) -> unwrap one result

many:
intents[] -> prepareWrites -> commitWrites(prepared[]) -> WriteManyResult
```

---

## 3.3 职责边界（最终版）

1. `runtime.write`：负责写项批量语义（`WriteEntry[]` 的构建、提交、结果映射）。
2. `execution`：只负责 route/executor 分发，不承担业务聚合。
3. `backend-shared executor`：负责 runtime->protocol 适配（必要时把 `entries[]` 分组成多个 `WriteOp`）。
4. `operation client / http batch engine`：只负责 `RemoteOp[]` 的排队、合并、限流与发送。
5. `server opsExecutor`：负责协议约束与写语义执行（当前约束为单 `WriteOp` 内 action/options 同构）。

---

## 3.4 WriteOperation / WriteItem 模型定位

`WriteOp.write.entries[]` + `WriteItemResult[]`（按 index 对齐）是协议层的批量基元。

这意味着：

1. many 的第一性表达应是 `WriteRequest.entries[]`。
2. `WriteItem`（create/update/upsert/delete）是 item-level 语义单位。
3. transport 的 op 批处理不应替代 item 批处理。

---

## 4. 命名设计（简短、行业规范、易懂）

## 4.1 命名原则

1. 动词优先使用行业通用词：`prepare`、`commit`、`apply`、`revert`。
2. 不重复路径语义：在 `write/` 下不加冗余 `Write` 前缀。
3. 单复数表达规模：`prepareWrite`（单）/`prepareWrites`（多）。
4. 类型命名用名词，不混入流程词：`PreparedWrite`、`CommitResult`。

## 4.2 目标命名清单

| 范畴 | 现名 | 目标名 | 说明 |
|---|---|---|---|
| adapter 文件 | `intentToWrite.ts` | `prepareWrite.ts` | 从“转换”改为“准备”，语义更直接 |
| adapter 函数 | `compileIntentToWrite` | `prepareWrite` | 编译语义过重，准备语义更贴近职责 |
| 批量准备函数 | 无 | `prepareWrites` | 新增，统一 many 入口 |
| commit 文件 | `commitWrite.ts` | `commitWrites.ts` | 主函数是批量内核，用复数更准确 |
| commit 内核 | 无 | `commitWrites` | 唯一提交通道 |
| 单写封装 | `commitWrite` | `commitWrite`（保留） | 仅薄封装：调用 `commitWrites([x])` |
| 批量中间类型 | 分散 | `PreparedWrite[]` | 不新增多余包装类型时可直接用数组 |
| many 调度工具 | `runBatch` | 删除 | 不再承担写链路主路径职责 |
| options 字段 | `batch.concurrency` | 删除 | 避免“批量=并发循环”误导 |

备注：`commitWrite` 作为对外/上层薄封装可以保留；真正逻辑只在 `commitWrites` 一处。

## 4.3 分层名词表（避免语义混淆）

| 概念 | 推荐名 | 禁止混用 |
|---|---|---|
| 写项批量 | `entries` / `write batch` | `ops batch` |
| 操作批量 | `ops` / `ops batch` | `entries batch` |
| 写项单位 | `entry` | `op` |
| 协议写操作 | `write op` | `write entry` |

---

## 5. 关键契约设计

## 5.1 PreparedWrite

```ts
type PreparedWrite<T> = Readonly<{
    entry: WriteEntry
    optimisticChange: StoreChange<T>
    output?: T
}>
```

## 5.2 commit 内核契约

```ts
type CommitWritesInput<T> = Readonly<{
    runtime: Runtime
    scope: WriteScope<T>
    prepared: ReadonlyArray<PreparedWrite<T>>
}>
```

```ts
type CommitWritesOutput<T> = Readonly<{
    changes: ReadonlyArray<StoreChange<T>>
    results: WriteManyResult<T | void>
}>
```

说明：

1. `results` 与 `prepared` 严格按 index 对齐。
2. 单写通过 `results[0]` 解包。

---

## 6. 一致性与本地状态策略

## 6.1 单写

1. 保持现有能力：可按 route consistency 走 `optimistic` 或 `confirm`。
2. optimistic 失败则回滚该条变更。

## 6.2 批写

推荐默认策略：固定 `confirm`（本轮实现不做批量 optimistic）。

原因：

1. `partial/rejected` 下批量 optimistic 回滚逻辑复杂，容易引入边界缺陷。
2. 在无用户迁移成本前提下，先保证批量语义稳定与可验证。
3. 后续如要支持批量 optimistic，可作为独立增强，不影响当前主链路。

## 6.3 当前服务端约束下的适配策略

服务端当前约束：单 `WriteOp` 内不支持 mixed action / mixed options。

因此 runtime 最优做法是：

1. 先按业务语义构建完整 `entries[]`。
2. 交由 executor 适配层按 `action + options` 分组为多个 `WriteOp`。
3. 结果再按原始 index 回填 `WriteManyResult`。

这个分组属于“协议适配细节”，不是 runtime many 语义本体。

---

## 7. 事件语义

`*Many` 一次调用应只发一次写事件：

1. `writeStart`：`writeEntries` 为整批 entries。
2. `writeCommitted`：`changes` 为整批成功项落库后的聚合变化。
3. `writeFailed`：仅在整批执行级错误时触发。

逐项失败（`partial`）通过 `WriteManyResult` 表达，不拆成多次事件。

---

## 8. 错误模型

## 8.1 索引对齐错误

1. 远端返回 `results.length !== entries.length`：立即抛错。
2. 任何位置缺项：抛错并终止本次提交。

## 8.2 many + enqueued

建议规则：`prepared.length > 1` 且 `status === 'enqueued'` 时直接抛错。

原因：

1. `WriteManyResult` 需要 item-level 结果。
2. `enqueued` 无法提供 index 对齐结果，语义不完整。

---

## 9. 代码结构落地

## 9.1 目标文件责任

1. `write/adapters/prepareWrite.ts`
   - `prepareWrite`
   - `prepareWrites`
2. `write/commit/commitWrites.ts`
   - `commitWrites`（唯一内核）
   - `commitWrite`（薄封装，可选导出）
3. `flows/WriteFlow.ts`
   - `runIntent` 调 `prepareWrite + commitWrite`
   - `runManyIntent` 调 `prepareWrites + commitWrites`
4. 删除 `write/utils/batch.ts`

## 9.2 删除项

1. 删除 `StoreOperationOptions.batch`。
2. 删除 runtime 写主链路对 `runBatch` 的依赖。

## 9.3 execution / transport / server 不改职责

1. `ExecutionKernel.write` 继续保持通用接口，不感知 many/single 差异。
2. `buildOperationExecutor` 保留分组逻辑（受服务端约束），但仅做适配，不兜底 runtime many 语义。
3. `HttpOperationClient.BatchEngine` 继续做 `ops` 级批处理，不承接 `entries` 组装职责。

---

## 10. API 影响（一次替换）

## 10.1 保持不变

1. `Store` 对外方法签名（`createMany/updateMany/...`）保持不变。
2. `WriteManyResult<T>` 结构保持不变。

## 10.2 变更

1. `StoreOperationOptions.batch` 删除。
2. `*Many` 的执行语义从“多次请求”变为“一次批请求”。
3. many 结果仍保持 `WriteManyResult`，但来源变为单次 `execution.write` 的 index 映射。

---

## 11. 测试与验收

## 11.1 必测用例

1. `createMany` 发送一次 `execution.write`，`entries.length === items.length`。
2. `updateMany` 在 `partial` 时仅成功项落库，失败项返回错误。
3. 结果 index 对齐：输入第 `i` 项对应输出第 `i` 项。
4. `many + enqueued` 返回明确错误。
5. `write` 事件每次 many 仅发一次 start/commit 或 start/failed。
6. 重复 id（同批）触发前置校验错误（建议实现）。
7. executor 分组后回填结果顺序与输入顺序一致（跨组也必须一致）。

## 11.2 验证命令

1. `pnpm --filter atoma-runtime run typecheck`
2. `pnpm --filter atoma-types run typecheck`
3. `pnpm --filter atoma-client run typecheck`
4. `pnpm --filter atoma-backend-shared run typecheck`
5. `pnpm --filter atoma-sync run typecheck`
6. `pnpm --filter atoma-server run typecheck`
7. `pnpm typecheck`

---

## 12. 实施顺序（单次 PR 内完成）

1. 重命名与函数替换：`intentToWrite` -> `prepareWrite`，引入 `prepareWrites`。
2. 实现 `commitWrites`，让 `commitWrite` 成为薄封装。
3. 改 `WriteFlow` 的 `*Many` 主路径，移除 `runBatch` 调用。
4. 删除 `batch.ts` 与 `StoreOperationOptions.batch`。
5. 补齐 many 场景测试与事件断言。
6. 全量 typecheck。

完成标准：主链路仅保留 `prepare + commit` 两层，无循环单写模拟批量。

---

## 13. 最优设计（最终推荐）

在当前协议与服务端实现现实下，最优设计为：

1. runtime 只做一件事：把 many 明确表达为 `entries[]` 并一次提交。
2. commit 层只保留一个内核：`commitWrites(prepared[])`；单写只是 `[one]` 薄封装。
3. executor 保留必要分组（`action + options`），这是“服务端兼容约束”，不是 runtime 语义。
4. transport 继续做 `ops` 批处理，不处理业务写项聚合。
5. 删除 `runBatch` 与 `options.batch.concurrency`，彻底消除语义歧义。

该方案同时满足：

1. 复杂度最低（单内核、单主路径）。
2. 性能更优（many 走单次 write 请求）。
3. 语义清晰（entry-batch 与 ops-batch 分层明确）。
4. 命名简短且行业通用（`prepare/commit/entry/op`）。
