# Runtime 写链路短板评估与优化方案

## 1. 范围

本评估覆盖链路：

`runtime -> writeflow -> orchestrateWrite -> store/state -> indexes`

目标是基于当前实现，聚焦以下 5 个短板，并给出不改变对外行为前提下的优化方案。

---

## 2. 短板与方案总览

1. `pipeline.ts` 过重，职责密度高。  
对应方案：拆分为稳定子阶段模块，保留单入口编排。

2. optimistic 重复 id 分支仍有逐条 `state.apply`。  
对应方案：引入“单次 apply + 分步结果”内部能力，避免逐条提交。

3. runtime 层夹带业务语义（软删除字段拼装）。  
对应方案：删除语义下沉到策略/processor，不在 write pipeline 内硬编码。

4. `Catalog` 职责偏胖（session/reconcile/hydrate/remove 全集中）。  
对应方案：拆分为会话与执行器模块，Catalog 仅负责生命周期与路由。

5. 写链路类型断言仍较多。  
对应方案：补齐内部契约与类型守卫，压缩 `as` 使用面。

---

## 3. 详细方案

### 短板 1：`pipeline.ts` 过重

现状：`build/commit/reconcile` 虽已分函数，但仍在同一大文件，且夹杂大量局部 helper，阅读与变更成本高。

优化方案：

1. 保留单入口编排文件（例如 `pipeline.ts`），只保留阶段调用：
   - `preflight`
   - `hydrate`
   - `build`
   - `commit`
   - `reconcile`
2. 将阶段实现下沉到独立文件：
   - `write/stages/preflight.ts`
   - `write/stages/hydrate.ts`
   - `write/stages/build.ts`
   - `write/stages/commit.ts`
   - `write/stages/reconcile.ts`
3. 将纯工具函数集中到 `write/internal/*`，阶段文件仅保留阶段语义逻辑。

验收标准：

1. 入口文件行数显著下降（聚焦流程表达）。
2. 单阶段改动不需要触碰其他阶段文件。
3. 现有 benchmark 不回退。

---

### 短板 2：optimistic 重复 id 分支逐条 `apply`

现状：重复 id 时为保证逐条语义，走 `single[0] + state.apply(single)` 循环，存在额外函数调用和提交开销。

优化方案：

1. 在 core/store 增加内部能力：`applyStepwise`（内部命名可再收敛）。
2. 该能力在一次 map 可写会话中完成整批变更，并返回：
   - `finalChanges`（聚合后的最终变化）
   - `stepChanges`（按输入顺序的逐步变化，用于 optimistic 回滚与结果映射）
3. write `commit` 重复 id 分支改为单次调用，不再逐条 `state.apply`。

验收标准：

1. 重复 id 批次不再出现逐条 apply。
2. optimistic 回滚语义与现行为一致。
3. 重复 id 压测场景 CPU 时间下降。

---

### 短板 3：runtime 层混入业务语义（软删除）

现状：`delete` 分支中直接构造 `{ deleted, deletedAt }`，属于业务策略，不应在 runtime 通用流程硬编码。

优化方案：

1. 引入删除策略位于 processor/策略层（例如 `deletePolicy`）：
   - `hard`：物理删除
   - `soft`：逻辑删除
2. write pipeline 只表达“delete intent”，不拼业务字段。
3. 默认策略由 RuntimeConfig/StoreSchema 注入，runtime 不关心字段名。

验收标准：

1. pipeline 删除分支不包含业务字段硬编码。
2. 软删/硬删可通过配置切换。
3. 对外 API 与现有结果兼容。

---

### 短板 4：`Catalog` 职责偏胖

现状：`Catalog` 同时处理 store 构建、session API、reconcile/hydrate/remove 细节，文件和概念都偏重。

优化方案：

1. `Catalog` 只负责：
   - entry 生命周期管理
   - `ensure/use/inspect/list` 路由
2. 下沉 session 逻辑到 `store/session/*`：
   - `createSession`
   - `reconcileSession`
   - `hydrateSession`
   - `removeSession`
3. 将并发 writeback 执行器抽为独立函数，避免 Catalog 内部嵌套闭包过深。

验收标准：

1. `Catalog.ts` 行数与闭包层级下降。
2. session 逻辑可独立单测。
3. 行为与现有对齐。

---

### 短板 5：类型断言仍偏多

现状：写链路局部仍有 `as`（尤其在 `pipeline` 中），说明契约边界在类型系统中不够完整。

优化方案：

1. 补齐输入归一化函数的返回类型，使后续阶段拿到“已验证类型”。
2. 对 `remoteResult.data`、`intent.item`、`updater` 输出增加类型守卫函数，减少流程内断言。
3. `Row`/`WriteCtx` 分阶段收紧（例如阶段后字段改为必填的阶段态类型）。

验收标准：

1. 写链路关键文件 `as` 数量下降。
2. 断言失败类错误前移到 preflight/normalize 阶段。
3. 编译期能覆盖更多非法状态。

---

## 4. 实施优先级

P0（优先）：

1. 短板 1（pipeline 拆阶段）
2. 短板 2（重复 id 单次 apply）

P1（次优）：

1. 短板 4（Catalog 拆分）
2. 短板 5（类型收紧）

P2（按需）：

1. 短板 3（删除策略完全下沉），适合在你确认领域策略模型后落地。

---

## 5. 验证建议

每次改造按以下顺序执行：

1. `pnpm --filter atoma-runtime run typecheck`
2. `pnpm --filter atoma-core run typecheck`
3. `pnpm exec vitest bench bench/runtime-internal.bench.ts --run --reporter=verbose`
4. `pnpm typecheck`

