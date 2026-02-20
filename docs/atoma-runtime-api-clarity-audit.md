# atoma-runtime API 简化与去歧义审视

日期：2026-02-18

## 已完成（本轮落地）

- `getMany` 已改为“全量读取语义”：每次都按传入 ids 执行读路径，不再做“缓存命中即跳过请求”短路。实现见 `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:224`。
- `Store.getMany` 公共选项已收敛到 `StoreReadOptions`，移除了 `hydrate` 这类缓存策略开关。定义见 `packages/atoma-types/src/core/store.ts:97`。
- `listMergePolicy`/`read.*MergePolicy` 已从公共 schema 与 runtime handle 收敛移除，避免“默认策略 + 可选策略”双语义。见 `packages/atoma-types/src/core/store.ts:66`、`packages/atoma-types/src/runtime/handle.ts:8`、`packages/atoma-runtime/src/store/StoreFactory.ts:76`。
- `createMany` 已与其它 `*Many` 统一为 `WriteManyResult<T>`（all-settled 语义）：不再单独走“首错抛出”模型。见 `packages/atoma-types/src/core/store.ts`、`packages/atoma-types/src/runtime/write.ts`、`packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`。

## 审查范围

- 运行时总入口：`packages/atoma-runtime/src/index.ts`
- 运行时主流程：`packages/atoma-runtime/src/runtime/Runtime.ts`
- 读写流：`packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`、`packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
- 执行内核：`packages/atoma-runtime/src/execution/ExecutionKernel.ts`
- Store 编排与目录：`packages/atoma-runtime/src/store/StoreFactory.ts`、`packages/atoma-runtime/src/store/Stores.ts`
- 对应类型契约：`packages/atoma-types/src/runtime/*.ts`、`packages/atoma-types/src/core/store.ts`

## 仍可继续简化的 API 噪音/歧义点

### P0（已完成）：`*Many` 返回语义统一

落地结果：
- `createMany/updateMany/upsertMany/deleteMany` 统一返回 `WriteManyResult`，同名同失败模型（逐项结果）。
- “任一失败即抛错”若有需要，应由上层 helper 明确封装，不放在底层 `Store.*Many` 公共契约里。

### P0（已完成）：`delete` 返回值收敛为 `void`

落地结果：
- `Store.delete` 与 `runtime.write.delete` 均改为 `Promise<void>`。
- `Store.deleteMany` 与 `runtime.write.deleteMany` 的 item 值也收敛为 `void`（`WriteManyResult<void>`）。
- 删除单条记录的成功语义只由“是否抛错”表达，不再返回恒为 `true` 的冗余布尔值。

### P1（已完成）：`resolveHandle` 命名收敛为 `ensureHandle`

落地结果：
- `StoreCatalog` 接口由 `resolveHandle` 改为 `ensureHandle`，名称与“必要时创建 handle”的行为一致。
- `Stores` 实现、debug probe、plugin runtime 上下文调用点均已同步改名。

### P1：`query` 的缓存写回策略是隐式推断，非显式契约

现状：
- `select/include` 存在时跳过 cache 写回（`shouldSkipStore`），见 `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:14`、`packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:143`。

问题：
- “是否写回缓存”不是显式参数，而是由查询结构隐式决定，调用方较难预测。

建议（推荐）：
- 将该策略固定为单一规则并写入文档，或在 runtime 内部引入显式内部标记（不暴露到 core 公共 API）。
- 核心原则：公共 API 维持单义，策略差异留在内部编排层。

### P1：读事件缺少失败终态事件

现状：
- 事件只有 `readStart/readFinish`，见 `packages/atoma-types/src/runtime/storeEvents.ts:13`、`packages/atoma-types/src/runtime/storeEvents.ts:17`。
- `trackRead` 中只有成功路径发 `readFinish`，见 `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:34`、`packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:45`。

问题：
- 观测上会出现“有 start 无终态”的不对称，影响埋点一致性。

建议（可选）：
- 增加 `readFailed`，或把 `readFinish` 扩展为 success/error 联合载荷，保证每次 `readStart` 都有终态。

### P2（已完成）：移除 `Runtime.nextOpId` 对外暴露

落地结果：
- `Runtime` 公共类型删除 `nextOpId` 字段，避免暴露 `q/w` 前缀细节。
- 写链路不再生成 `entryId`；结果严格按 entries 的 index 对齐。

## 建议落地顺序

1. 已完成 `createMany` 语义统一与 `delete` 返回值收敛（P0）。
2. 已完成 `resolveHandle -> ensureHandle` 命名收敛（P1）。
3. 下一步处理读事件终态对称性（P1，属观测增强）。

## 总结

当前 runtime API 已比之前更单义（`getMany` 与 `list` 已明显收敛）。下一阶段重点应继续减少“同名不同语义”和“隐式策略推断”，把可选策略尽量从底层公共契约移出，放到上层明确封装中。
