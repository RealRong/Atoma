# Client Runtime 为核心的优雅架构（Handle 瘦身版）

本文以“client runtime 为唯一上下文”为核心原则，重新设计 StoreHandle 瘦身后的架构形态，目标是：
- **降低耦合**：避免 handle 承载 runtime 能力
- **提升可读性**：参数传递清晰、职责边界明确
- **一步到位**：允许破坏式变更，直接达成目标结构

---

## 1. 核心原则

1) **单一上下文**：只保留一个 client 级上下文（以下简称 **ClientRuntime**）
2) **Handle 瘦身**：StoreHandle 只承载 store 级状态与业务契约
3) **Pipeline/ops 去 handle 化**：依赖 client/runtime 的能力必须通过 ClientRuntime 传入
4) **语义优先**：命名以“职责与边界”优先，避免 runtime/handle 混用造成歧义

---

## 2. 最终结构（目标形态）

### 2.1 ClientRuntime（唯一上下文）

**定位**：ClientRuntime 是全局运行时内核，负责跨 store 的能力注入与统一执行。

**职责建议**：
- `opsClient`（执行 ops）
- `observability` / `createObservabilityContext`
- `mutation`（pipeline 入口）
- `outbox`（同步队列）
- `resolveStore` / `Store` / `SyncStore`
- `debug` / `debugSink`（可选）

**语义好处**：
- 所有“跨 store 依赖”集中在一个上下文中
- Pipeline 与 ops 层不再猜测 handle 是否包含 runtime 能力

---

### 2.2 StoreHandle（瘦身后的 store 级契约）

**定位**：StoreHandle 只保留“store 自身状态 + store 业务契约”。

**推荐保留字段**：
- **状态**：`atom` / `jotaiStore` / `indexes`
- **身份**：`storeName` / `nextOpId`
- **业务**：`schema` / `transform` / `hooks`
- **写入策略（可选）**：`writePolicies`

**推荐移除字段**：
- `backend`
- `services`
- `observability` / `createObservabilityContext`
- 任何 runtime 级能力

**语义好处**：
- StoreHandle 变成“纯 store 级对象”，不再是跨层依赖容器

---

## 3. 模块依赖规则（统一传参模式）

统一调用规则：

```
(clientRuntime, storeHandle, ...)
```

### 3.1 Mutation Pipeline
- `MutationFlow`：`executeMutationFlow(clientRuntime, storeHandle, operations, ...)`
- `Persist`：`executeMutationPersistence(clientRuntime, storeHandle, program, ...)`
- `WriteOps`：`translateWriteIntentsToOps(storeHandle, intents)` + `executeWriteOps(clientRuntime, storeHandle, ops)`

### 3.2 Ops Executor
- `executeOps(clientRuntime, ops, context?)`
- `executeQuery(clientRuntime, storeName, nextOpId, params, context?)`
- `executeWrite(clientRuntime, storeName, nextOpId, args)`

### 3.3 Store internals
- 状态/Schema/Hook 仍走 `storeHandle`
- 与 ops/observability/outbox 相关的逻辑必须引入 `clientRuntime`

---

## 4. 命名规范（清晰且不冲突）

### 4.1 对外 API
- **保留**：`AtomaClient`（用户层概念明确）

### 4.2 对内上下文
- **推荐**：`ClientRuntime`
- **替代**：`ClientContext` / `ClientKernel`

**说明**：既然 runtime 已存在且被广泛使用，建议保留并强化“runtime = client 内核上下文”的含义，而不是改名造成二次成本。

---

## 5. 迁移路线（一步到位、允许破坏）

1) **瘦身 StoreHandle**：移除 backend/services/observability/createObservabilityContext
2) **强化 ClientRuntime**：补齐 opsClient/observability/outbox 等 runtime 级依赖
3) **重写 Pipeline/ops 的参数签名**：统一 `(clientRuntime, storeHandle, ...)`
4) **清理所有 handle 依赖点**：禁止再从 handle 取 runtime 能力
5) **更新 tests & docs**：保证新架构下链路一致

---

## 6. 预期收益

- **耦合显著降低**：模块只依赖清晰的上下文
- **调用链更直观**：一眼看清 runtime 注入位置
- **开源可读性提升**：读者无需追踪 handle 的“隐式能力”
- **扩展性更好**：后续新增 runtime 能力时无需污染 handle

