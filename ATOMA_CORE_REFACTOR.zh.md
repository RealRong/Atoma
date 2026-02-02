# Atoma Core 优化建议（类型与命名空间）

> 目标：
> 1) 拆分并收敛 atoma-core 的类型职责，降低“单一 types.ts 承载所有概念”的复杂度。
> 2) 用命名空间明确职责边界，让使用者一眼知道“这是什么领域的能力”。
> 3) 提升内部文件排布的可读性与可维护性。

---

## 一、当前问题概览

### 1) types.ts 过于臃肿，职责混杂
- 目前 `packages/atoma-core/src/types.ts` 同时承载：
  - 实体/基础模型（Entity、BaseEntity）
  - Store API 与配置（IStore、StoreConfig、StoreOperationOptions）
  - Query 类型（Query、FilterExpr、PageSpec 等）
  - Relation 推导类型（WithRelations、RelationIncludeInput 等）
  - DataProcessor 管线类型
  - 历史/patch/事件等基础设施类型
- 结果是：用户要看清楚“核心能力的边界”很难，只能在一个大文件里找。

### 2) 全局扁平导出导致“职责无法区分”
- `src/index.ts` 基本“平铺式 re-export”，使用侧只能靠记忆区分来源。
- 同名概念混杂（如 Query 与 Store 的关联类型）缺少明确命名空间分层。

### 3) 核心类型里耦合到外部包
- `types.ts` 依赖 `atoma-observability`（Explain/DebugConfig）与 `jotai`（Atom）等。
- 这些依赖更偏“运行时/工具链/调试”，放进 core 会扩大核心依赖面。

---

## 二、建议的模块划分（文件排布）

建议把 `types.ts` 拆成职责明确的子模块，并以 **目录 + index 聚合** 的方式组织：

```
packages/atoma-core/src/
  index.ts
  types/
    entity.ts
    store.ts
    query.ts
    relations.ts
    operation.ts
    processor.ts
    events.ts
    index.ts
  query/
    index.ts
    ...
  store/
    index.ts
    ...
  relations/
    index.ts
    ...
  indexes/
    index.ts
    ...
  runtime/
    schema.ts
```

### 拆分建议
- `types/entity.ts`
  - Entity、BaseEntity、PartialWithId、KeySelector
- `types/store.ts`
  - StoreConfig、StoreOperationOptions、StoreReadOptions、IStore/StoreApi、WriteStrategy、WriteConfirmation/Timeout 等
- `types/query.ts`
  - Query、FilterExpr、SortRule、PageSpec、PageInfo、QueryResult/QueryOneResult、FetchPolicy
- `types/relations.ts`
  - RelationConfig/Map、Include 相关推导类型、BelongsTo/HasMany/HasOne/Variants
- `types/operation.ts`
  - OperationContext、OperationOrigin（PatchMetadata 迁移到 atoma-history）
- `types/processor.ts`
  - DataProcessorMode/Stage、DataProcessorContext、StoreDataProcessor
- `types/events.ts`
  - IEventEmitter、EventHandler

（HistoryChange/patch 元数据迁移到 atoma-history，不在 core 保留）

> 说明：
> - 这是“类型拆分”，不改语义，仅改结构。
> - 实现类/函数保留在原模块（store/query/indexes/relations 等）。

---

## 三、命名空间导出设计（核心目标）

现状：`index.ts` 直接 `export *`，几乎所有类型全扁平。

建议变为：

```
export * as Types from './types'
export * as Store from './store'
export * as Query from './query'
export * as Relations from './relations'
export * as Indexes from './indexes'
export * as Runtime from './runtime'
export * as Operation from './operation'
```

### 使用效果
- `Types.Entity` / `Types.StoreConfig` / `Types.QueryResult`
- `Store.StoreWriteUtils` / `Store.applyWritebackToMap`
- `Query.executeLocalQuery` / `Query.buildQueryMatcherOptions`
- `Relations.belongsTo` / `Relations.RelationResolver`

