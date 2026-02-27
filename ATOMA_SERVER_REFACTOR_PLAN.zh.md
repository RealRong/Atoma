# Atoma Server 重构方案（基于 CODE_SIMPLIFIER）

## 1. 背景与目标

本方案覆盖 `packages/atoma-server` 及其服务端插件 `packages/plugins/atoma-backend-atoma-server`，目标是一次性收敛以下问题：

1. 安全与正确性问题（SQL 注入面、并发 CAS 失效、幂等竞态）。
2. 协议错误语义问题（应返回 4xx 的输入错误被错误映射为 500）。
3. 查询与分页语义不稳定（cursor/sort 解绑、nullable 排序字段行为不确定）。
4. CODE_SIMPLIFIER 指出的结构复杂度与重复代码问题（长函数、重复分支、死代码、请求期重复组装）。

重构要求：

1. 不做兼容别名，不保留双路径。
2. 保持架构边界（runtime 负责编排，adapter 负责持久化细节）。
3. 优先修复根因，不做临时兜底。

## 2. 范围与非目标

### 2.1 范围

1. `packages/atoma-server/src/query/*`
2. `packages/atoma-server/src/runtime/*`
3. `packages/atoma-server/src/error.ts`
4. `packages/atoma-server/src/ops/*`
5. `packages/atoma-server/src/adapters/{prisma,typeorm,shared}/*`
6. `packages/atoma-server/src/sync-rxdb/*`
7. `packages/plugins/atoma-backend-atoma-server/src/*`

### 2.2 非目标

1. 不改动公共协议模型定义（`atoma-types/protocol*`）字段语义。
2. 不引入新的后端实现（仅修复现有 Prisma/TypeORM 路径）。
3. 不在本轮引入跨包大迁移（例如将 server adapter 全量抽象为全新层）。

## 3. 优先级与执行顺序

执行顺序按风险与收益排序：

1. P0 安全与错误语义修复（必须先做）。
2. P1 并发一致性修复（CAS 与幂等）。
3. P2 查询分页语义修复。
4. P3 sync transport 边界强化。
5. P4 结构简化与代码清理（CODE_SIMPLIFIER）。

## 4. 详细改造项

## 4.1 P0 安全与错误语义（阻断级）

### 4.1.1 过滤字段 SQL 注入面收敛

问题：

1. `compileFilterToSql` 直接拼接 `field` 到 SQL 标识符，存在注入面。

目标文件：

1. `packages/atoma-server/src/query/compile.ts`

改造方案：

1. 新增字段 token 校验函数（仅允许安全标识符格式）。
2. 对来自 query filter 的 field 执行校验，不通过直接抛 `INVALID_FILTER`。
3. 参数占位符命名改为安全自增索引，不使用原始 field 字符串。

验收标准：

1. 恶意 field 输入返回 4xx，不会生成拼接 SQL。
2. 合法 field 不影响既有查询结果。

回归要点：

1. filter 单元测试新增注入 payload 样例。
2. TypeORM 查询集成测试覆盖非法字段路径。

### 4.1.2 JSON 解析与协议错误统一为 4xx

问题：

1. `JSON.parse` 异常未统一映射，最终落成 `INTERNAL/500`。
2. `errorStatus` 映射不完整，`PROTOCOL_*` 与 `INVALID_*` 容易落到 500。
3. `sync-rxdb/contracts` 抛裸 `Error`，上层默认映射为内部错误。

目标文件：

1. `packages/atoma-server/src/runtime/http.ts`
2. `packages/atoma-server/src/runtime/errors.ts`
3. `packages/atoma-server/src/error.ts`
4. `packages/atoma-server/src/sync-rxdb/contracts.ts`

改造方案：

1. 在 body 解析处捕获 `SyntaxError` 并转为 `INVALID_PAYLOAD` 或 `INVALID_REQUEST`。
2. 完整补齐 `errorStatus` 映射，对 validation/protocol 类错误收敛到 4xx。
3. `contracts.ts` 全部改为抛 `AtomaError`，附带 `kind: validation` 与 `path`。
4. 修复 `readJsonBodyWithLimit` 中超限异常被 `try/catch` 吞掉的问题。

验收标准：

1. 非法 JSON、非法 sort/filter/page、协议版本错误返回 4xx。
2. `PAYLOAD_TOO_LARGE` 在所有分支都能稳定触发。

回归要点：

1. `ops` 与 `sync-rxdb` 路由的错误状态码快照测试。
2. 针对 `incoming.body` / `incoming.json()` / `incoming.text()` 三路径体积限制测试。

## 4.2 P1 并发一致性（高优）

### 4.2.1 CAS 更新/删除改为原子条件写

问题：

1. `update/upsert/delete` 采用先读后写，最终写条件缺少 `version`，并发下可双成功。

目标文件：

1. `packages/atoma-server/src/adapters/prisma/PrismaAdapter.ts`
2. `packages/atoma-server/src/adapters/typeorm/TypeormAdapter.ts`

