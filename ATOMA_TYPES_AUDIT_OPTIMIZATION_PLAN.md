# atoma-types 全量审计与优化方案（命名 / 参数 / 架构）

> 审计对象：`packages/atoma-types/src/**` 全部文件。  
> 审计目标：基于当前“降噪 + 职责分离 + 一步到位”的原则，识别仍可优化的命名、参数、架构点。  
> 备注：本文件仅给出方案，不包含代码改动。

---

## 0. 审计结论总览

- 文件总数：`74`
- `Runtime*` 前缀符号出现次数：`112`
- `any` 相关出现次数（含默认泛型与显式 any）：`117`
- `I*` 风格接口命名仍存在：`IStore`、`IBase`、`IEventEmitter`
- 明显“仅导出未消费”符号（仓内扫描）：
  - `SyncResolvedLaneConfig`
  - `ClientRuntime`
  - `IBase` / `BaseEntity`
  - `IEventEmitter`
  - `AtomaDebugEventMap`
  - `QueryParamsSummary`

---

## 1. 命名层可优化项

## 1.1 Runtime 子域前缀冗余（高优先级）

### 现状

- `runtime` 目录内大量类型仍使用 `Runtime*` 前缀（如 `RuntimeRead`、`RuntimeWrite`、`RuntimeEngine`、`RuntimeHookRegistry` 等）。
- 子域上下文已经表达 runtime 语义，前缀重复带来阅读噪音。

### 建议

- 在 `atoma-types/runtime` 子域内采用“短名本体”策略，避免重复前缀。
- 冲突在导入点用 type alias 解决，不在源头加噪音后缀。

### 涉及文件

- `packages/atoma-types/src/runtime/api.ts`
- `packages/atoma-types/src/runtime/hooks.ts`
- `packages/atoma-types/src/runtime/engine/*.ts`
- `packages/atoma-types/src/runtime/index.ts`

---

## 1.2 `I*` 接口风格与当前规范不一致（高优先级）

### 现状

- 仍存在 `IStore`、`IBase`、`IEventEmitter` 命名。
- 当前仓库整体以语义名词本体为主，不建议保留匈牙利式前缀。

### 建议

- 统一去掉 `I` 前缀。
- 若担心冲突，优先在消费端 alias，不在类型定义层加前缀。

### 涉及文件

- `packages/atoma-types/src/core/store.ts`
- `packages/atoma-types/src/core/entity.ts`
- `packages/atoma-types/src/core/events.ts`
- `packages/atoma-types/src/core/index.ts`
- `packages/atoma-types/src/runtime/api.ts`
- `packages/atoma-types/src/runtime/engine/relations.ts`
- `packages/atoma-types/src/client/client.ts`
- `packages/atoma-types/src/internal/storeBindings.ts`

---

## 1.3 术语并行（`storeName` / `store` / `resource`）需要规则化（中优先级）

### 现状

- core/runtime/client 中常用 `storeName` / `store`。
- protocol/sync 中常用 `resource`。
- 目前是“事实可理解但规则未显式化”，容易继续扩散混用。

### 建议

- 制定强约束：
  - store domain 统一 `storeName`（或 `store`，二选一）
  - protocol/transport domain 统一 `resource`
  - 跨域映射只在边界层发生一次


### 已落地（2026-02-10）

- Store domain 统一收敛到 `StoreToken` + `storeName`（core/runtime/client/devtools）。
- Protocol/Sync/Transport domain 统一收敛到 `ResourceToken` + `resource`/`resources`。
- 协议工具层（protocol-tools）参数上下文同步收敛为 `ResourceToken`。
- 跨域映射仍限制在边界适配层，不在类型层混用原始 `string`。
### 涉及文件（代表）

- `packages/atoma-types/src/core/store.ts`
- `packages/atoma-types/src/runtime/handle.ts`
- `packages/atoma-types/src/protocol/operation.ts`
- `packages/atoma-types/src/sync/outbox.ts`
- `packages/atoma-types/src/sync/transport.ts`

---

## 1.4 时间字段命名单位不一致（中优先级）

### 现状

- 混用 `timestamp`、`clientTimeMs`、`changedAtMs`、`enqueuedAtMs`、`nowMs`。
- 有的字段显式单位（`Ms`），有的字段无单位（`timestamp`）。

