# API 降噪审计与优化清单（全仓）

> 首版时间：2026-02-09  
> 最后更新：2026-02-10  
> 原则：无兼容包袱、一步到位、优先收敛公开 API，同时清理内部 API 噪音。

## 0. 本轮落地状态（2026-02-10）

### 已完成 ✅

- **P0-1 删除 protocol-tools 死 facade 与死入口**
  - 已删除：
    - `packages/atoma-types/src/protocol-tools/ops/index.ts`
    - `packages/atoma-types/src/protocol-tools/core/error/index.ts`
    - `packages/atoma-types/src/protocol-tools/core/envelope/index.ts`
    - `packages/atoma-types/src/protocol-tools/ops.ts`
  - 已收敛：
    - `packages/atoma-types/src/protocol-tools/transport/sse/index.ts` 删除 `sse` 对象式 facade，仅保留命名导出。

- **P0-3 清理空读选项**
  - 已删除空类型：
    - `packages/atoma-types/src/core/store.ts` 中的 `StoreReadOptions`
  - 已收敛读 API 签名（移除 `options` 参数）：
    - `packages/atoma-types/src/core/store.ts`
    - `packages/atoma-types/src/runtime/api.ts`
    - `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
    - `packages/atoma-runtime/src/store/StoreFactory.ts`
    - `packages/atoma-react/src/hooks/useRelations.ts`

- **P0-2 清理未生效写选项**
  - 已删除无运行时消费的类型与字段：
    - `packages/atoma-types/src/core/store.ts` 中 `WriteConfirmation` / `WriteTimeoutBehavior`
    - `packages/atoma-types/src/core/store.ts` 中 `StoreOperationOptions.confirmation` / `timeoutMs` / `timeoutBehavior`

- **P0-4 删除单消费者内部 barrel**
  - 已改为直接文件导入：
    - `packages/atoma-runtime/src/runtime/Runtime.ts`
    - `packages/atoma-client/src/createClient.ts`
  - 已删除内部单消费者 barrel：
    - `packages/atoma-runtime/src/runtime/flows/index.ts`
    - `packages/atoma-runtime/src/runtime/registry/index.ts`
    - `packages/atoma-runtime/src/runtime/transform/index.ts`
    - `packages/atoma-runtime/src/store/index.ts`
    - `packages/atoma-client/src/plugins/index.ts`
    - `packages/atoma-client/src/defaults/index.ts`

### 未完成（下一步）

- `P0-5` 统一 `atoma-shared` 导出风格

## 1. 审计范围

- 核心包：`atoma-types` / `atoma-core` / `atoma-runtime` / `atoma-client` / `atoma-react` / `atoma-shared` / `atoma`
- 可选包：`atoma-server`、`packages/plugins/*`
- 审计对象：
  - 包导出面（`package.json#exports`、`src/*/index.ts`）
  - 公开类型 API（尤其 `atoma-types/*`）
  - 内部模块 API（barrel、wrapper、别名、重复抽象、未使用入口）

## 2. 结论摘要

当前已经完成一轮重要收敛（`changedIds` 下沉、mutation 收敛、`preserve` 外部配置移除），但仍存在三类噪音：

1. **死入口/死 facade**：文件存在但无引用，或仍保留对象式 facade（与当前命名导出原则冲突）
2. **空配置与未生效参数**：类型层暴露了大量“当前不生效”的参数
3. **内部层级过深**：单消费者 barrel、重复 wrapper、过宽导出

---

## 3. P0（可立即执行，低风险）

## P0-1 删除 protocol-tools 死 facade 与死入口（已完成 ✅）

### 现状

- 以下文件定义了对象式 facade，但仓库内无实际引用：
  - `packages/atoma-types/src/protocol-tools/ops/index.ts`（`ops`）
  - `packages/atoma-types/src/protocol-tools/core/error/index.ts`（`error`）
  - `packages/atoma-types/src/protocol-tools/core/envelope/index.ts`（`envelope`）
- `packages/atoma-types/src/protocol-tools/ops.ts` 为重复导出层，当前无引用。
- `packages/atoma-types/src/protocol-tools/transport/sse/index.ts` 里 `sse` 对象是额外 facade，命名导出已足够。

### 建议

- 仅保留命名导出函数与常量，删除对象 facade。
- 删除 `protocol-tools/ops.ts` 重复层。

### 收益

- 与“named exports only”完全一致。
- 减少多入口语义分叉。

---

## P0-2 清理未生效写选项（已完成 ✅）

### 现状

- `packages/atoma-types/src/core/store.ts` 中：
  - `WriteConfirmation`、`WriteTimeoutBehavior`
  - `StoreOperationOptions.confirmation/timeoutMs/timeoutBehavior`
- 当前运行时路径无消费逻辑。

### 建议

- 删除上述类型与字段，避免“看似可配置但无效”。

### 收益

- 降低误用与认知负担。

---

## P0-3 清理空读选项（已完成 ✅）

### 现状

- `StoreReadOptions` 为空类型，但读 API 全链路都挂着 `options?: StoreReadOptions`。
- 运行时实现中多数为 `_options` 未使用。

### 建议

- 删除 `StoreReadOptions` 及相关方法签名中的 `options` 参数。

### 收益

- 读 API 变短、语义更真实。

---

## P0-4 删除单消费者内部 barrel（已完成 ✅）

### 现状

- `atoma-runtime` 内部 barrel 仅被 `Runtime.ts` 单点使用：
  - `runtime/flows/index.ts`
  - `runtime/registry/index.ts`
  - `runtime/transform/index.ts`
  - `store/index.ts`
- `atoma-client/src/plugins/index.ts` 仅被 `createClient.ts` 使用。
- `atoma-client/src/defaults/index.ts` 当前无引用。

### 建议

- 改为直接文件导入，删除这些内部 barrel。

### 收益

- 减少跳转层级与重导出噪音。

---

## P0-5 统一 atoma-shared 导出风格

### 现状

- `packages/atoma-shared/src/index.ts` 同时导出：
  - namespace 形式（`errors`/`id`/`version`/`zod`）
  - named 形式（`toError`/`createId` 等）

### 建议

- 统一为 named-only（或 namespace-only，二选一，建议 named-only）。

### 收益

- 使用姿势唯一化，避免团队内混搭风格。

---

## 4. P1（中风险，建议尽快）

## P1-1 `atoma-types/core` 改显式导出

### 现状

- `packages/atoma-types/src/core/index.ts` 使用 `export *` 全量透传。

### 建议

- 改为显式命名导出，锁定导出面。

### 收益

- 防止内部类型意外外溢。

---

## P1-2 收窄 `atoma-types/client` 根入口

### 现状

- `client/index.ts` 聚合了过多类型域（plugins/ops/schema/client）。

### 建议

- `client` 根入口保留最核心类型，其他迁移到明确子域（如 `client/plugins`、`client/ops`）。

### 收益

- 减少“单入口过宽”的学习成本。

---

## P1-3 清理别名型类型 API

### 现状

- 纯别名 API：
  - `ClientPluginContext = PluginContext`
  - `SyncDriver = SyncTransport`
  - `SyncSubscribeDriver = SyncSubscribeTransport`
  - `StoreApi = IStore`

### 建议

- 逐步收敛到单一命名，避免双名并存。

### 收益

- 文档、示例、IDE 搜索都更统一。

---

## P1-4 收窄 `IndexesLike` 对外能力

### 现状

- `getIndexSnapshots` / `getLastQueryPlan` 主要由 devtools 使用。

### 建议

- 将调试能力迁到 devtools capability（或 internal binding），不放在普适 `IndexesLike` 上。

### 收益

- 核心索引接口回归最小职责。

---

## P1-5 HookRegistry 事件模型去重复

### 现状

- `HookRegistry` 存在多套并行 set + emit + has 分支。

### 建议

- 以 `EventMap` 驱动泛型注册与触发，减少样板。

### 收益

- 事件扩展时改动点更少，出错率更低。

---

## 5. P2（高收益但改动较大）

## P2-1 `WriteFlow` 内部 API 再压缩

### 现状

- `WriteFlow` 内部方法数量仍较多（context/payload/batch/commit 分层较深）。

### 建议

- 继续按“单主流程 + 小纯函数”重排：
  - one/many 批处理策略统一
  - patch/intent 生成逻辑进一步模块化

---

## P2-2 `createClient` 组装流程切片

### 现状

- `createClient.ts` 仍承担较多组装细节（plugin normalize/init/dispose/devtools/strategy wiring）。

### 建议

- 切为组装阶段函数（`buildRuntime`、`wirePlugins`、`wireStrategy`、`buildClientSurface`）。

---

## P2-3 RuntimeConfig 对外可配置项收窄

### 现状

- `Runtime` 目前只被 `createClient` 实例化，但 `RuntimeConfig` 仍暴露较多注入项。

### 建议

- 评估将 `hooks/strategy/engine` 注入从外部 API 收到内部组装层。

---

## 6. 可选包（server/plugins）降噪建议

## server

- `atoma-server` 根导出类型较多，建议进一步分层：
  - `server core API` 与 `adapter API` 分开，减少根入口宽度。

## plugins

- `atoma-sync` 侧若执行别名收敛（`SyncDriver` 等），插件类型同步改名。
- `atoma-devtools` 若索引调试能力内聚到 capability，插件改从 capability 拉取，不直接依赖泛型 core API。

---

## 7. 建议实施顺序

1. 先做 P0（死入口/空参数/内部 barrel）
2. 再做 P1（导出面收窄、别名收敛、HookRegistry 抽象）
3. 最后做 P2（WriteFlow/createClient/RuntimeConfig 架构型重排）

---

## 8. 验收标准

- 导出面：无死入口、无重复 facade、无空参数类型
- 类型面：无“同语义双命名”别名
- 内部面：关键模块层级减少，单文件职责更清晰
- 验证：`pnpm --filter atoma-types run typecheck`、`pnpm --filter atoma-core run typecheck`、`pnpm --filter atoma-runtime run typecheck` 全通过
