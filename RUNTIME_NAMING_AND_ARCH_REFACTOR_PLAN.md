# Runtime 命名与架构全面优化方案（一步到位）

> 范围：`packages/atoma-types/src/runtime/*`、`packages/atoma-runtime/src/runtime/*`、相关 `plugins/*` 调用面。  
> 目标：减少命名噪音、统一语义、降低类型/实现冲突、保持职责分离。  
> 原则：不做兼容层，不保留历史别名，直接收敛到最优形态。

---

## 1. 当前问题总结

1. `atoma-types/runtime/api.ts` 中 `RuntimeXXX` 前缀过多，语义重复（目录上下文已提供 runtime 语义）。
2. `StoreRegistry` 命名不统一，语义更像“目录/访问入口”而非“注册器”。
3. `runtime.transform` 对应实现类名 `DataProcessor` 与 `StoreDataProcessor` 概念混淆。
4. 类型名与实现类名易冲突（如 `RuntimeEngine` vs `Engine`），当前主要靠命名规避。
5. 命名体系缺少统一规则：何时保留 domain 前缀、何时使用短名、何时使用后缀。

---

## 2. 目标命名体系（最终形态）

## 2.1 核心规则

- 在 `atoma-types/runtime` 子域内，默认去掉 `Runtime` 前缀。
- 类型命名使用“领域名词本体”，不加 `Api`（除非跨域冲突不可避免）。
- 实现类与类型同名时，优先：
  - 保持 `named export`
  - 导入处用别名区分（`import type { Engine as EngineType } ...`）
- 不采用 `default export class` 作为冲突解决主手段。

## 2.2 推荐命名映射

| 当前命名 | 目标命名 | 说明 |
|---|---|---|
| `RuntimeIo` | `Io` | runtime 子域内无需重复前缀 |
| `RuntimeRead` | `Read` | 同上 |
| `RuntimeWrite` | `Write` | 同上 |
| `RuntimeTransform` | `Transform` | 同上 |
| `RuntimeDebug` | `Debug` | 同上 |
| `RuntimeStoreDebugSnapshot` | `StoreDebugSnapshot` | 保留语义、缩短前缀 |
| `RuntimeIndexDebugSnapshot` | `IndexDebugSnapshot` | 同上 |
| `RuntimeStrategyRegistry` | `StrategyRegistry` | 与实现名一致时用 type alias 区分 |
| `StoreRegistry` | `StoreCatalog` | 语义更准确（resolve/ensure/list） |
| `CoreRuntime` | `Runtime`（type） | 与实现类冲突处使用 `RuntimeType` 别名导入 |
| `RuntimeEngine` | `Engine`（type） | 与实现类冲突处用 `EngineType` 区分 |

> 说明：`CoreRuntime` 是否改为 `Runtime`（type）取决于你是否允许类型名与类名并存。若想减少冲突频率，可保留 `CoreRuntime`。

---

## 3. Transform 模块命名收敛

## 3.1 现状问题

- `DataProcessor`（runtime 实现类）与 core 的 `StoreDataProcessor` 语义邻近但层级不同，阅读成本高。

## 3.2 建议

- `packages/atoma-runtime/src/runtime/transform/index.ts`
  - `export class DataProcessor` -> `export class TransformPipeline`
- `Runtime.ts`
  - `this.transform = new TransformPipeline(this)`
- 类型层保留 `StoreDataProcessor`（用户配置对象），与 runtime 执行器明确分离。

## 3.3 命名边界

- `StoreDataProcessor`：用户提供的 per-store pipeline 配置。
- `TransformPipeline`：runtime 内部执行器（orchestrator）。

---

## 4. `StoreRegistry` 重命名方案

## 4.1 目标

- `StoreRegistry` -> `StoreCatalog`

## 4.2 理由

- 当前接口行为是访问目录：`resolve/ensure/list/onCreated/resolveHandle`。
- “Registry” 常被理解为“注册写入中心”，不够准确。

## 4.3 连锁改动点

1. `atoma-types/src/runtime/api.ts` 类型定义与导出。
2. `atoma-types/src/runtime/index.ts` re-export。
3. `atoma-runtime/src/store/Stores.ts` `implements` 类型更新。
4. `Runtime.ts` 字段类型更新。
5. 所有引用 `StoreRegistry` 的 import/type 注解。

---

## 5. 关于 `default export class` 的结论

