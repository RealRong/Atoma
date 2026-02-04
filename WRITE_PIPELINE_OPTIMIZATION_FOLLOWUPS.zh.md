# 写入链路后续优化（4/6/PersistResult）

日期：2026-02-04

本文仅讨论三项：
- 4）批量 writeback/transform
- 6）严格保序合并策略
- PersistResult 优化

---

## 4）批量 writeback/transform

### 现状
`buildWritebackFromResults` 会对每个 item 调 `runtime.transform.writeback`，属于串行/逐条处理。

### 怎么改
方案 A（推荐）：扩展 RuntimeTransform
- 在 `RuntimeTransform` 增加 `writebackMany` 接口（或在 DataProcessor 中添加批处理能力）。
- `buildWritebackFromResults` 收集返回数据数组后一次性批处理。
- 对不支持批处理的实现，fallback 到逐条处理。

方案 B（局部优化）：Promise.all 批量并行
- 不改接口，仅在 finalize 内并行处理 `writeback`。
- 风险是数据处理器若有顺序依赖，会有行为变化。

### 能不能改
**可以改**。但会触及 `DataProcessor`/`RuntimeTransform` 接口，属于中等规模改动。

### 风险
- 批处理可能改变顺序或副作用时机。
- 如果某些 processor 依赖单条处理语义，需要提供 fallback。

---

## 6）严格保序合并策略

### 现状
`buildWriteOps` 会将所有 intents 依据 action + options 分组，可能跨越原始顺序。

### 怎么改
只合并“连续且相同 action + options”的 intents：
- 遍历 intents，维护当前分组；
- 如果新 intent 的 action/options 不同，结束当前组、开启新组。

### 能不能改
**可以改**，改动范围小，风险低。

### 代价
- 批量收益略下降（因为分组更碎）。

---

## PersistResult 优化

### 现状
`PersistResult` 结构为：
- `status: 'confirmed' | 'enqueued'`
- `results?: OperationResult[]`

这会造成“status=confirmed 但 results 为空”的模糊情况。

### 怎么改
改成**判别联合**，强制语义一致：
```ts
export type PersistResult =
  | { status: 'confirmed'; results: OperationResult[] }
  | { status: 'enqueued' }
```

WriteFlow 只在 `status === 'confirmed'` 时解析 results。

### 能不能改
**可以改**，但会影响：
- 所有 persistence handlers 的返回值
- WriteFlow 的结果解析路径
- 依赖 PersistResult 的插件/外部调用方

### 风险
- 如果有自定义策略/插件依赖旧结构，需要同步迁移。

---

## 建议执行顺序（如要落地）
1) 6（保序合并）
2) PersistResult 判别联合
3) 4（批量 writeback）
