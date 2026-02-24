# Atoma Runtime 内部性能评估与优化方案（不改变对外行为）

## 1. 目标与约束

目标：在不改变对外 API 行为、事件语义、处理器语义的前提下，降低 runtime/core 热路径的 CPU 和内存压力。

硬约束：
- 不改变 public contract（输入/输出类型、事件名、事件触发时机、错误语义）。
- 不改变 `processor` 调用顺序与 `writeback/inbound/outbound` 语义。
- 不改变 `StoreChange` 归并结果语义（同一 id 的最终 before/after 语义保持一致）。

---

## 2. 关键联动链路（以 `replace` 为核心）

当前全量读路径（远端列表）为：

`ReadFlow.list` -> `StoreSession.reconcile({ mode: 'replace' })` -> `StoreState.replace` -> `engine.mutation.writeback` -> `mergeChanges` -> `indexes.apply` -> `notifyListeners`

关键代码位置：
- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:120`
- `packages/atoma-runtime/src/store/Catalog.ts:55`
- `packages/atoma-runtime/src/store/State.ts:120`
- `packages/atoma-core/src/store/writeback.ts:15`
- `packages/atoma-core/src/store/changes.ts:32`
- `packages/atoma-core/src/indexes/index.ts:59`

这条链路目前是读路径里最重的一条（全量同步/远端 list 高频触发时尤其明显）。

---

## 3. 热点评估（按 API）

### 3.1 `StoreState.replace`（高优先级）

代码：`packages/atoma-runtime/src/store/State.ts:120`

当前成本：
- 扫 `items` 构造 `incomingIds`（O(M)）。
- 扫 `snapshot` 生成 delete entries（O(N)）。
- 再追加全部 upsert entries（O(M)）。
- 进入 `writeback` 再次遍历 entries，并生成 `rawChanges`（O(N+M)）。
- `mergeChanges` 再遍历一次 changes（O(C)）。

问题本质：
- 多轮遍历 + 中间数组（`entries/rawChanges/changes`）带来额外 CPU 和分配压力。
- 大 `Map` 下 GC 压力明显上升。

### 3.2 `StoreState.apply`（中高优先级）

代码：`packages/atoma-runtime/src/store/State.ts:56`

当前成本：
- 每次都 `mergeChanges(changes)`，即使只有 1 条 change。
- 在写入 optimistic 路径中存在“多次单条 apply”，会重复走归并逻辑。

关联代码：`packages/atoma-runtime/src/runtime/flows/write/pipeline.ts:453`

### 3.3 `Catalog.reconcile/hydrate`（中优先级）

代码：`packages/atoma-runtime/src/store/Catalog.ts:55`

当前成本：
- `Promise.all(items.map(async ...))` 会同时创建等长 promise+results 数组。
- 大批量 `items` 会出现瞬时内存尖峰。
- `hydrate` 内部有多次数组/集合构造（`Set`/`Array.from`/filter）。

### 3.4 `ReadFlow.query/list/getMany`（中优先级）

代码：
- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:75`
- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:120`
- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:155`

当前成本：
- 远端 query/list 后做一次 `reconcile`，再对 `items` 做 `snapshot.get` 二次映射。
- `getMany` 用 `map + filter` 两段式构造结果，存在额外中间数组。

### 3.5 写入 `reconcileEmit`（中优先级）

代码：`packages/atoma-runtime/src/runtime/flows/write/pipeline.ts:482`

当前成本：
- 本地分支中 `mergeChanges(...rows.map(...))` 后又 `mergeChanges(localChanges)`，存在一次冗余归并。
- 远端分支里 `pendingReconcile + reconcileItems + retainedOptimistic + rollbackChanges` 多数组并行，分配较多。

### 3.6 `runQuery`（中高优先级，改动风险较高）

代码：`packages/atoma-core/src/query/index.ts:8`

当前成本：
- `source` -> `filtered` -> `sorted` -> `paged` 多阶段数组复制。
- 大数据查询时会出现多份数据同驻内存。

### 3.7 `Indexes.apply`（中优先级）

代码：`packages/atoma-core/src/indexes/index.ts:59`

当前成本：
- 对每个 change 都遍历全部 index 字段进行更新。
- 当 `replace` 产生大量变更时，索引更新开销随 `changes * indexes` 放大。

### 3.8 `Execution`（低优先级）

代码：`packages/atoma-runtime/src/execution/index.ts:21`

当前状态：
- 已较简洁，运行时开销小。
- 不是主 CPU/内存热点。

---

## 4. 优化方案（不改行为）

## 4.1 P0（低风险，建议立即）

1. 去掉写入本地分支的重复 `mergeChanges`。
- 位置：`packages/atoma-runtime/src/runtime/flows/write/pipeline.ts:488`
- 方案：`ctx.changes = localChanges`，避免二次归并。

2. `StoreState.apply` 增加 `changes.length === 1` 快路径。
- 位置：`packages/atoma-runtime/src/store/State.ts:56`
- 方案：单条变更直接走 apply 逻辑，跳过 `mergeChanges`。

