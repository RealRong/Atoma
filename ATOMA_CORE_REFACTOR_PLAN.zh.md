# atoma-core 改造方案（简化组件 + 保持可读性）

目标：在**不牺牲可读性**的前提下，减少不必要的组件层级与跳转，让新人能通过“功能入口 → 子模块 → 细节实现”的路径快速理解 atoma-core。

---

## 1. 当前模块结构（简述）

- `store/`：写入逻辑与写回（writeback）、乐观更新、write op 构造、事件类型。
- `query/`：本地查询、normalize、matcher、游标分页与 summarize。
- `indexes/`：索引定义、候选集计算与应用。
- `relations/`：关系编译与投影。
- `operationContext.ts`：操作上下文（actionId、scope、origin）。

结构清晰，但**组件过多、职责拆得偏细**，导致新人在理解流程时被迫多次跳转。

---

## 2. 可简化/可合并的组件点（不牺牲可读性）

### 2.1 Query 逻辑合并（优先级高）

**现状**：
- `QueryMatcher`、`engine/local.ts`、`localEvaluate.ts`、`matcherOptions.ts` 分散。
- 新人很难一次性理解“query 的完整执行路径”。

**建议**：
- 将 query 执行收敛为一个入口函数，内部包含 matcher + normalize + 排序/分页：
  - 形态建议：
    ```ts
    executeLocalQuery({
      mapRef,
      query,
      indexes,
      matcher,
      emit,
      explain
    })
    ```
- `QueryMatcher` 不必独立为单独文件，可合并进 `query/engine/local.ts` 或 `query/engine/matcher.ts`。
- `localEvaluate.ts` 可以内联进 `engine/local.ts`，只保留一个“带索引 + 无索引”的入口。

**收益**：
- 查询执行路径从 4 个文件降为 1~2 个文件。
- 对新人更友好：只看 `executeLocalQuery` 即可理解全流程。

**保留点**：
- `normalize.ts` 仍可保留（明确“输入清洗”职责）。
- `cursor.ts` 保持独立（通用工具）。

---

### 2.2 Index 系统层级简化（优先级中）

**现状**：
- `IndexManager` 与 `StoreIndexes` 的职责高度重叠。
- `StoreIndexes` 基本是薄包装。

**建议**：
- 合并 `IndexManager` 与 `StoreIndexes`，只保留一个实体类（建议叫 `StoreIndexes` 或 `IndexSet`）。
- 索引候选集/查询计划/统计方法统一放在同一个类里。
- `base/IIndex` 可保留，但文件层级可降低（如 `indexes/IIndex.ts`）。

**收益**：
- 新人只需要理解一个“索引容器类”。
- 减少“Manager/Wrapper”认知成本。

---

### 2.3 store 写入模块归类（优先级中）

**现状**：
- `writeOps`、`writeEvents`、`optimistic`、`writeback`、`StoreWriteUtils` 平铺在同层。

**建议**：
- 建立 `store/write/` 子目录，把写入相关组件集中：
  - `store/write/ops.ts`（原 `writeOps`）
  - `store/write/events.ts`（原 `writeEvents`）
  - `store/write/optimistic.ts`
  - `store/write/writeback.ts`
  - `store/write/utils.ts`（原 `StoreWriteUtils`）
- `idGenerator.ts` 可保持在 `store/` 顶层。

**收益**：
- 新人理解写入时，只需进入一个目录。
- 更清晰的“读写分离”心智模型。

---

### 2.4 OperationContext 的轻量化（可选）

**现状**：
- `operationContext.ts` 仅提供 create/normalize，用途单一。

**建议**：
- 如果不想新增模块，可保持现状。若想更简洁：
  - 改名为 `operation.ts`，与 core 的命名空间一致。
  - 或者将 `createActionId` / `normalizeOperationContext` 合并为一个方法（减少 API 表面）。

---

## 3. 推荐的目录排布（最终形态）

```
packages/atoma-core/src/
  store/
    idGenerator.ts
    write/
      ops.ts
      events.ts
      optimistic.ts
      writeback.ts
      utils.ts
    index.ts

  query/
    engine/
      local.ts        // 集成 matcher + normalize + page/sort
    normalize.ts
    cursor.ts
    summary.ts
    index.ts

  indexes/
    IIndex.ts
    Indexes.ts        // 合并 IndexManager + StoreIndexes
    implementations/
      StringIndex.ts
      TextIndex.ts
      NumberDateIndex.ts
      SubstringIndex.ts
    validators.ts
    tokenizer.ts
    utils.ts
    index.ts

  relations/
    RelationResolver.ts
    builders.ts
    compile.ts
    projector.ts
    utils.ts
    index.ts

  operation.ts
  index.ts
```

---

## 4. 简化后的核心流程（新人视角）

### 4.1 Query
1. `Query.executeLocalQuery(...)`（唯一入口）
2. `normalizeQuery` -> `apply matcher/filter` -> `sort/page` -> `select`
3. （可选）索引候选集/计划记录

### 4.2 Write
1. `store/write/ops.ts` 生成 WriteOpSpec
2. `store/write/optimistic.ts` 计算乐观结果
3. `store/write/writeback.ts` 应用写回

---

## 5. 可移除或合并的具体组件清单（建议级别）

- ✅ `localEvaluate.ts` → 合并进 `query/engine/local.ts`
- ✅ `QueryMatcher.ts` → 合并进 `query/engine/local.ts` 或 `query/engine/matcher.ts`
- ✅ `IndexManager.ts` + `StoreIndexes.ts` → 合并成 `indexes/Indexes.ts`
- ✅ `StoreWriteUtils.ts` → 移动为 `store/write/utils.ts`

**保持不动（推荐）**：
- `normalize.ts` / `cursor.ts`（职责清晰且通用）
- `relations/*`（结构已清晰）

---

## 6. 迁移顺序建议（最少痛感）

1. Query 合并（影响面最小，收益最大）
2. Index 合并（需要改一层封装引用）
3. store/write 归类（只动 import 路径）
4. OperationContext 改名（可选）

---

## 7. 风险与注意事项

- 合并 QueryMatcher 与 engine/local 时，注意 matcherOptions 的依赖（目前由 runtime 用于 build）。建议 matcherOptions 继续保留为 query/index 的公开函数。
- Index 合并后，保持 `collectCandidates` / `getLastQueryPlan` API 不变，避免 runtime/indexes 侧改动。
- store/write 重排时注意 runtime 依赖路径与测试中的路径。

---

## 8. 结论

结构已经足够作为基础架构，主要优化空间在**目录组织与入口整合**。如果你希望进一步“少文件、少跳转、流程直观”，建议优先完成 Query 与 Index 两个合并点，再做 store/write 的归类。

如需，我可以按此方案直接落地调整（不改逻辑）。
