# Atoma Server 文件排布与代码简化方案（基于 CODE_SIMPLIFIER）

## 1. 评估范围与方法

范围：

1. `packages/atoma-server/src/**` 全量文件。
2. 根目录约束文档：`CODE_SIMPLIFIER.md`、`AGENTS.md`。
3. 仅参考仓库根目录文档，不参考 `docs/`。

评估方法：

1. 以 `CODE_SIMPLIFIER` 的触发阈值为基线（函数长度、分支数量、重复逻辑）。
2. 结合静态引用检查（`rg`）识别零调用代码和无效配置面。
3. 输出按“问题 -> 修改建议 -> 收益 -> 风险 -> 验证方式”结构组织。

## 执行记录（持续更新）

执行日期：`2026-02-28`

1. [x] P0-1 删除 `ops/getCurrent.ts`（零调用）。
2. [x] P0-2 删除 `normalize.ts` 未使用导出：`normalizeRemoteOp`、`parseCursor`。
3. [x] P0-3 删除 `runtime/http.ts` 未使用导出：`readJsonBody`、`normalizePath`、`stripBasePath`。
4. [x] P0-4 删除 `query/compile.ts` 的 SQL 编译分支，仅保留 Prisma 编译路径。
5. [x] P0-5 删除 `AtomaServerConfig.sync.tables` 无效配置面。
6. [x] P1-1 拆分 `PrismaAdapter.ts`：查询/写入逻辑拆入 `adapters/prisma/query.ts`、`adapters/prisma/write.ts`，`PrismaAdapter` 收敛为装配入口。
7. [x] P1-2 拆分 `ops/opsExecutor/write.ts`：提取 `writeResult.ts`、`writeItemExecutor.ts`，执行编排与结果映射解耦。
8. [x] P1-3 拆分 `createAtomaHandlers.ts`：提取 `entry/response.ts`、`entry/hooks.ts`、`entry/pluginChain.ts`、`entry/runWithRuntime.ts`。
9. [x] P1-4 收敛 `sync-rxdb` 请求解析与错误提升：新增 `sync-rxdb/contracts.ts`，`pull/push` 复用统一契约。
10. [x] P2-1 收窄 `IOrmAdapter`：删除 `bulk*` 接口与 Prisma bulk 实现，删除 `writeSemantics` 的 bulk fallback。
11. [x] P2-2 删除 `writeSemantics.ts` 的可选 `claimIdempotency` 兼容分支，统一强依赖 `claimIdempotency`。
12. [x] P2-3 精简 `PrismaSyncAdapter.putIdempotency`：删除 update/create 多级 fallback，仅保留 `upsert` 路径（缺失即抛错）。

验收记录：

1. `pnpm --filter atoma-server run typecheck`（通过）
2. `pnpm --filter atoma-server run build`（通过）
3. `pnpm --filter atoma-backend-atoma-server run typecheck`（通过）
4. `pnpm --filter atoma-backend-atoma-server run build`（通过）

---

## 2. 当前结构诊断（代码事实）

### 2.1 体量与复杂度热点

`atoma-server` 当前代码总行数约 `4244` 行，热点集中在：

1. `adapters/prisma/PrismaAdapter.ts`：`735` 行，分支密度高。
2. `ops/writeSemantics.ts`：`545` 行，写语义分支与幂等等路径集中。
3. `createAtomaHandlers.ts`：`431` 行，入口编排与路由分发混合。
4. `ops/opsExecutor/write.ts`：`330` 行，嵌套闭包较深。
5. `adapters/prisma/PrismaSyncAdapter.ts`：`326` 行，幂等与变更轮询逻辑混合。

按 `CODE_SIMPLIFIER` 阈值（函数 >60 行、分支 >5）看，以上文件都触发“必须拆分评估”。

### 2.2 文件排布问题

1. `ops/` 下既有 `opsExecutor/*`，又有 `writeSemantics.ts`，写链路被拆在两个层次，语义索引不一致。
2. `query/` 目录仅 `compile.ts` 单文件，且文件内仍保留 SQL 编译分支（TypeORM 已移除）。
3. `runtime/http.ts` 混合“JSON 读取”与“URL basePath 工具”，职责不单一。
4. `sync-rxdb/pull.ts` 与 `sync-rxdb/push.ts` 的请求解析/错误包装逻辑重复。