改造方案：

1. `update/delete` 统一使用 `id + expectedVersion` 条件写，并检查 `affected/count`。
2. `upsert(cas)` 在事务内执行条件更新，更新计数为 0 时返回冲突。
3. TypeORM 的 delete/update 必须显式检查 `affected`，避免 stale delete 假成功。

验收标准：

1. 同一 `id + baseVersion` 的并发写请求仅一个成功，另一个冲突。
2. stale delete 返回冲突，不再静默成功。

回归要点：

1. Prisma/TypeORM 各自并发测试。
2. create/update/upsert/delete 的冲突语义回归。

### 4.2.2 幂等键从“后记录”改为“先占位”

问题：

1. 当前流程是“先执行业务写，再写幂等记录”，并发同 key 可能重复写入业务数据。

目标文件：

1. `packages/atoma-server/src/ops/writeSemantics.ts`
2. `packages/atoma-server/src/adapters/prisma/PrismaSyncAdapter.ts`
3. `packages/atoma-server/src/adapters/typeorm/TypeormSyncAdapter.ts`

改造方案：

1. 事务开始先 `insert pending`（幂等键唯一约束）。
2. 抢占成功方继续业务写并更新 replay。
3. 抢占失败方读取既有 replay 直接返回。
4. 将“幂等键请求摘要校验”纳入同一流程，避免同 key 不同请求体污染。

验收标准：

1. 并发同 `idempotencyKey` 只落一次业务副作用。
2. 第二次请求稳定 replay 第一条结果。

回归要点：

1. 幂等并发压测。
2. 幂等冲突与 replay 分支测试。

### 4.2.3 `sync-rxdb/push` 非冲突错误不再伪装为冲突

问题：

1. 所有 `ok: false` 都被加入 `conflicts` 并返回 200，吞掉真实服务故障。

目标文件：

1. `packages/atoma-server/src/sync-rxdb/push.ts`

改造方案：

1. 仅 `error.kind === 'conflict'` 进入冲突路径。
2. 其他错误抛出标准错误响应（保持错误码与状态码语义一致）。

验收标准：

1. 非冲突异常返回 4xx/5xx，而非 `200 + conflicts`。
2. 真冲突行为保持不变。

回归要点：

1. mock adapter 内部错误与版本冲突两种场景。

## 4.3 P2 查询与分页语义（中高优）

### 4.3.1 cursor 与 sort 强绑定

问题：

1. cursor token 包含 sort，但 decode 后未校验与当前 query.sort 一致。

目标文件：

1. `packages/atoma-server/src/adapters/shared/keyset.ts`
2. `packages/atoma-server/src/adapters/prisma/PrismaAdapter.ts`
3. `packages/atoma-server/src/adapters/typeorm/TypeormAdapter.ts`

改造方案：

1. decode 后返回完整 payload（含 sort）。
2. 查询执行前校验 token.sort 与 effective sort 完全一致，不一致抛 `INVALID_QUERY`。

验收标准：

1. 改 sort 后复用旧 cursor 必须报错，不能静默返回错页数据。

回归要点：

1. 翻页过程中变更 sort 的失败用例。

### 4.3.2 nullable 排序字段策略显式化

问题：

1. keyset 值可能为 null，比较谓词行为不确定。

目标文件：

1. `packages/atoma-server/src/adapters/shared/keyset.ts`
2. `packages/atoma-server/src/adapters/prisma/PrismaAdapter.ts`
3. `packages/atoma-server/src/adapters/typeorm/TypeormAdapter.ts`

改造方案（二选一，建议 A）：

1. A：禁止 nullable 排序字段参与 cursor（遇 null 直接 `INVALID_QUERY`）。
2. B：实现 `NULLS FIRST/LAST` 等价条件（复杂度更高）。

验收标准：

1. 分页在 null 场景下行为可预测，不出现随机空页/重复。

回归要点：

1. 包含 null 的排序数据集翻页测试。

## 4.4 P3 插件 transport 边界强化（中优）

### 4.4.1 响应结构严格校验

问题：

1. `createSyncTransport` 对非法响应兜底为空数据，掩盖协议错误。

目标文件：

1. `packages/plugins/atoma-backend-atoma-server/src/sync/createSyncTransport.ts`

改造方案：

1. pull/push 响应做强校验，不合法即抛错，不做 `[]`/`0` 默认化。

验收标准：

1. 非法响应必须立即失败并暴露错误。

回归要点：

1. mock 200 + 非法 body，断言抛出协议错误。

### 4.4.2 SSE 错误可观测性

问题：

1. `source.onerror` 只重连不通知上层，错误不可观测。

目标文件：

1. `packages/plugins/atoma-backend-atoma-server/src/sync/createSyncTransport.ts`

改造方案：

1. `onerror` 先调用 `args.onError`，再执行重连流程。
2. 视噪声情况增加最小节流。

验收标准：

1. 网络异常时，上层能收到错误回调，同时重连机制保持有效。

