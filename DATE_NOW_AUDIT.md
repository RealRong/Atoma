# Date.now() 全仓审计与 `now` 注入替代方案

更新时间：2026-02-09

## 1) 扫描结果

- 扫描命令：`rg "Date\.now\(" -n --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/.git/**'`
- 命中总数：`43`
- 去除 `AGENTS.md` 规则文本后：`42` 处（`27` 个源码文件）

结论：
- **可直接替代为 `now` 函数**：绝大多数（业务时间戳、元数据时间、TTL 计算、轮询 deadline、缓存时间）
- **可保留 `Date.now()`**：仅极少数“熵兜底”场景（如随机 ID fallback）可不强制改

---

## 2) 已具备 `now` 注入能力（建议保持）

以下位置已经是“`now` 可注入 + `Date.now()` 兜底”的正确模式，无需结构性改造：

- `packages/atoma-client/src/plugins/PluginRuntimeIo.ts:21`
- `packages/atoma-runtime/src/runtime/Runtime.ts:58`
- `packages/atoma-server/src/ops/writeSemantics.ts:133`
- `packages/atoma-types/src/protocol-tools/ops/build.ts:12`
- `packages/atoma-types/src/protocol-tools/ops/meta.ts:21`
- `packages/plugins/atoma-sync/src/plugin.ts:21`
- `packages/plugins/atoma-sync/src/transport/ops-driver.ts:15`
- `packages/plugins/atoma-sync/src/storage/index.ts:23`
- `packages/plugins/atoma-sync/src/storage/outbox-store.ts:64`
- `packages/plugins/atoma-sync/src/engine/sync-engine.ts:338`
- `packages/plugins/atoma-sync/src/internal/replica-id.ts:22`
- `packages/atoma-shared/src/id.ts:83`

---

## 3) 建议优先替换为 `now`（P0：核心链路）

### 3.1 atoma-core

1. `packages/atoma-core/src/store/mutation.ts:14`
2. `packages/atoma-core/src/store/mutation.ts:34`
3. `packages/atoma-core/src/store/mutation.ts:35`
4. `packages/atoma-core/src/operation.ts:13`
5. `packages/atoma-core/src/indexes/plan.ts:101`
6. `packages/atoma-core/src/indexes/plan.ts:271`

建议：
- `store/mutation` 的 `init/merge` 增加 `now?: () => number`（或 options.now）
- `createOperationContext` 增加 `now?: () => number`（默认 `Date.now`）
- `planCandidates` 增加 `now?: () => number`（写入 plan.timestamp）

收益：
- core 完全纯化，时间源由 runtime 注入
- 测试可控（稳定快照）

### 3.2 atoma-server

1. `packages/atoma-server/src/ops/opsExecutor/index.ts:242`
2. `packages/atoma-server/src/ops/opsExecutor/write.ts:507`
3. `packages/atoma-server/src/runtime/errors.ts:17`
4. `packages/atoma-server/src/ops/subscribeExecutor.ts:46`
5. `packages/atoma-server/src/ops/subscribeExecutor.ts:59`
6. `packages/atoma-server/src/ops/subscribeExecutor.ts:93`

建议：
- 在 server runtime/config 增加统一 `now?: () => number`
- ops 执行器、错误格式化、subscribe 循环统一走同一 `now`

收益：
- server 端 trace/meta/time 语义一致
- e2e 测试可冻结时钟

### 3.3 atoma-server 适配器（Prisma/Typeorm）

- `packages/atoma-server/src/adapters/prisma/PrismaSyncAdapter.ts:56`
- `packages/atoma-server/src/adapters/prisma/PrismaSyncAdapter.ts:79`
- `packages/atoma-server/src/adapters/prisma/PrismaSyncAdapter.ts:174`
- `packages/atoma-server/src/adapters/prisma/PrismaSyncAdapter.ts:175`
- `packages/atoma-server/src/adapters/typeorm/TypeormSyncAdapter.ts:59`
- `packages/atoma-server/src/adapters/typeorm/TypeormSyncAdapter.ts:79`
- `packages/atoma-server/src/adapters/typeorm/TypeormSyncAdapter.ts:200`
- `packages/atoma-server/src/adapters/typeorm/TypeormSyncAdapter.ts:201`

建议：
- 构造参数增加 `now?: () => number`
- TTL 过期判断、`createdAt/expiresAt`、`waitForChanges` deadline 全部走 `this.now()`

收益：
- 存储适配层行为与 server/runtime 时钟对齐

---

## 4) 建议替换为 `now`（P1：外围模块）

### 4.1 atoma-backend-http

- `packages/plugins/atoma-backend-http/src/internal/batch/batch-engine.ts:191`
- `packages/plugins/atoma-backend-http/src/ops-client.ts:93`
- `packages/plugins/atoma-backend-http/src/ops-client.ts:160`
- `packages/plugins/atoma-backend-http/src/ops-client.ts:182`

建议：
- `HttpOpsClientConfig` 增加 `now?: () => number`
- `BatchEngine` 构造参数加 `now`，组包 `clientTimeMs` 使用注入时钟
- `fetchWithRetry` 透传 `now`，用于 `startedAt/elapsed`

### 4.2 atoma-react / devtools

- `packages/atoma-react/src/hooks/useRelations.ts:95`
- `packages/atoma-react/src/hooks/useRelations.ts:108`
- `packages/plugins/atoma-devtools/src/runtime/registry.ts:62`
- `packages/plugins/atoma-devtools/src/runtime/inspector.ts:6`
- `packages/plugins/atoma-devtools/src/runtime/runtime-adapter.ts:52`

建议：
- hook/devtools 接收可选 `now`（默认 `Date.now`）
- 或从 runtime/context 读取统一时钟后透传

---

## 5) 可保留 `Date.now()` 的场景（P2）

- `packages/atoma-shared/src/id.ts:23`

说明：
- 该处是随机 ID 的“熵兜底”路径（与 `Math.random()` 组合），在无 `crypto.randomUUID` 环境才使用
- 可改造成接收 `now`，但收益低于核心链路改造，优先级可后置

---

## 6) 推荐统一策略（一步到位）

建议统一为三层时间策略：

1. `runtime.now` 作为唯一业务时钟入口（client/runtime/server）
2. core 与 adapter 只接收 `now` 注入，不直接调用 `Date.now()`
3. 极少数底层熵兜底（ID fallback）可保留 `Date.now()`，或显式标注为 `systemNow`

---

## 7) 最小落地顺序

1. **P0**：`atoma-core` + `atoma-server`（含 Prisma/Typeorm adapters）
2. **P1**：`atoma-backend-http` + `atoma-react` + `atoma-devtools`
3. **P2**：`atoma-shared/id` fallback 是否注入（可选）

