# Atoma Server 全量重构蓝图（零用户场景 / 一步到位）

## 1. 文档定位

本文是 `packages/atoma-server` 的**激进重构蓝图**，前提是：

1. 没有线上用户负担。
2. 不保留兼容层，不保留双路径。
3. 在尽可能保留能力（ops、query、write、sync pull/push/stream、幂等、插件扩展）的前提下，最大化降低复杂度。

本方案遵循根目录约束：`CODE_SIMPLIFIER.md` 与 `AGENTS.md`。

---

## 执行记录（持续更新）

执行日期：`2026-02-28`

1. [x] Phase 0 契约快照完成：
   - 新增 `ATOMA_SERVER_CONTRACT_SNAPSHOT.zh.md`
   - 新增目录 `atoma-server-contract-samples/`（请求/响应与错误样例）
2. [x] Phase 1 新骨架完成（不切换入口）：
   - 新建 `interface/application/domain/infra/shared` 分层目录
   - 新建最小骨架模块（可编译）
   - 新增层级依赖检查脚本 `packages/atoma-server/scripts/checkLayering.mjs`
   - 新增命令 `pnpm --filter atoma-server run check:layering`
3. [ ] Phase 2 进行中（已完成子项）：
   - 完成 `serializeErrorForLog` 重复实现收敛，统一到 `src/shared/logging/serializeError.ts`
   - 已替换调用点：`entry/response.ts`、`application/ops/writeResult.ts`、`domain/write/executeWriteItem.ts`
   - 完成 `normalizeId` 重复实现收敛，统一到 `src/shared/utils/id.ts`
   - 完成 `toThrowDetails` 重复实现收敛，统一到 `src/shared/utils/details.ts`
   - 新增错误映射 facade：`src/shared/errors/standardError.ts`
   - 已将运行时调用面收敛到 facade：`runtime/errors.ts`、`application/ops/{writeItemExecutor,writeResult}.ts`、`domain/write/{executeWriteItem,conflict}.ts`
   - `error.ts` 已拆分为 `shared/errors/{core,standardize,status}.ts`，根文件仅保留 facade 导出
   - `shared/errors/standardize.ts` 已继续拆分，`sanitizeDetails` 下沉到 `shared/errors/sanitizeDetails.ts`
4. [x] Phase 3 完成：
   - `ops` 主流程已下沉到 `application/ops/executeOps.ts`
   - `interface/http/createHandlers.ts` 已直接调用 `application/ops/executeOps.ts`
   - 旧入口包装已删除：`ops/opsExecutor/index.ts`
   - `application/ops/executeQueryOps.ts`、`application/ops/executeWriteOps.ts` 已改为应用层原生实现（不再桥接旧执行器）
   - 删除旧执行器文件：`ops/opsExecutor/{query,write,normalize,writeItemExecutor,writeResult}.ts`
   - `write options` 混合校验已移除 `JSON.stringify` 比较，改为 `shared/utils/object.ts` 的 `isDeepEqual`
   - 新增统一中间件执行器：`shared/middleware/compose.ts`，并替换 `ops` 与 route 响应插件链路的重复 compose 逻辑
   - 单一扩展协议已实装：`AtomaServerConfig.middleware[]`（`onRequest/onOp/onResponse/onError`）
   - 已删除旧扩展链路：`entry/pluginChain.ts`、`entry/hooks.ts`
   - `createHandlers` 路由装配已拆分为 `interface/http/{createHandlers,routeHandlers,configNormalization}.ts`，入口文件降为纯装配
   - `executeOps` 已拆分 `op{Trace,Limits,Middleware}.ts`，主流程文件降为单一编排
5. [ ] Phase 5 进行中（已完成子项）：
   - `sync-rxdb` 三条主流程已下沉到 `application/sync/{executePull,executePush,executeStream}.ts`
   - `sync-rxdb/contracts.ts` 的解析与错误提升已迁移到 `domain/contracts/syncRxdb.ts`
   - `application/sync/{executePull,executePush,executeStream}.ts` 已切换到 `domain/contracts/syncRxdb.ts`
   - `interface/http/createHandlers.ts` 已直接调用 `application/sync/*`，不再依赖 `sync-rxdb` 包装层
   - 旧包装层文件已删除：`sync-rxdb/{contracts,pull,push,stream,index}.ts`
