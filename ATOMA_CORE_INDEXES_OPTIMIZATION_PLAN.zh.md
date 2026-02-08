# atoma-core/indexes 优化方案（一步到位）

> 时间：2026-02-08  
> 范围：`packages/atoma-core/src/indexes` 及其上游调用边界（`atoma-runtime` / `atoma-client`）  
> 前提：**无兼容负担**，可直接切换到最优结构。

---

## 1. 背景与问题诊断

当前 `atoma-core/src/indexes` 的核心问题：

1. **目录层级过碎**
   - `base/`、`factory/`、`implementations/`、`planner/`、`updater/` 拆分过细。
   - 多个目录仅承载单文件，维护收益低，跳转成本高。

2. **职责边界不清晰**
   - core 层 `createIndex` 引入 zod 做入口 schema 校验。
   - 入口校验应在 client/schema 编译阶段完成，不应落在 core 算法层。

3. **公共 API 与内部细节混放**
   - `StoreIndexes.ts` 与 `utils.ts`、`tokenizer.ts`、`validators.ts` 同级。
   - 内部算法工具应内聚到 `internal/`，避免污染公开语义层。

4. **命名偏长或语义冗余**
   - `IndexQueryPlanner`、`IndexDeltaUpdater` 在 `indexes` 语境下前缀重复。
   - `IIndex` 命名过于传统，领域语义不够清晰。

---

## 2. 优化目标与硬规则

### 2.1 目标

- 目录拍平并内聚，降低认知负担。
- 明确 `client -> runtime -> core` 职责边界。
- API 命名短、语义清晰、行业可读。
- 一步到位，不引入兼容层。

### 2.2 硬规则（必须满足）

- **类名必须使用 PascalCase**（如 `Indexes`、`TextIndex`、`IndexSync`）。
- **API 命名必须短而清晰**，避免路径语义重复前缀。
- **职责分离必须可追踪**：
  - core：算法与数据结构
  - runtime：执行编排与状态接线
  - client：配置入口校验与规范化

---

## 3. 目标目录结构（已按命名原则收敛）

### 3.1 当前（简化）

```text
indexes/
├─ StoreIndexes.ts
├─ base/IIndex.ts
├─ factory/createIndex.ts
├─ implementations/*
├─ planner/IndexQueryPlanner.ts
├─ updater/IndexDeltaUpdater.ts
├─ tokenizer.ts
├─ utils.ts
├─ validators.ts
└─ index.ts
```

### 3.2 目标（一步到位）

```text
indexes/
├─ index.ts                 # 公开导出（最小面）
├─ indexes.ts               # 主索引容器（类：Indexes）
├─ types.ts                 # IndexDriver + 条件类型 + 计划类型
├─ build.ts                 # 原 createIndex（不做入口 schema 校验）
├─ plan.ts                  # 原 IndexQueryPlanner
├─ sync.ts                  # 原 IndexDeltaUpdater（类：IndexSync）
├─ impl/
│  ├─ numberDate.ts
│  ├─ string.ts
│  ├─ substring.ts
│  └─ text.ts
└─ internal/
   ├─ tokenize.ts           # 原 tokenizer.ts
   ├─ search.ts             # 原 utils.ts（二分/编辑距离/交集）
   └─ value.ts              # 原 validators.ts（值规整/断言）
```

说明：
- 删除 `base/`、`factory/`、`planner/`、`updater/`。
- 顶层仅保留“公开 API + 核心编排文件”，其余下沉到 `impl/internal`。
- 文件名统一 camelCase，类名统一 PascalCase。

---

## 4. API 命名收敛（无兼容负担，直接切换）

| 当前 | 建议 | 说明 |
|---|---|---|
| `StoreIndexes` | `Indexes` | 去掉 `Store` 冗余，语义不丢失 |
| `IIndex` | `IndexDriver` | 接口语义从“前缀习惯”改为“职责语义” |
| `createIndex` | `buildIndex` | 与 `build.ts` 对齐，工厂语义清晰 |
| `collectCandidatesWithPlan` | `planCandidates` | 动词优先，缩短且保留语义 |
| `IndexDeltaUpdater` | `IndexSync` | 直观表达差量同步职责 |
| `tokenizer.ts` | `internal/tokenize.ts` | 从名词工具转为动作语义，且内聚 |
| `validators.ts` | `internal/value.ts` | 从入口校验语义收敛到值规整语义 |