3. `ReadFlow.getMany` 改为单次循环构造结果（替代 `map+filter`）。
- 位置：`packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:178`
- 方案：`for` 循环 push 命中项，减少中间数组。

4. `Catalog.reconcile(remove)` 复用静态空数组常量。
- 位置：`packages/atoma-runtime/src/store/Catalog.ts:109`
- 方案：避免每次返回都新建 `[]`。

5. `Catalog.hydrate` 在 `ids.length <= 1` 时走特化分支。
- 位置：`packages/atoma-runtime/src/store/Catalog.ts:123`
- 方案：避免 `Set/Array.from/filter` 的通用路径分配。

预期收益：
- 小到中等吞吐提升（约 5%~15%，取决于写入和查询模型）。
- 显著减少细粒度短命对象分配。

## 4.2 P1（中风险，高收益）

1. 为 `replace` 增加专用 mutation 路径，绕过 `entries -> writeback -> mergeChanges` 中间层。
- 位置：`packages/atoma-runtime/src/store/State.ts:120`
- 目标：直接产出最终 `after + changes`，保留当前变更语义。
- 关键：保持 duplicate id 的“最终结果语义”与当前一致。

2. `Catalog.reconcile(upsert/replace)` 改为有界并发处理（或分块）。
- 位置：`packages/atoma-runtime/src/store/Catalog.ts:55`
- 目标：避免 `Promise.all` 在大批量下产生内存尖峰。
- 关键：保持输入顺序对应的 `results` 索引语义。

3. 降低 `ReadFlow` 的二次映射成本。
- 位置：`packages/atoma-runtime/src/runtime/flows/ReadFlow.ts:91`
- 目标：让 `reconcile` 输出可直接用于返回（或提供 canonical items）。
- 关键：保持对象复用语义（引用稳定性）。

4. `write/pipeline` optimistic 路径减少重复小批 `apply`。
- 位置：`packages/atoma-runtime/src/runtime/flows/write/pipeline.ts:453`
- 目标：降低单条 apply 频繁调用造成的归并和通知开销。
- 关键：回滚映射与事件语义保持一致。

预期收益：
- `replace` 主链路可见明显收益（CPU 15%~35%，内存分配 20%~45%，视 N/M 规模而定）。

## 4.3 P2（高复杂度，需基准与回归保障）

1. `runQuery` 进行分页导向优化（减少全量复制）。
- 位置：`packages/atoma-core/src/query/index.ts:29`
- 方向：在 offset/cursor 场景下减少不必要 `slice/filter/sort` 复制。

2. 针对“大 replace”探索索引重建阈值策略。
- 位置：`packages/atoma-core/src/indexes/index.ts:59`
- 方向：当变更比例很高时，考虑重建索引而非逐条更新。
- 关键：保持最终查询结果一致与 dirty 语义一致。

---

## 5. 不变性清单（必须满足）

1. `StoreSession.reconcile` 返回结构不变（`changes/items/results` 字段保持）。
2. `StoreState.apply/upsert/replace` 对外行为不变（包括无变更时返回空数组）。
3. `writeCommitted/changeCommitted` 事件语义与时机不变。
4. `processor` 执行顺序与可中断语义不变。
5. `reuse` 导致的引用复用语义不变。
6. duplicate id 输入下，最终 `changes` 的 before/after 语义不变。

---

## 6. 验证与压测方案

## 6.1 行为一致性验证

1. 基于随机数据做差分测试（旧实现 vs 新实现）：
- 输入维度：`N(snapshot)`、`M(items)`、重复 id 比例、删除比例、对象字段规模。
- 验证项：`after snapshot` 深比较、`changes` 语义比较、事件序列比较。

2. 场景回归：
- 远端 `list -> replace`
- 远端 `query -> upsert`
- optimistic write（成功/失败/partial）
- sync pull/push 回放路径

## 6.2 性能指标

建议记录：
- P50/P95 延迟
- 每次操作分配字节数（alloc/op）
- GC 次数与停顿
- 峰值 RSS/heap used

建议基准场景：
- `replace`: N=1e4/5e4, M=1e4/5e4
- `query/list`: 命中集 1e3/1e4
- `write` 批次：32/128/512

---

## 7. 推荐落地顺序

1. 先做 P0（低风险立刻收益）。
2. 然后做 P1-1（`replace` 专用路径），这是最大收益点。
3. 再做 P1-2（`reconcile` 有界并发）控制峰值内存。
4. 最后评估 P1-3/P1-4 与 P2（需要更严格回归和基准支撑）。

---

## 8. 结论

当前性能瓶颈不是单点，而是 `replace` 主链路上的“多轮遍历 + 多中间结构 + 下游索引更新”的叠加效应。若保持外部行为不变，最值得优先推进的是：

1. `replace` 专用快速路径（绕开 `writeback+mergeChanges` 的中间层）。
2. `apply` 快路径与写入分支去重归并。
3. `reconcile` 的有界并发与对象分配控制。

这三类优化组合后，通常可以在不改外部契约的前提下显著降低 CPU 和内存压力。