7. [ ] Phase 7 进行中（入口切换已完成子项）：
   - 入口导出已切换到 `interface/http/createHandlers.ts`
   - 旧入口文件已删除：`createAtomaHandlers.ts`
8. [ ] 简化收口进行中（已完成子项）：
   - 删除未接入占位骨架：`interface/{middleware,routeMap,requestParser,responseWriter}`、`application/runtime`、`domain/query`、`shared/{types,error placeholders}`
   - 删除未接入 `infra/prisma/*` 骨架，避免与现有 `adapters/prisma/*` 形成双实现幻象
6. [x] Phase 4 完成：
   - 已按职责拆分写语义：`domain/write/{idempotency,changeLog,conflict,executeWriteItem}.ts`
   - 新增动作执行与契约模块：`domain/write/{applyWrite,types}.ts`，将 `create/update/upsert/delete` 与类型契约从 orchestrator 分离
   - 已继续拆分 `applyWrite` 语义热点：`write{Create,Update,Upsert,Delete}.ts` + `appendWriteChange.ts`
   - 调用点已切换：`application/ops/writeItemExecutor.ts`、`application/sync/executePush.ts`
   - 旧热点文件已删除：`ops/writeSemantics.ts`
   - 已补充专项语义测试：`packages/atoma-server/test/domain/write/executeWriteItem.test.ts`（并发 CAS、幂等 replay）
9. [ ] Phase 8 进行中（质量门禁子项）：
   - 新增 `executeWriteItem` P0 行为测试，覆盖“同 baseVersion 并发仅一成功”与“同 idempotencyKey 仅一次副作用且可重放”
10. [ ] Phase 6 进行中（已完成子项）：
   - `PrismaAdapter` 的 keyset/cursor 解析逻辑已下沉到 `adapters/prisma/keysetQuery.ts`
   - `PrismaAdapter.ts` 已从 `248` 行降至 `178` 行，主类职责收敛为适配器边界方法

验证记录：