公开导出建议：
- `atoma-core/indexes` 仅导出：`Indexes`、`buildIndex`、`planCandidates`、`IndexSync` 及必要类型。
- `impl/internal` 不直接对外暴露。

---

## 5. 职责分离落地

### 5.1 core（算法层）

负责：
- 索引数据结构与索引驱动
- 候选集规划与求交
- patch/map diff 索引同步
- 文本分词与检索内部算法

不负责：
- 入口 schema 校验（如 zod parse）
- 面向用户的配置错误文案编排

### 5.2 runtime（编排层）

负责：
- 基于已规范化 schema 创建索引实例
- 将 `StoreState`、query、indexes/matcher 编排给 query engine

不负责：
- 兜底 schema 合法性校验

### 5.3 client（入口层）

负责：
- `createClient` / schema 编译阶段的配置校验
- index definitions 规范化后再下发 runtime

建议新增：
- `packages/atoma-client/src/schemas/indexes.ts`
  - `checkIndexes(...)`
  - `normalizeIndexes(...)`

---

## 6. “校验上移”实施策略（core 不做入口校验）

### 6.1 现状

- `packages/atoma-core/src/indexes/factory/createIndex.ts` 使用 zod `parseOrThrow`。
- 导致 `atoma-core` 在此链路上承担了不必要的入口校验职责。

### 6.2 目标

- core 的 `buildIndex(def)` 仅做类型分发与不可达保护。
- schema 合法性由 client 统一保证。

### 6.3 规则

- `buildIndex(def)`：
  - 仅按 `def.type` 分派实现。
  - `switch` 覆盖所有已支持类型。
  - `default` 仅做内部 invariant（不引入 zod）。
- `internal/value.ts` 中的值规整逻辑可保留（属于算法执行防御，不是入口配置校验）。

---

## 7. 分阶段执行计划

1. **结构重排（零行为变化）**
   - 文件迁移 + 重命名 + import 路径更新。
2. **命名收敛**
   - `StoreIndexes -> Indexes`、`createIndex -> buildIndex` 等。
3. **校验上移**
   - 删除 core 入口 zod 校验，补齐 client schema 校验。
4. **依赖清理**
   - 若 core 不再使用相关校验能力，移除不必要依赖。
5. **全仓验证**
   - 受影响包 `typecheck/build`，最终 `pnpm typecheck`。

---

## 8. 验收标准

- `packages/atoma-core/src/indexes` 不再存在 `base/`、`factory/`、`planner/`、`updater/`。
- `IIndex` 已收敛到统一类型文件并重命名为 `IndexDriver`。
- `tokenizer/utils/validators` 已内聚到 `internal/`。
- core 不再在 `buildIndex` 执行入口 schema 校验。
- `indexes` 公开 API 命名已短化并语义清晰。
- 类名全部符合 PascalCase，文件名全部符合 camelCase。
- 全仓 `pnpm typecheck` 通过。

---

## 9. 风险与对策

- 风险：重命名后跨包引用断裂。  
  对策：先结构迁移，再统一改名，最后一次性 typecheck。

- 风险：校验上移后，绕过 client 的调用传入非法 schema。  
  对策：runtime 增加轻量 invariant（开发态），但不回退到 zod 入口校验。

- 风险：内部文件拆分导致性能回退。  
  对策：仅迁移文件与命名，不改算法行为；性能优化另行评估。

---

## 10. 结论

本方案落地后，`indexes` 子系统将获得：
- 更平整的目录结构
- 更清晰的层次职责
- 更短且规范的 API 命名
- 更严格的“core 算法 / runtime 编排 / client 校验”架构边界

并与当前项目“无兼容负担、一步到位最优架构”的总体策略保持一致。