### 2.3 零调用或无效能力（可删候选）

以下项在当前 `atoma-server/src` 内无调用，属于冗余面：

1. `ops/getCurrent.ts`（文件级零引用）。
2. `ops/opsExecutor/normalize.ts` 中：
   `normalizeRemoteOp`
   `parseCursor`
3. `runtime/http.ts` 中：
   `readJsonBody`
   `normalizePath`
   `stripBasePath`
4. `query/compile.ts` 中 `compileFilterToSql` 及配套 SQL 编译分支（`atoma-server` 内无调用）。
5. `config.ts` 的 `sync.tables` 配置（当前未被读取，属于无效配置面）。

---

## 3. 目标目录终态（建议）

建议把“按技术类型分组”改为“按业务流程分组”，降低跨文件跳转成本：

```text
packages/atoma-server/src
├── entry/
│   ├── createHandlers.ts
│   ├── routeDispatch.ts
│   └── pluginChain.ts
├── runtime/
│   ├── createRuntime.ts
│   ├── readBody.ts
│   └── errors.ts
├── ops/
│   ├── index.ts
│   ├── request/
│   │   ├── normalize.ts
│   │   └── limits.ts
│   ├── query/
│   │   └── execute.ts
│   └── write/
│       ├── execute.ts
│       ├── executeItem.ts
│       └── itemMapper.ts
├── sync/
│   └── rxdb/
│       ├── pull.ts
│       ├── push.ts
│       ├── stream.ts
│       └── contracts.ts
├── adapters/
│   ├── ports.ts
│   ├── prisma/
│   │   ├── query.ts
│   │   ├── write.ts
│   │   ├── bulk.ts
│   │   ├── model.ts
│   │   ├── sync.ts
│   │   └── index.ts
│   └── shared/
│       └── keyset.ts
├── error.ts
├── config.ts
└── index.ts
```

说明：

1. `createAtomaHandlers.ts` 建议改名并下沉到 `entry/`，入口职责更清晰。
2. `query/compile.ts` 若仅剩 Prisma 编译，应并入 `adapters/prisma/query.ts` 或 `ops/query/` 侧同域文件。
3. `sync-rxdb` 建议目录化为 `sync/rxdb/`，统一命名族，避免路径语义重复。

---

## 4. 详细优化建议（按优先级）

## P0（低风险，直接降噪）

### P0-1 删除 `ops/getCurrent.ts`（零调用）

问题：

1. 文件无任何引用，增加认知负担。

修改建议：

1. 直接删除 `packages/atoma-server/src/ops/getCurrent.ts`。

收益：

1. 立即减少无效 API 面和维护成本。

风险：

1. 若存在仓库外部私有依赖，会产生编译错误（可接受且可发现）。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. `rg -n "createGetCurrent" packages/atoma-server/src`

### P0-2 删除 `normalize.ts` 中未使用导出

问题：

1. `normalizeRemoteOp`、`parseCursor` 未被调用，形成“看似通用实则无用”的工具噪音。

修改建议：

1. 删除两个导出与相关实现，保留 `normalizeRemoteOpsRequest/ensureProtocolVersion/clampQueryLimit/isObject`。

收益：

1. 收敛请求归一化模块到真实职责。

风险：

1. 外部若直接引用会断裂（可通过版本升级说明处理）。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. `rg -n "normalizeRemoteOp|parseCursor" packages tests demo`

### P0-3 精简 `runtime/http.ts` 的无效工具

问题：

1. `readJsonBody`、`normalizePath`、`stripBasePath` 当前无调用。
2. 文件职责混合，读者难以快速判定核心路径。

修改建议：

1. 删除上述无调用函数。
2. 仅保留 `readJsonBodyWithLimit` 及其必要私有函数，或迁移到 `runtime/readBody.ts`。

收益：

1. 降低入口 I/O 认知面，减少无效 API。

风险：