1. `pnpm --filter atoma-server run check:layering`（通过）
2. `pnpm --filter atoma-server run typecheck`（通过）
3. `pnpm --filter atoma-server run build`（通过）
4. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过）
5. `pnpm --filter atoma-backend-atoma-server run build`（通过）
6. `pnpm --filter atoma-server run check:layering`（通过，第二轮）
7. `pnpm --filter atoma-server run typecheck`（通过，第二轮）
8. `pnpm --filter atoma-server run build`（通过，第二轮）
9. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第二轮）
10. `pnpm --filter atoma-backend-atoma-server run build`（通过，第二轮）
11. `pnpm --filter atoma-server run check:layering`（通过，第三轮）
12. `pnpm --filter atoma-server run typecheck`（通过，第三轮）
13. `pnpm --filter atoma-server run build`（通过，第三轮）
14. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第三轮）
15. `pnpm --filter atoma-backend-atoma-server run build`（通过，第三轮）
16. `pnpm --filter atoma-server run check:layering`（通过，第四轮）
17. `pnpm --filter atoma-server run typecheck`（通过，第四轮）
18. `pnpm --filter atoma-server run build`（通过，第四轮）
19. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第四轮）
20. `pnpm --filter atoma-backend-atoma-server run build`（通过，第四轮）
21. `pnpm --filter atoma-server run check:layering`（通过，第五轮）
22. `pnpm --filter atoma-server run typecheck`（通过，第五轮）
23. `pnpm --filter atoma-server run build`（通过，第五轮）
24. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第五轮）
25. `pnpm --filter atoma-backend-atoma-server run build`（通过，第五轮）
26. `pnpm --filter atoma-server run check:layering`（通过，第六轮）
27. `pnpm --filter atoma-server run typecheck`（通过，第六轮）
28. `pnpm --filter atoma-server run build`（通过，第六轮）
29. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第六轮）
30. `pnpm --filter atoma-backend-atoma-server run build`（通过，第六轮）
31. `pnpm --filter atoma-server run check:layering`（通过，第七轮）
32. `pnpm --filter atoma-server run typecheck`（通过，第七轮）
33. `pnpm --filter atoma-server run build`（通过，第七轮）
34. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第七轮）
35. `pnpm --filter atoma-backend-atoma-server run build`（通过，第七轮）
36. `pnpm --filter atoma-server run check:layering`（通过，第八轮）
37. `pnpm --filter atoma-server run typecheck`（通过，第八轮）
38. `pnpm --filter atoma-server run build`（通过，第八轮）
39. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第八轮）
40. `pnpm --filter atoma-backend-atoma-server run build`（通过，第八轮）
41. `pnpm --filter atoma-server run check:layering`（通过，第九轮）
42. `pnpm --filter atoma-server run typecheck`（通过，第九轮）
43. `pnpm --filter atoma-server run build`（通过，第九轮）
44. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第九轮）
45. `pnpm --filter atoma-backend-atoma-server run build`（通过，第九轮）
46. `pnpm --filter atoma-server run check:layering`（通过，第十轮）
47. `pnpm --filter atoma-server run typecheck`（通过，第十轮）
48. `pnpm --filter atoma-server run build`（通过，第十轮）
49. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十轮）
50. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十轮）
51. `pnpm --filter atoma-server run check:layering`（通过，第十一轮）
52. `pnpm --filter atoma-server run typecheck`（通过，第十一轮）
53. `pnpm --filter atoma-server run build`（通过，第十一轮）
54. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十一轮）
55. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十一轮）
56. `pnpm --filter atoma-server run check:layering`（通过，第十二轮）
57. `pnpm --filter atoma-server run typecheck`（通过，第十二轮）
58. `pnpm --filter atoma-server run build`（通过，第十二轮）
59. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十二轮）
60. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十二轮）
61. `pnpm --filter atoma-server run check:layering`（通过，第十三轮）
62. `pnpm --filter atoma-server run typecheck`（通过，第十三轮）
63. `pnpm --filter atoma-server run build`（通过，第十三轮）
64. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十三轮）
65. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十三轮）
66. `pnpm --filter atoma-server run check:layering`（通过，第十四轮）
67. `pnpm --filter atoma-server run typecheck`（通过，第十四轮）
68. `pnpm --filter atoma-server run build`（通过，第十四轮）
69. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十四轮）
70. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十四轮）
71. `pnpm vitest run packages/atoma-server/test/domain/write/executeWriteItem.test.ts`（通过，2 tests）
72. `pnpm --filter atoma-server run check:layering`（通过，第十五轮）
73. `pnpm --filter atoma-server run typecheck`（通过，第十五轮）
74. `pnpm --filter atoma-server run build`（通过，第十五轮）
75. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十五轮）
76. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十五轮）
77. `pnpm vitest run packages/atoma-server/test/domain/write/executeWriteItem.test.ts`（通过，2 tests）
78. `pnpm --filter atoma-server run check:layering`（通过，第十六轮）
79. `pnpm --filter atoma-server run typecheck`（通过，第十六轮）
80. `pnpm --filter atoma-server run build`（通过，第十六轮）
81. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十六轮）
82. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十六轮）
83. `pnpm vitest run packages/atoma-server/test/domain/write/executeWriteItem.test.ts`（通过，2 tests）
84. `pnpm --filter atoma-server run check:layering`（通过，第十七轮）
85. `pnpm --filter atoma-server run typecheck`（通过，第十七轮）
86. `pnpm --filter atoma-server run build`（通过，第十七轮）
87. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十七轮）
88. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十七轮）
89. `pnpm vitest run packages/atoma-server/test/domain/write/executeWriteItem.test.ts`（通过，2 tests）
90. `pnpm --filter atoma-server run check:layering`（通过，第十八轮）
91. `pnpm --filter atoma-server run typecheck`（通过，第十八轮）
92. `pnpm --filter atoma-server run build`（通过，第十八轮）
93. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十八轮）
94. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十八轮）
95. `pnpm vitest run packages/atoma-server/test/domain/write/executeWriteItem.test.ts`（通过，2 tests）
96. `pnpm --filter atoma-server run check:layering`（通过，第十九轮）
97. `pnpm --filter atoma-server run typecheck`（通过，第十九轮）
98. `pnpm --filter atoma-server run build`（通过，第十九轮）
99. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过，第十九轮）
100. `pnpm --filter atoma-backend-atoma-server run build`（通过，第十九轮）
101. `pnpm vitest run packages/atoma-server/test/domain/write/executeWriteItem.test.ts`（通过，2 tests）