> 这样可以让职责“视觉上分区”，并降低全局名字冲突。

### 可选：保留少量“顶级快捷导出”
仅保留最常用的“模型级类型”作为顶层导出：
- Entity / StoreApi / StoreConfig
- Query / QueryResult / QueryOneResult

其余统一从命名空间访问，迫使调用者注意职责边界。

---

## 四、类型依赖与耦合的优化方向

### 明确“应拆到外部”的模块/能力（最终方案）
- **History 相关类型**：`HistoryChange` 与 `PatchMetadata` 迁移到 **atoma-history**。core 不再导出历史记录/patch 元数据相关类型。理由：已有独立 atoma-history，且这些类型依赖 `immer`/`jotai`，属于“历史/撤销”子域。
- **可观测性配置**：`StoreConfig` 的 `debug` / `debugSink` 迁移到 **atoma-observability**，并由 runtime/client 的 schema 扩展层注入。`QueryResult/QueryOneResult` 的 `explain` 类型也随之下沉（core 改为 `unknown` 或泛型占位），彻底解除 core 对 observability 的依赖。
- **运行时强绑定类型**：直接依赖 runtime I/O、handle、observability context 的类型继续留在 **atoma-runtime**，core 只保留纯逻辑与协议映射类型。

### 1) Observability 相关类型下沉
- `StoreConfig` 内的 `debug` / `debugSink` 从 core 移除，放到 **atoma-observability**，由 runtime/client 的 schema 扩展层注入。
- `QueryResult/QueryOneResult` 的 `explain` 类型从 core 下沉（改为 `unknown`/泛型，占位由 runtime/client 决定）。

### 2) Jotai / Atom 的类型耦合
- `PatchMetadata` / `HistoryChange` 迁移到 **atoma-history**，core 不再承载。

### 3) Query 类型过度耦合协议层
- `Query`/`FilterExpr` 直接别名 `atoma-protocol`。
- 建议：在 `types/query.ts` 明确为“协议映射类型”，避免误导为 core 内建概念。

---

## 五、内部模块职责可读性优化（不改逻辑，仅排布）

### Query
- `query/` 内可区分：
  - `engine/`（执行）
  - `matcher/`（匹配与解析）
  - `summary/`（展示/诊断）
  - `policy/`（缓存/策略）

### Indexes
- 将 `indexes/implementations/*` 视为“内部实现”，对外只暴露：
  - `StoreIndexes`
  - `IndexDefinition` / `IndexType` / `IndexStats`

### Relations
- 对外仅暴露 `builders` + `RelationResolver` + `projector`，其余均作为内部细节。

---

## 六、建议的迁移顺序（分阶段）

### 阶段 1：类型拆分 + index 聚合
- 把 `types.ts` 拆到 `types/*`，建立 `types/index.ts`。
- 先维持现有导出（仅增加命名空间，不移除顶层）。

### 阶段 2：收敛顶级导出
- 从 `src/index.ts` 删除大部分 `export *`。
- 强制使用 `Types.* / Query.* / Store.*`。

### 阶段 3：依赖下沉
- 逐步剥离 `atoma-observability`、`jotai` 的依赖。
- core 只保留纯逻辑类型与纯函数。

---

## 七、示例对比（期望风格）

### 现在（扁平式）
```ts
import { Entity, StoreConfig, executeLocalQuery, buildQueryMatcherOptions } from 'atoma-core'
```

### 期望（命名空间）
```ts
import { Types, Query } from 'atoma-core'

type User = Types.Entity
const matcher = Query.buildQueryMatcherOptions(...)
```

---

## 八、结论

- **类型拆分 + 命名空间导出** 是最能直接提升“可读性与新手理解成本”的核心动作。
- core 目前已经有清晰的模块边界（query/store/relations/indexes），只需要在导出层做“职责显性化”。
- 下一步重点是：**剥离运行时依赖与调试依赖**，让 core 真正成为“纯逻辑内核”。

如需，我可以按“阶段拆分”把具体的文件移动与导出表整理成执行清单。