---

## 7. 风险提示

- 这是破坏式重构，需全量更新调用链
- `nextOpId` 是否保持 store 级需谨慎评估
- observability/trace 需确保与 storeName 仍可关联

---

## 8. 结论

以 **ClientRuntime 为唯一上下文**，将 StoreHandle 瘦身为“纯 store 级契约”，是当前架构最清晰、最优雅、可读性最强的方向。它能最大化降低耦合，并让 pipeline/ops 的依赖关系显式化，符合开源项目的可理解性与可维护性要求。

---

## 9. 必须修改的文件与命名（行业规范版）

以下清单以“完整一步到位”为目标，命名以行业常见表达为准，避免替代式命名。

### 9.1 核心类型与创建入口

- `ClientRuntime`（保留，语义清晰，等价于 client kernel）\n
- `createRuntime(...)` → `createClientRuntime(...)`\n
- 变量 `runtime` → `clientRuntime`\n
\n
说明：对外 `AtomaClient` 保持不变，内部统一使用 `clientRuntime` 术语。\n

### 9.2 StoreHandle 瘦身相关

- `StoreHandle` 类型删除 runtime 字段：\n
  - 移除：`backend` / `services` / `observability` / `createObservabilityContext`\n
  - 保留：`atom` / `jotaiStore` / `indexes` / `storeName` / `nextOpId` / `schema` / `transform` / `hooks` / `writePolicies`\n
\n
说明：StoreHandle 只代表 store 自身，不再承载 client/runtime 能力。\n

### 9.3 Pipeline/ops 参数规范化

所有 pipeline/ops 函数统一 `(clientRuntime, storeHandle, ...)`：\n
- `executeMutationFlow(clientRuntime, storeHandle, ...)`\n
- `executeMutationPersistence(clientRuntime, storeHandle, ...)`\n
- `executeWriteOps(clientRuntime, storeHandle, ops)`\n
- `executeOps(clientRuntime, ops, context?)`\n
- `executeQuery(clientRuntime, storeName, nextOpId, params, context?)`\n
- `executeWrite(clientRuntime, storeName, nextOpId, args)`\n
\n
说明：runtime 能力全部从 clientRuntime 注入，禁止从 handle 获取。\n

### 9.4 具体文件修改点（路径级）

- `src/client/internal/create/createRuntime.ts`：\n
  - 改名为 `createClientRuntime` 并返回 `clientRuntime`\n
  - 变量与返回值命名统一 `clientRuntime`\n
\n
- `src/client/internal/create/buildClient.ts`：\n
  - `runtime` 变量改为 `clientRuntime`\n
  - 传入 History/Sync/Devtools 统一为 `clientRuntime`\n
\n
- `src/client/types/runtime.ts`：\n
  - 类型名保留 `ClientRuntime`\n
  - 所有字段描述改为 “client runtime/kernel 语义”\n
\n
- `src/core/types.ts`：\n
  - `StoreHandle` 移除 runtime 字段\n
\n
- `src/core/mutation/pipeline/*`：\n
  - 所有函数签名更新为 `(clientRuntime, storeHandle, ...)`\n
  - 禁止访问 `storeHandle.services/backend/observability`\n
\n
- `src/core/ops/opsExecutor.ts`：\n
  - 替换 `handle.backend.opsClient` 为 `clientRuntime.opsClient`\n
  - 签名改为 `executeOps(clientRuntime, ops, context?)`\n
\n
- `src/core/store/*`：\n
  - 所有涉及 runtime 能力的逻辑改为依赖 `clientRuntime`\n
  - `dispatch`/`outbox` 走 `clientRuntime.mutation` 与 `clientRuntime.outbox`\n
\n
- `src/client/internal/controllers/*`：\n
  - 所有 `runtime` 参数重命名为 `clientRuntime`\n
  - 与 pipeline/ops 调用统一新的签名\n
\n
### 9.5 禁止的替代式命名\n+
- 禁止使用 `handleSlim` / `handleLite` / `miniHandle` 等临时命名\n
- 统一使用 **`storeHandle`** 和 **`clientRuntime`**\n