---

## 2. 当前复杂度画像（代码事实）

> 以下数据基于当前 `packages/atoma-server/src` 统计（2026-02-28，第十九轮迁移后）。

1. 文件数：`62`
2. 总行数：`4242`
3. 复杂度热点（行数）：
   - `adapters/prisma/PrismaAdapter.ts`: `178`
   - `application/ops/writeItemExecutor.ts`: `177`
   - `application/sync/executePush.ts`: `176`
   - `adapters/prisma/writeUpsert.ts`: `152`
   - `adapters/prisma/prismaSyncIdempotency.ts`: `133`
   - `config.ts`: `132`
   - `application/sync/executePull.ts`: `132`
   - `entry/runWithRuntime.ts`: `129`
   - `adapters/prisma/PrismaSyncAdapter.ts`: `129`
   - `domain/write/executeWriteItem.ts`: `124`
   - `interface/http/routeHandlers.ts`: `122`
4. 分支密度热点（`if/for/switch/catch` 计数）：
   - `shared/errors/sanitizeDetails.ts`: `20`
   - `adapters/prisma/writeUpsert.ts`: `18`
   - `adapters/prisma/prismaSyncIdempotency.ts`: `16`
   - `runtime/http.ts`: `14`

### 2.1 复杂度根因（按优先级）

1. 写语义主链已拆分完成，热点已从 `domain/write` 转移到 `interface/http` 与 `adapters/prisma`。
2. Sync 语义分散：`pull/push/stream` 与 idempotency/change storage 紧耦合。
3. 扩展点模型与 route 装配已模块化，当前主要复杂度集中在 `writeItemExecutor` 与 `sync` 编排层。
4. 错误模型已拆分，但 `sanitizeDetails.ts` 分支数刚好压线（20），仍有下探空间。
5. 目录语义不稳定：同一业务流程跨 `entry/runtime/ops/sync/adapters` 多层跳转。

---

## 3. 重构总目标（无兼容包袱版本）

### 3.1 功能目标（保留）

1. 保留远程 `ops` 查询与写入能力。
2. 保留 `sync-rxdb` pull/push/stream 三路能力。
3. 保留幂等与冲突语义。
4. 保留分页（offset + cursor）能力。
5. 保留插件/钩子扩展能力（但收敛为单一扩展模型）。

### 3.2 复杂度目标（强约束）

1. 任何文件不超过 `250` 行。
2. 任何函数不超过 `60` 行。
3. 单文件分支计数不超过 `20`。
4. 删除重复工具函数（同语义只保留 1 处实现）。
5. `createAtomaHandlers` 收敛为纯装配入口（不承载业务分支）。

### 3.3 架构目标

1. 采用“单向分层 + 能力模块化”结构：`interface -> application -> domain -> infra`。
2. 业务语义（write/query/sync）不依赖 HTTP 细节。
3. Prisma 实现只在 infra 层，不渗透到 domain/application。

---

## 4. 目标架构（建议终态）