1. 外部调用中断（同样属于可观测破坏）。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. `rg -n "readJsonBody\\(|normalizePath\\(|stripBasePath\\(" packages tests demo`

### P0-4 删除 `compileFilterToSql` 分支

问题：

1. TypeORM 已移除后，`compileFilterToSql` 及其 SQL 编译上下文无内部使用。
2. 在同文件同时维护 Prisma/SQL 两套编译，属于过度设计残留。

修改建议：

1. 删除 SQL 相关类型和函数：
   `SqlFilter`
   `SqlCompileContext`
   `compileFilterToSql`
   `compileSqlExpr`
   `joinSql`
   `resolveColumn`
   `assertSqlIdentifier`
2. 文件重命名为 Prisma 定向语义（如 `compilePrismaWhere.ts`）。

收益：

1. 直接降低分支与表意复杂度，减少未来误改风险。

风险：

1. 若外部引用 SQL 编译 API，需要同步迁移。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. `rg -n "compileFilterToSql" .`

### P0-5 删除无效配置 `sync.tables`

问题：

1. `config.ts` 暴露 `sync.tables`，但当前代码不读取该字段，属于“配置幻觉”。

修改建议：

1. 从 `AtomaServerConfig` 移除 `sync.tables` 定义。
2. 若确需 model 名覆盖，应放在 `AtomaPrismaSyncAdapter` 构造参数，不应挂在 server 顶层配置。

收益：

1. 避免用户误以为改配置会生效。

风险：

1. 外部已有配置字段会出现类型错误（有助于尽早发现无效配置）。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. 全仓 `rg -n "sync\\s*:\\s*\\{[^}]*tables" packages demo tests`

---

## P1（中风险，结构收敛）

### P1-1 拆分 `PrismaAdapter.ts`（735 行）

问题：

1. 查询、分页、单写、批写、错误映射、模型访问集中在单文件，超出可维护阈值。

修改建议：

1. 按职责拆成：
   `query.ts`（findMany + keyset）
   `write.ts`（create/update/upsert/delete）
   `bulk.ts`（bulk*）
   `model.ts`（delegate/select/error 共享）
2. 主类只做装配，不做细节实现。

收益：

1. 缩小每个文件变更半径，降低冲突率。
2. 更容易对高风险路径做局部测试。

风险：

1. 拆分时私有方法迁移可能引入调用断链。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. `pnpm --filter atoma-server run build`
3. 关键路径回归：query cursor、write CAS、sync push/pull。

### P1-2 拆分 `ops/opsExecutor/write.ts`（330 行）

问题：

1. 文件中多层闭包 + 事务降级 + 插件链 + item 映射耦合。
2. 局部 helper（如 `readIdempotency`）已无实际用途，存在逻辑漂移。

修改建议：

1. 目录化为：
   `ops/write/execute.ts`（编排）
   `ops/write/itemExecutor.ts`（单 item 执行）
   `ops/write/resultMapper.ts`（协议结果映射）
2. 移除未使用 helper，减少闭包嵌套。

收益：

1. 写链路逻辑清晰，便于定位冲突/幂等问题。

风险：

1. 拆分不当会改变日志上下文与错误封装时序。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. 对比 `write` 响应结构快照（成功/冲突/异常三类）。

### P1-3 拆分 `createAtomaHandlers.ts`（431 行）

问题：

1. 配置校验、运行时创建、response 转换、hook 安全调用、路由处理混在同文件。

修改建议：

1. 拆为：
   `entry/createHandlers.ts`
   `entry/routeDispatch.ts`
   `entry/pluginChain.ts`
   `entry/hookSafeInvoke.ts`
2. 保持 `createAtomaHandlers` 作为唯一公开入口。

收益：

1. 入口函数呈现 `parse -> prepare -> run` 主流程，符合 CODE_SIMPLIFIER。

风险：

1. 拆分时可能引入循环依赖（需保持单向依赖）。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. 手工回归四路由：`ops/pull/push/stream`。

### P1-4 收敛 `sync-rxdb` 重复解析逻辑

问题：

1. `pull.ts` 与 `push.ts` 都有 `parse*Request + wrapProtocolError + toThrowDetails` 重复模板。