结论：**不建议作为主策略**。

原因：
1. default export 仅缓解“导入名冲突”，不解决语义命名本身问题。
2. 会降低全局可检索性与一致性（任意命名导入）。
3. 不利于后续批量重构（尤其你们在做全仓结构收敛）。

推荐：
- 保持 `named export`。
- 用 TS 导入别名处理冲突：
  - `import type { Engine as EngineType } from 'atoma-types/runtime'`
  - `import { Engine } from '../engine'`

---

## 6. 分阶段落地计划（建议一次完成）

## Phase A：类型层重命名（源头统一）

1. 更新 `atoma-types/src/runtime/api.ts` 所有目标类型名。
2. 同步 `atoma-types/src/runtime/index.ts` 导出名。
3. 修正 `atoma-types/src/runtime/engine/*` 里的引用类型名。

验收：`pnpm --filter atoma-types typecheck && pnpm --filter atoma-types build`。

## Phase B：runtime 实现层对齐

1. `DataProcessor` -> `TransformPipeline`。
2. `Runtime.ts`、`ReadFlow.ts`、`WriteFlow.ts` 等类型导入改为新命名。
3. `StoreRegistry` 全量替换为 `StoreCatalog`。

验收：`pnpm --filter atoma-runtime typecheck && pnpm --filter atoma-runtime build`。

## Phase C：client/plugins 联动收口

1. `atoma-client` 及 `plugins/*` 中 runtime 类型导入切换。
2. 冲突处统一使用 `Type` 后缀别名导入，不新增包装类型。

验收：
- `pnpm --filter atoma-client typecheck`
- `pnpm --filter atoma-sync typecheck`
- `pnpm --filter atoma-history typecheck`
- `pnpm --filter atoma-devtools typecheck`

## Phase D：全仓清理

1. 搜索残留旧名并清零。
2. 更新文档中的旧术语。
3. 全仓 typecheck。

验收：`pnpm typecheck`。

---

## 7. 统一导入与冲突处理规范

1. 类型导入统一使用 `import type`。
2. 同名冲突统一规则：`XxxType`（仅冲突点使用）。
3. 不在源头增加无意义后缀（如全局加 `Api`）。
4. 不使用 `import * as Types`。

示例：

```ts
import type { Engine as EngineType, Runtime as RuntimeType } from 'atoma-types/runtime'
import { Engine } from '../engine'
import { Runtime } from './Runtime'
```

---

## 8. 性能与架构联动校验点

命名重构同时检查以下问题，避免“只改名不提质”：

1. 查询入口仍保持单主入口，不引入新分叉。
2. `changedIds` 仍在提交边界统一处理，不回散。
3. `runtime.debug` 继续保持轻量快照、避免重序列化。
4. `now()` 注入策略不被破坏，不回退到散落 `Date.now()`。
5. plugin capability 流程不新增二次 registry。

---

## 9. 风险与控制

## 主要风险

1. 跨包类型名重命名导致导入报错面广。
2. IDE 自动修复可能引入局部错误 alias。
3. 某些生成类型/构建入口遗漏更新。

## 控制策略

1. 严格按 Phase 顺序执行，先 `types` 再 `runtime` 再插件。
2. 每阶段独立 typecheck/build，失败立即就地修复。
3. 每次批量替换后做关键词扫描（旧名残留清零）。

---

## 10. 完成定义（DoD）

满足以下条件即视为本议题完成：

1. `runtime` 子域命名完成去噪，`RuntimeXXX` 冗余前缀显著减少。
2. `StoreRegistry` 全仓替换为 `StoreCatalog`（或你最终确认的目标名）。
3. `DataProcessor` 实现类更名为 `TransformPipeline`。
4. 无 `default export class` 引入的命名漂移；仍为 named export 体系。
5. 受影响包 `typecheck/build` 全通过。
6. 根目录文档与 AGENTS 规则同步到新命名口径。

---

## 11. 建议的最终选择（给决策用）

如果只选一套，建议采用：

- **命名风格**：短名本体（不用 `Api`）
- **导出风格**：named export（不用 default class）
- **冲突处理**：局部 `Type` 后缀 alias
- **关键重命名**：`StoreRegistry -> StoreCatalog`、`DataProcessor -> TransformPipeline`

这套方案与当前“降噪 + 职责分离 + 一步到位最优架构”目标最一致。