```text
packages/atoma-server/src
├── interface/http/
│   ├── createHandlers.ts
│   ├── configNormalization.ts
│   └── routeHandlers.ts
├── application/
│   ├── ops/
│   │   ├── executeOps.ts
│   │   ├── opTrace.ts
│   │   ├── opLimits.ts
│   │   ├── opMiddleware.ts
│   │   ├── executeQueryOps.ts
│   │   ├── executeWriteOps.ts
│   │   ├── normalize.ts
│   │   ├── writeItemExecutor.ts
│   │   └── writeResult.ts
│   └── sync/
│       ├── executePull.ts
│       ├── executePush.ts
│       └── executeStream.ts
├── domain/
│   ├── contracts/syncRxdb.ts
│   └── write/
│       ├── executeWriteItem.ts
│       ├── applyWrite.ts
│       ├── appendWriteChange.ts
│       ├── writeCreate.ts
│       ├── writeUpdate.ts
│       ├── writeUpsert.ts
│       ├── writeDelete.ts
│       ├── idempotency.ts
│       ├── conflict.ts
│       ├── changeLog.ts
│       └── types.ts
├── adapters/prisma/
│   ├── PrismaAdapter.ts
│   ├── keysetQuery.ts
│   └── ...
├── runtime/*
├── entry/*
├── shared/{errors,logging,utils}/*
├── config.ts
├── error.ts
└── index.ts
```

### 4.1 分层约束

1. `interface` 只做 HTTP 入参与出参，不做业务规则。
2. `application` 负责编排 use case，不做存储细节。
3. `domain` 负责业务语义与规则，不依赖 Prisma。
4. `infra` 只做持久化实现与事务。
5. `shared` 只放跨模块无业务语义工具。

---

## 5. 能力保持与收敛策略

### 5.1 OPS 能力

保留：

1. batch ops
2. query + write 混合请求
3. per-op traceId/requestId
4. limit 校验

收敛：

1. 删除 `query/write` 双执行器之间重复的插件错误封装。
2. `ops` 全部进入统一 pipeline：`parse -> validate -> dispatch -> format`。

### 5.2 写语义能力

保留：

1. create/update/upsert/delete
2. CAS / LWW
3. idempotency replay
4. appendChange

收敛：

1. 把 `writeSemantics.ts` 拆为 4 个纯语义模块：
   - `idempotency.ts`
   - `executeWriteItem.ts`
   - `conflict.ts`
   - `changeLog.ts`
2. `executeWriteItem` 只处理“单条写动作语义”，不处理 HTTP/result mapping。

### 5.3 sync-rxdb 能力

保留：

1. pull checkpoint
2. push conflict 文档回传
3. stream SSE notify

收敛：

1. `pull/push/stream` 只保留路由语义，解析与错误提升统一走 `domain/contracts/syncRxdb.ts`。
2. stream 的轮询策略与 SSE 输出协议拆分，避免业务与传输耦合。

### 5.4 插件/钩子能力

保留：

1. 请求级扩展
2. 响应级扩展
3. 错误级扩展
4. op 级扩展

收敛（一步到位，不做兼容）：

1. 删除 `hooks + route plugins + op plugins` 三套并存。
2. 引入单一扩展协议 `AtomaServerMiddleware`：
   - `onRequest`
   - `onOp`
   - `onResponse`
   - `onError`
3. 所有扩展通过同一个 `compose` 执行链。

---

## 6. 可删除与可替代清单

## 6.1 可删除（重构完成后）

1. `entry/` 下旧式 response/hook/pluginChain 拆分文件（由统一 middleware 替代）。
2. `ops/opsExecutor/` 下所有与 transport 强耦合的 mapper（下沉到 interface 层）。
3. 重复工具函数：
   - `serializeErrorForLog` 多实现
   - `normalizeId` 多实现
   - `toThrowDetails` 多实现
4. 任何“字符串化对比配置”的逻辑（`JSON.stringify` 比较 options）。

## 6.2 开源库替代建议（优先级）