修改建议：

1. 新增 `sync-rxdb/contracts.ts`，统一承载请求解析和错误提升。
2. `pull/push` 仅保留业务逻辑。

收益：

1. 错误语义统一，减少重复修改点。

风险：

1. 共享解析函数若签名设计不清会反向增复杂度。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. 非法 pull/push 请求回归（应返回 validation 4xx）。

---

## P2（中高风险，删过度设计）

### P2-1 收敛 `IOrmAdapter` 过宽接口（评估后执行）

问题：

1. `bulkCreate/bulkUpdate/bulkUpsert/bulkDelete` 在当前执行链中不是必要能力。
2. `writeSemantics` 对 `bulkCreate` 的 `as any` 兜底属于历史兼容分支。

修改建议：

1. 若确认无需外部依赖，删除 bulk 接口及 `writeSemantics` 的 bulk fallback。
2. 统一走单条语义 + 上层并发/事务编排。

收益：

1. 大幅减少 adapter 协议面，降低实现门槛与错误面。

风险：

1. 外部自定义 adapter 若依赖 bulk 能力会受影响。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. 对现有写入路径（create/update/upsert/delete）做回归。

### P2-2 移除“可选 claimIdempotency”兼容分支

问题：

1. `ISyncAdapter` 已要求 `claimIdempotency` 必选，但 `writeSemantics` 仍保留 `typeof sync.claimIdempotency !== 'function'` 分支。

修改建议：

1. 删除该兼容分支，直接调用 `claimIdempotency`。
2. 失败视为 adapter bug，显式抛错。

收益：

1. 减少死分支与“静默降级”。

风险：

1. 非规范 adapter 会直接失败（符合一步到位策略）。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. 幂等并发写入回归。

### P2-3 精简 PrismaSyncAdapter 的 put fallback 链

问题：

1. `putIdempotency` 目前支持 `upsert/update/create/update` 多级降级，复杂度高且行为不够透明。

修改建议：

1. 统一要求 `model.upsert`，缺失即抛配置错误。
2. 删除多级 fallback。

收益：

1. 行为确定性提升，路径可审计。

风险：

1. 依赖非常旧/非常规 Prisma 客户端的场景将不可用。

验证方式：

1. `pnpm --filter atoma-server run typecheck`
2. 幂等 claim/put/replay 全链路回归。

---

## 5. 冗余/过度设计可删清单

## 5.1 可立即删除（当前零引用或无效）

1. `packages/atoma-server/src/ops/getCurrent.ts`
2. `normalizeRemoteOp`、`parseCursor`
3. `readJsonBody`、`normalizePath`、`stripBasePath`
4. `compileFilterToSql` 及 SQL 编译相关实现
5. `config.sync.tables`

## 5.2 需迁移后删除（中风险）

1. `IOrmAdapter` 中 bulk 系列接口
2. `writeSemantics` 的 bulk fallback 与可选 claim fallback
3. `PrismaSyncAdapter.putIdempotency` 多级 fallback 逻辑

---

## 6. 建议执行顺序

1. Phase A（P0）：先删零调用与无效配置，控制变更面。
2. Phase B（P1）：再做目录拆分和重复逻辑收敛，保持行为不变。
3. Phase C（P2）：最后删除兼容式过度设计能力，收敛协议面。

---

## 7. 最小验收清单

每一阶段至少执行：

1. `pnpm --filter atoma-server run typecheck`
2. `pnpm --filter atoma-server run build`
3. `pnpm --filter atoma-backend-atoma-server run typecheck`
4. `pnpm --filter atoma-backend-atoma-server run build`
5. 关键链路手工回归：
   `ops query`
   `ops write`
   `sync-rxdb pull/push/stream`

---

## 8. 结论

`atoma-server` 当前已完成“去 TypeORM”方向的第一步，但代码结构仍有明显简化空间。  
按本方案推进后，目标是：

1. 降低单文件复杂度与跨层跳转成本。
2. 删除零价值 API 和过度兼容分支。
3. 收敛为 Prisma 单实现下更清晰、可验证、可维护的 server 内核。