### 建议

- 统一策略：
  - Epoch 毫秒统一 `*Ms`
  - ISO 字符串统一 `*Iso` / `*AtIso`
- 在类型层统一，避免下游二次猜测。

### 涉及文件

- `packages/atoma-types/src/core/operation.ts`
- `packages/atoma-types/src/devtools/index.ts`
- `packages/atoma-types/src/runtime/api.ts`
- `packages/atoma-types/src/protocol/meta.ts`
- `packages/atoma-types/src/protocol/changes.ts`
- `packages/atoma-types/src/sync/outbox.ts`

---

## 2. 参数与类型收敛可优化项

## 2.1 `any` 暴露面仍偏大（高优先级）

### 现状

- `client/relations.ts`、`core/relations.ts`、`internal/storeBindings.ts`、`client/plugins/contracts.ts`、`observability/index.ts` 等仍有大量 `any`。
- 这些位置多在“接口边界”，会放大上游不确定性。

### 建议

- 优先替换为 `unknown` + 窄化策略。
- 默认泛型 `T = any` 收敛为 `T = unknown`（或去默认）。
- 对应断言函数保留在实现层，不把 `any` 上移到类型层。

### 重点文件

- `packages/atoma-types/src/client/relations.ts`
- `packages/atoma-types/src/core/relations.ts`
- `packages/atoma-types/src/internal/storeBindings.ts`
- `packages/atoma-types/src/client/plugins/contracts.ts`
- `packages/atoma-types/src/observability/index.ts`

---

## 2.2 内联 options 结构过多（中优先级）

### 现状

- 多处直接内联 `options?: { ... }`，缺少复用名词和统一语义。
- 内联结构难被复用和审计，易漂移。

### 建议

- 抽离稳定配置类型（命名表达意图，不表达实现细节）。
- 避免同义 options 在不同接口各自定义。

### 涉及文件（代表）

- `packages/atoma-types/src/runtime/api.ts`
- `packages/atoma-types/src/runtime/engine/operation.ts`
- `packages/atoma-types/src/core/store.ts`
- `packages/atoma-types/src/core/relations.ts`

---

## 2.3 可选参数过多但语义未分层（中优先级）

### 现状

- `IStore`（后续若重命名）中 `query?`、`queryOne?`、`fetchAll?` 为可选方法。
- 语义上存在“能力接口”和“基础接口”混叠。

### 建议

- 拆分为基础 store 能力 + query 扩展能力。
- 让可选能力通过组合接口表达，而不是单接口堆可选方法。

### 涉及文件

- `packages/atoma-types/src/core/store.ts`
- `packages/atoma-types/src/core/index.ts`

---

## 2.4 Query/Relation include 类型路径可进一步统一（中优先级）

### 现状

- `core/query.ts` 的 `include?: Record<string, Query<any>>`
- `core/relations.ts` 的 `RelationIncludeOptions` 另有一套 include 推导规则。
- 两套 include 体系语义有关联但类型层未统一抽象。

### 建议

- 提取统一 include 合同（query include vs relation include 的边界明确）。
- 减少 `Query<any>` 递归噪音，避免无限泛化。

### 涉及文件

- `packages/atoma-types/src/core/query.ts`
- `packages/atoma-types/src/core/relations.ts`
- `packages/atoma-types/src/client/relations.ts`

---

## 3. 架构层可优化项

## 3.1 写入模型重复定义（高优先级）

### 现状

- 相近写入结构在多处并存：
  - `protocol/operation.ts`（`WriteItem*`、`WriteOptions`）
  - `sync/outbox.ts`（`OutboxWriteItem*`）
  - `core/store.ts`（`WriteIntent*`）
- 字段含义高度重合，后续演进容易漂移。

### 建议

- 建立“单一写入合同中心”（建议以 protocol 为主合同源）。
- sync/core 在类型层通过映射/裁剪复用，避免平行定义。

### 涉及文件

- `packages/atoma-types/src/protocol/operation.ts`
- `packages/atoma-types/src/sync/outbox.ts`
- `packages/atoma-types/src/core/store.ts`

---

## 3.2 runtime API 聚合文件过重（中优先级）

### 现状