1. `koa-compose`：替代自写 plugin/middleware compose。
2. `fast-deep-equal`：替代 `JSON.stringify` 深比较。
3. `serialize-error`：替代重复错误序列化函数。
4. `pino`（可选）：收敛 logger interface 实现。
5. `eventsource-encoder`（可选）：简化 SSE 序列化细节。

## 6.3 保留自研（不建议替代）

1. 写冲突语义（CAS/LWW）
2. 幂等 replay 语义
3. cursor token sort 一致性约束

---

## 7. 详细实施计划（不考虑重构成本）

## Phase 0：冻结契约（先做）

1. 生成能力契约快照（ops/sync 成功与失败样例）。
2. 固定错误码与状态码映射基线。
3. 明确保留字段与删除字段。

产物：

1. `ATOMA_SERVER_CONTRACT_SNAPSHOT.zh.md`
2. 协议样例 JSON（请求/响应）

验收：

1. 当前实现的行为快照可复现。

## Phase 1：搭建新骨架（不迁移逻辑）

1. 创建 `interface/application/domain/infra/shared` 目录骨架。
2. 建立 import 边界检查（禁止反向依赖）。
3. 新建统一中间件协议与 compose。

验收：

1. `pnpm --filter atoma-server run typecheck` 通过。
2. 新骨架编译通过但尚未接管流量。

## Phase 2：错误与日志先收敛（横切能力）

1. 集中化 `AtomaError`、`toStandardError`、`errorStatus`。
2. 集中化 `serializeError`。
3. 删除旧重复实现并替换调用点。

验收：

1. 全仓不存在重复 `serializeErrorForLog`。
2. 错误响应快照与 Phase 0 对齐。

## Phase 3：重写 application 层 ops pipeline

1. 新建 `executeOps` 主流程：
   - parse
   - validate
   - dispatch query/write
   - compose envelope
2. query/write 的 result mapping 移至 interface 层。
3. op plugins 改为 middleware `onOp`。

验收：

1. ops 请求功能等价。
2. 单文件不超 250 行。

## Phase 4：重写 domain 写语义

1. 拆分 `writeSemantics` 为四模块。
2. 明确状态机：
   - 读取/抢占幂等
   - 执行写语义
   - append change
   - 持久化 replay
3. 所有 adapter 异常统一映射。

验收：

1. 并发 CAS/幂等测试通过。
2. `writeSemantics.ts` 旧文件删除。

## Phase 5：重写 sync pipeline

1. `executePull/executePush/executeStream` 三条 use case 分离。
2. `sync contracts` 统一解析与 error lifting。
3. stream 轮询逻辑封装为 `waitForChanges` 服务。

验收：

1. pull/push/stream 契约等价。
2. 非冲突错误不会被吞成 200。

## Phase 6：重写 Prisma infra

1. `PrismaOrmAdapter` 只暴露领域接口，不暴露 Prisma 细节。
2. `queryRepo/writeRepo/idempotencyRepo/changeRepo` 分仓。
3. transaction 策略统一。

验收：

1. 所有写路径在事务语义下通过。
2. Prisma 相关代码只存在 `infra/prisma`。

## Phase 7：切换入口并删除旧架构

1. `index.ts` 指向新 `interface/http/createHandlers.ts`。
2. 删除旧 `entry/ops/sync-rxdb/runtime` 中已替代模块。
3. 清理所有过渡导出（一步到位）。

验收：

1. 旧路径 import 为 0。
2. `pnpm --filter atoma-server run build` 通过。

## Phase 8：收口与质量门禁

1. 补充并发、契约、错误语义、分页一致性测试。
2. 统计复杂度指标并对照目标。
3. 输出最终重构报告。

验收：

1. `pnpm --filter atoma-server run typecheck`
2. `pnpm --filter atoma-server run build`
3. `pnpm --filter atoma-backend-atoma-server run typecheck`
4. `pnpm --filter atoma-backend-atoma-server run build`
5. `pnpm typecheck`

---

## 8. 关键设计细节（必须落地）

### 8.1 统一请求生命周期

统一流水线：

