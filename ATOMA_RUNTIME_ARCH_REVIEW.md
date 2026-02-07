# Atoma Runtime 架构复盘与优化方案

> 目标：系统梳理 `packages/atoma-runtime` 当前架构状态，识别“别扭点”、命名/职责问题、可复用点与进一步重构路线。
> 说明：本文件基于当前仓库代码快照，强调可执行的重构建议与优先级。

## 1. 总体结论

当前 `atoma-runtime` 已完成一轮正确方向的重构：

- `WriteFlow` 负责流程编排
- `write/commit` 负责提交编排与 op 规划
- `write/services`/`write/utils` 做能力拆分
- `Runtime.persistence` 已收敛为 `Runtime.strategy`

整体方向是对的，但仍存在：

1. **1 个高优先级正确性问题**（optimistic 回滚窗口）
2. 一批 **类型边界不清（`any` 过多）**
3. 少量 **命名语义偏弱** 与 **类/函数形态不一致**
4. `ReadFlow` 仍有可抽取复用逻辑，但不需要大拆

---

## 2. 当前架构快照（简图）

- 运行时入口：`packages/atoma-runtime/src/runtime/Runtime.ts`
- Flow 层：
  - `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
  - `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
- Write 子层：
  - Commit：`packages/atoma-runtime/src/runtime/flows/write/commit/*`
  - Services：`packages/atoma-runtime/src/runtime/flows/write/services/*`
  - Utils：`packages/atoma-runtime/src/runtime/flows/write/utils/*`
- Registry：
  - `packages/atoma-runtime/src/runtime/registry/StrategyRegistry.ts`
  - `packages/atoma-runtime/src/runtime/registry/HookRegistry.ts`
- Store 子系统：
  - `packages/atoma-runtime/src/store/StoreFactory.ts`
  - `packages/atoma-runtime/src/store/StoreState.ts`
  - `packages/atoma-runtime/src/store/Stores.ts`

---

## 3. 问题清单（按优先级）

## P0（必须先改）

### P0-1: optimistic 回滚窗口缺口（正确性）

**现象**

`WriteCommitFlow.execute` 里先执行 optimistic commit，再进行 `buildWriteOps`。如果 `buildWriteOps` 抛错（例如 transform.outbound 出错），当前逻辑不会 rollback。

**定位**

- `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts:23`
- `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts:31`
- `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts:47`

**影响**

- 客户端状态可能停留在 optimistic 状态且未回滚
- 后续读写在错误缓存上继续运行

**建议**

- 将 `buildWriteOps` + `persist` + `applyWriteback` 统一纳入同一个 `try/catch`
- 或在 plan 构建前不做 optimistic apply（改为 plan 成功后再 apply）
- 任何异常路径都必须走统一 rollback 分支

---

## P1（高价值，建议本轮完成）

### P1-1: `WriteBatchRunner` 泛型设计弱，`any` 泄漏

**定位**

- `packages/atoma-runtime/src/runtime/flows/write/services/WriteBatchRunner.ts:14`
- `packages/atoma-runtime/src/runtime/flows/write/services/WriteBatchRunner.ts:19`

**问题**

- `toResult`/`toError` 返回 `any`
- `results` 是 `any[]`
- 上游 `WriteFlow.runMany` 依赖强制断言

**建议**

- 把 `WriteBatchRunner` 改为三泛型：`<Input, Success, Result>`
- `runMany` 返回 `Promise<Result[]>`
- 去掉上游 `as WriteManyResult<O>`

---

### P1-2: `WriteFlow` 存在“强制返回类型”语义噪音

**定位**

- `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:144`
- `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:316`
- `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts:345`

**问题**

- `returnValue?: T` + `as any`（如 `true as any`、`undefined as any`）表达不自然

**建议**

- 让 `executeSingleWrite` 支持泛型返回值 `R`
- 通过 `resolver` 或 `fallback` 回调计算返回值
- 消除布尔/void 场景的 `any` 断言

---

### P1-3: `StoreFactory` `any` 密度过高，类型边界模糊

**定位**

- `packages/atoma-runtime/src/store/StoreFactory.ts:11`
- `packages/atoma-runtime/src/store/StoreFactory.ts:91`
- `packages/atoma-runtime/src/store/StoreFactory.ts:137`

**问题**

- `StoreEngineApi`、facade 构造和 hydrate 逻辑大量 `any`
- 导致 API 使用方获得较弱的静态保障

**建议**

- `StoreFactory.build<T>()` 保持泛型贯通
- facade 与 api 尽可能复用同一套类型别名
- `hydrate` 的输入、输出、changedIds 建立明确类型

---

### P1-4: `WriteCommitFlow` 里 rollback 入参可复用类型未使用

**定位**