回归要点：

1. 不可达 SSE 地址场景测试。

## 4.5 P4 CODE_SIMPLIFIER 结构优化（中低优）

### 4.5.1 大函数拆分与重复逻辑收敛

问题：

1. `executeWriteItemWithSemantics` 过长且分支多，维护成本高。
2. `sync-rxdb/contracts` 有重复分支解析逻辑。

目标文件：

1. `packages/atoma-server/src/ops/writeSemantics.ts`
2. `packages/atoma-server/src/sync-rxdb/contracts.ts`

改造方案：

1. 将写语义拆分为 `create/update/upsert/delete` 独立执行器。
2. 把重复的 push row 解析抽成单一路径（一次解析，多分支复用）。

验收标准：

1. 单函数长度与分支复杂度明显下降。
2. 行为与当前语义一致（由金丝雀测试保障）。

### 4.5.2 请求期重复开销下沉到初始化期

问题：

1. handler 每次请求都 `reduceRight` 组装插件链，存在稳定开销。

目标文件：

1. `packages/atoma-server/src/createAtomaHandlers.ts`

改造方案：

1. 在 handler 创建阶段预编排插件执行器，请求期仅注入上下文执行。

验收标准：

1. 插件执行顺序不变。
2. 请求路径闭包分配降低（可通过简单 benchmark 对比）。

### 4.5.3 清理死代码与语义歧义点

问题：

1. 未使用函数/文件增加认知负担。
2. `transactionApplied` 与真实执行语义不一致。

目标文件：

1. `packages/atoma-server/src/ops/opsExecutor/write.ts`
2. `packages/atoma-server/src/ops/opsExecutor/normalize.ts`
3. `packages/atoma-server/src/ops/getCurrent.ts`

改造方案：

1. 删除未引用代码（确认无外部发布面依赖后执行）。
2. 将 `transactionApplied` 改为真实批事务应用标志。

验收标准：

1. 无死代码残留。
2. 返回字段语义与实际执行一致。

## 5. 分阶段交付计划（建议）

### Phase 0：基线与保护网（0.5 天）

1. 先补关键回归测试骨架（注入、CAS 并发、幂等并发、错误码映射）。
2. 建立最小压测脚本（并发幂等与 CAS）。

交付物：

1. 新增测试文件与测试数据构造器。

### Phase 1：P0（1 天）

1. 完成注入面修复与错误码语义修复。
2. 合并 `sync-rxdb/contracts` 错误类型改造。

交付物：

1. 安全与错误语义修复 PR。

### Phase 2：P1（1.5-2 天）

1. 完成 Prisma/TypeORM CAS 原子改造。
2. 完成幂等预占位流程与 push 冲突分流。

交付物：

1. 并发一致性修复 PR（可按 adapter 拆分为 2 个 PR）。

### Phase 3：P2 + P3（1 天）

1. 修复 keyset cursor/sort 与 nullable 策略。
2. 强化 transport 响应校验与 SSE 错误上报。

交付物：

1. 查询分页与 transport 协议边界 PR。

### Phase 4：P4（1 天）

1. 长函数拆分、重复逻辑收敛、死代码清理、请求期开销优化。

交付物：

1. 结构优化 PR（不改变对外语义）。

## 6. 验证清单

每个阶段至少执行：

1. `pnpm --filter atoma-server run typecheck`
2. `pnpm --filter atoma-backend-atoma-server run typecheck`
3. `pnpm --filter atoma-server run build`
4. `pnpm --filter atoma-backend-atoma-server run build`

阶段结束执行：

1. `pnpm typecheck`
2. `pnpm test`

建议新增测试维度：

1. 安全：filter field 注入样例。
2. 协议：非法 payload/sort/page/filter/version 的状态码断言。
3. 并发：CAS 双写竞争、幂等键竞争。
4. 分页：sort 变更复用 cursor、nullable 排序翻页。
5. sync：push 非冲突错误传播、pull 非法响应失败、SSE onError 回调。

## 7. 风险与缓解

主要风险：

1. 错误码从 500 改为 4xx 可能影响已有客户端重试策略。
2. 幂等流程变更可能触发数据迁移需求。
3. cursor 策略收紧可能暴露历史调用方不规范用法。

缓解策略：

1. 在 PR 描述中明确“行为变更矩阵”（旧行为 vs 新行为）。
2. 对关键行为变更增加契约测试与变更日志。
3. 分阶段上线，先启用日志观测再全量切换。

## 8. 完成定义（Definition of Done）

1. 高优问题（P0 + P1）全部修复并有回归测试。
2. 不存在已知的输入错误误报 500 情况（明确豁免除外）。
3. CAS 与幂等在并发测试下符合预期。
4. 查询分页语义在 sort/cursor/null 场景下稳定。
5. CODE_SIMPLIFIER 指向的关键复杂度点完成收敛，且无行为回归。
6. 工作区 `pnpm typecheck` 与 `pnpm test` 通过。