- `runtime/api.ts` 聚合了 processor/store/io/read/write/strategy/debug/runtime 全部类型。
- 命名与文件职责都偏“大而全”。

### 建议

- 按职责拆分：`io.ts`、`read.ts`、`write.ts`、`strategy.ts`、`debug.ts`、`runtime.ts`。
- `runtime/index.ts` 只做导出聚合。

### 涉及文件

- `packages/atoma-types/src/runtime/api.ts`
- `packages/atoma-types/src/runtime/index.ts`

---

## 3.3 hooks 事件载荷定义可结构化（中优先级）

### 现状

- `runtime/hooks.ts` 中事件名、payload、emit 方法并列定义，重复度高。

### 建议

- 使用 `HookPayloadMap` 作为唯一真相来源，派生：
  - `HookEventName`
  - `HookEmit`
  - `HookHandlers`
- 降低新增事件时的重复改动面。

### 涉及文件

- `packages/atoma-types/src/runtime/hooks.ts`

---

## 3.4 protocol-tools `http` 双导出风格冗余（低优先级）

### 现状

- `transport/http.ts` 同时导出路径常量与 `http.paths` 对象。
- 仓内实际消费主要是常量，不见 `http.paths` 使用。

### 建议

- 收敛到常量导出，移除无消费 facade。

### 涉及文件

- `packages/atoma-types/src/protocol-tools/transport/http.ts`
- `packages/atoma-types/src/protocol-tools/index.ts`

---

## 3.5 internal API 的类型边界可更强（中优先级）

### 现状

- `internal/storeBindings.ts` 中 `any` 与宽松类型较多。
- internal 是强耦合层，但仍应最小化不透明类型扩散。

### 建议

- 将 `any` 收敛为 `unknown` 或具体合同类型。
- `StoreBindings` 中 `ensureStore`、`relations` 输出可进一步约束。

### 涉及文件

- `packages/atoma-types/src/internal/storeBindings.ts`

---

## 4. 可直接清理的低风险项（基于仓内引用）

> 以下项在仓内基本无消费或仅自引用，可优先清理：

1. `SyncResolvedLaneConfig`
2. `ClientRuntime`
3. `IBase` / `BaseEntity`
4. `IEventEmitter`
5. `AtomaDebugEventMap`
6. `QueryParamsSummary`

备注：若计划保留“外部SDK潜在暴露”，仍建议先从 `index.ts` 导出面下线，再视需要彻底删除源定义。

---

## 5. 推荐落地顺序（按收益/风险）

## P0（高收益，优先）

1. 去 `Runtime*` 冗余前缀（runtime 子域）
2. 去 `I*` 接口前缀
3. 收敛 `any` 暴露（relations/internal/plugins/observability）
4. 清理仓内未消费导出

## P1（结构优化）

1. 拆分 `runtime/api.ts` 为多文件
2. hooks 改为 payload map 派生模型
3. 统一 store/resource 命名边界规则
4. 统一时间字段单位命名规则

## P2（深度收敛）

1. 写入模型跨 core/protocol/sync 合同统一
2. query include / relation include 类型体系统一
3. 清理 protocol-tools 无消费 facade（如 `http.paths`）

---

## 6. 变更校验建议

每个阶段完成后最小化校验：

- `pnpm --filter atoma-types typecheck`
- `pnpm --filter atoma-types build`

跨包连锁命名改动时追加：

- `pnpm --filter atoma-runtime typecheck`
- `pnpm --filter atoma-client typecheck`
- `pnpm --filter atoma-react typecheck`
- `pnpm --filter atoma-sync typecheck`
- `pnpm --filter atoma-history typecheck`
- `pnpm --filter atoma-devtools typecheck`

最后执行：

- `pnpm typecheck`

---

## 7. 最终建议（决策摘要）

如果本轮只做一轮“高价值收敛”，建议按以下组合执行：

1. runtime 子域全面去冗余前缀（保留 named export，冲突靠 type alias）
2. 核心合同去 `I*`，并清理无消费导出
3. 收敛 `any` 到 `unknown`，优先边界类型
4. 明确 `store`/`resource` 与 `*Ms` 命名规则并固化到 AGENTS

该组合能在不增加兼容包袱的前提下，显著降低类型噪音与后续维护复杂度。