- 类型定义：`packages/atoma-runtime/src/runtime/flows/write/types.ts:5`
- 调用处：`packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts:73`

**问题**

- 已有 `OptimisticState` 类型但调用仍手工拼字段 + cast

**建议**

- `OptimisticService.apply` 直接返回 `OptimisticState<T>`
- `rollback` 直接接收 `OptimisticState<T>`（或 `OptimisticState<T> & { handle }`）

---

## P2（风格统一与可读性增强）

### P2-1: 无状态 service 更适合函数化

**定位**

- `packages/atoma-runtime/src/runtime/flows/write/services/WriteBatchRunner.ts:9`
- `packages/atoma-runtime/src/runtime/flows/write/services/OptimisticService.ts:6`

**问题**

- 类中无实例状态，只有纯函数行为

**建议**

- 改为 `writeBatch.ts` / `optimisticCommit.ts` 的函数导出
- 类保留在真正“有状态/需依赖注入”的主流程对象（`WriteFlow`/`WriteCommitFlow`）

---

### P2-2: utils 文件命名语义偏泛

**定位**

- `packages/atoma-runtime/src/runtime/flows/write/utils/prepare.ts`
- `packages/atoma-runtime/src/runtime/flows/write/utils/finalize.ts`
- `packages/atoma-runtime/src/runtime/flows/write/utils/patches.ts`

**建议命名**

- `prepare.ts` -> `prepareWriteInput.ts`
- `finalize.ts` -> `resolveWriteResult.ts`
- `patches.ts` -> `buildEntityRootPatches.ts`

目标：读文件名就能知道行为边界，而不是“prepare/finalize”这种阶段词。

---

### P2-3: `ReadFlow` 参数与职责可再收敛

**定位**

- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:200`
- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:210`
- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:215`

**问题**

- 若干 `options` 入参未使用
- 远端写回、缓存合并、fallback 逻辑集中在一个大类里

**建议（小改）**

- 先清理未使用参数（或明确预留注释）
- 抽出 2~3 个纯函数：
  - 远端数据标准化
  - 缓存合并并收集 changedIds
  - fallback 本地查询封装

> 结论：`ReadFlow` 目前无需类层级大拆，做局部函数抽取即可。

---

### P2-4: HookRegistry 扩展位较弱

**定位**

- `packages/atoma-runtime/src/runtime/registry/HookRegistry.ts:34`

**问题**

- `has` 仅提供 `writePatches`

**建议**

- 提供事件级 `has(event)` 或通用 `counts`
- 避免未来新增事件时继续硬编码字段

---

## 4. 命名与目录规范建议（针对 runtime）

## 4.1 类命名

- 主流程编排：`*Flow`（保留）
- 协调器：`*Coordinator`（有必要时）
- 纯构建器：`*Builder` 或函数
- 纯规划器：`*Planner`（当前 `WriteOpsPlanner` 合理）

## 4.2 文件命名

优先使用“动作 + 领域对象”的明确语义：

- `resolveWriteResult.ts`、`buildWriteOps.ts`、`applyOptimisticState.ts`
- 尽量避免仅阶段词：`prepare.ts`、`finalize.ts`

## 4.3 目录职责

建议保持三层：

- `flows/`：编排对象
- `policies/`：策略选择与约束（可选）
- `utils/`：纯函数

当前 `write/commit|services|utils` 已接近此目标。

---

## 5. 推荐重构路线（可执行）

## 阶段 A（正确性修复）

1. 修复 `WriteCommitFlow` rollback 窗口
2. 为 plan 构建失败增加测试用例（验证 optimistic 必回滚）

## 阶段 B（类型质量）

1. 泛型化 `WriteBatchRunner`
2. 消除 `WriteFlow` 的 `true as any`/`undefined as any`
3. 收敛 `StoreFactory` 的 `any` 外溢

## 阶段 C（可读性与规范）

1. 无状态 service 函数化
2. utils 文件重命名
3. `ReadFlow` 抽出小型纯函数并清理未用入参

---

## 6. 验收标准

- 类型：`pnpm --filter atoma-runtime run typecheck` 通过
- 构建：`pnpm --filter atoma-runtime run build` 通过
- 关联包：`atoma-client`、`atoma-sync` typecheck 通过
- 行为：
  - write 失败场景下 optimistic 一定回滚
  - write 成功场景下 writeback/versionUpdate 行为与现状一致

---

## 7. 建议优先落地清单（简版）

1. `WriteCommitFlow` rollback 全覆盖（P0）
2. `WriteBatchRunner` 泛型化 + `WriteFlow` 去 `any`（P1）
3. `StoreFactory` 类型边界收敛（P1）
4. `ReadFlow` 小幅函数抽取与参数清理（P2）