1. `parseIncoming`
2. `validateContract`
3. `buildRuntimeContext`
4. `executeUseCase`
5. `mapResult`
6. `runMiddlewareAfter`

禁止：

1. 在 route handler 内嵌业务循环。
2. 在 use case 内直接操作 HTTP Response。

### 8.2 写入状态机（领域层）

状态机定义：

1. `Init`
2. `IdempotencyClaimed | ReplayHit`
3. `WriteApplied | WriteRejected`
4. `ChangeAppended`
5. `ReplayStored`
6. `Done`

要求：

1. 每个状态迁移只由一个模块负责。
2. 不允许在同模块内混合“状态迁移 + HTTP 结果拼装”。

### 8.3 错误模型

1. 领域错误：只包含 `code/kind/details`。
2. 接口错误：负责状态码映射与 envelope。
3. Infra 错误：必须先映射到领域错误，不可向上泄漏原始 DB 错误对象。

### 8.4 分页模型

1. cursor token 必须绑定 sort。
2. null 排序值策略固定（建议严格拒绝，返回 `INVALID_QUERY`）。
3. 所有 cursor encode/decode 在 `domain/query/cursor.ts` 唯一实现。

---

## 9. 文件级迁移清单（建议）

## 9.1 删除清单（重构后）

1. `packages/atoma-server/src/createAtomaHandlers.ts`
2. `packages/atoma-server/src/entry/*`
3. `packages/atoma-server/src/ops/opsExecutor/*`
4. `packages/atoma-server/src/ops/writeSemantics.ts`
5. `packages/atoma-server/src/sync-rxdb/*`
6. `packages/atoma-server/src/runtime/*`

> 上述删除以新架构对应模块替换完成为前提。

## 9.2 新增清单（核心）

1. `src/interface/http/createHandlers.ts`
2. `src/application/ops/executeOps.ts`
3. `src/domain/write/executeWriteItem.ts`
4. `src/domain/write/idempotency.ts`
5. `src/domain/sync/`（或 `application/sync/` 视职责切分）
6. `src/infra/prisma/*Repo.ts`

---

## 10. 验收与质量门槛

## 10.1 契约验收

1. ops: query/write 正常、冲突、参数错误、超限。
2. pull: checkpoint 翻页、空批次、非法请求。
3. push: create/update/delete、冲突、非冲突错误。
4. stream: 心跳、变更通知、断开重连。

## 10.2 一致性验收

1. 并发 CAS：同 baseVersion 仅一个成功。
2. 幂等：同 key 并发仅一次业务副作用。
3. replay：重复请求结果可重放。

## 10.3 复杂度验收

1. 文件最大行数 <= 250
2. 函数最大行数 <= 60
3. 无重复工具函数实现
4. 中间件扩展点仅 1 套机制

---

## 11. 重构期间的工程策略

1. 新旧并行仅存在于开发分支阶段，不对外导出。
2. 所有切换以“目录级替换”为单位，不做细碎兼容。
3. 每完成一个 Phase，立即运行受影响包 typecheck/build。
4. 最终一次性删除旧代码路径，避免长期双轨维护。

---

## 12. 决策建议（默认采用）

1. 默认采用单一扩展模型 `AtomaServerMiddleware`。
2. 默认引入 `koa-compose` 与 `fast-deep-equal`。
3. 默认保留 stream 能力，但重写为独立 use case。
4. 默认不保留任何旧 API 别名。
5. 默认以“能力等价 + 架构重置”作为验收标准，而非 diff 最小化。

---

## 13. 执行清单（可打勾）

1. [x] Phase 0 契约快照完成
2. [x] Phase 1 新骨架完成
3. [ ] Phase 2 错误与日志收敛完成
4. [x] Phase 3 ops pipeline 重写完成
5. [x] Phase 4 写语义状态机重写完成
6. [ ] Phase 5 sync pipeline 重写完成
7. [ ] Phase 6 Prisma infra 重写完成
8. [ ] Phase 7 入口切换与旧代码删除完成
9. [ ] Phase 8 全量验收完成
