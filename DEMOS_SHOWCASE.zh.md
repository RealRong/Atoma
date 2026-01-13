# Atoma 可交互 Demo 清单（文档用）

目标：用“能直接看见效果”的交互页面展示 Atoma 的核心能力（批处理、关系投影、同步、冲突、离线、索引性能等），并把关键指标显式呈现出来（请求数、批大小、延迟、回放、最终一致性）。

> 约定：SSE 只作为通知通道（`sync.notify`），数据一致性只由 `changes.pull` 保证；通知允许丢失，pull 负责补齐。

---

## 1) Batch 控制台（查询/写入批处理可视化）

展示点：
- 同一屏触发多次 query + write，观察“实际发出的 HTTP 请求数”和“每个请求包含的 op 数”
- 切换 `remote.batch` 开/关对比（吞吐、尾延迟、请求数）

交互项：
- `remote.batch`: `true/false`
- 查询并发度、写入并发度
- `maxBatchSize`（或等价限制项）
- 单次压测规模：N 个 query、M 个 write

指标面板：
- `requests.count`（总请求数）
- `ops.perRequest`（每请求 op 数分布）
- `latency.p50/p95/p99`（端到端延迟）
- `payload.bytes`（请求体大小）

最小实现要求：
- client 侧批处理已开启/可配置
- server 支持 `/ops` 批量执行

---

## 2) 多实体 + Relations 投影（include/预取/投影链路）

示例模型：
- `users`、`posts`、`comments`
- `posts.belongsTo(user)`、`posts.hasMany(comments)`、`comments.belongsTo(user)`

展示点：
- 列表页一次性渲染 `posts + author + comments(Top-N)`（关系投影结果）
- 强制刷新/切换 fetchPolicy，对比本地命中与远端补齐

交互项：
- `fetchPolicy`: `local` / `remote` / `cache-and-network`
- `skipStore`: `true/false`（大列表瞬时查询）
- include 开/关（是否 prefetch + 投影）
- `live`: `true/false`（关系字段实时订阅 vs 快照）

指标面板：
- 本地查询耗时（索引命中）
- 远端请求次数/耗时
- 投影/合并耗时

最小实现要求：
- relations 定义
- findMany + include 投影链路

---

## 3) 多实体写入（同一用户动作驱动多资源更新）

示例场景：
- “完成任务”同时写：`tasks`、`activity_logs`、`notifications`

展示点：
- 一次 UI 操作生成多条 write items（同一批或同一 flush 周期内）
- 展示 outbox 入队、flush、ack/reject 回写的路径

交互项：
- 单次操作写入的资源数/条数
- `returning` 开/关（是否需要 returning data）
- `conflictStrategy` 切换（配合冲突 demo）

指标面板：
- outbox size（队列长度）
- flush 耗时与重试次数
- ack/reject 数量

最小实现要求：
- outbox + push lane
- write ack/reject 回写

---

## 4) 冲突演示（server-wins / client-wins / reject / manual）

示例场景：
- 两个“客户端实例”（同页双面板或多标签页）并发 patch 同一条记录

展示点：
- 版本冲突产生、冲突策略生效、回滚/覆盖/拒绝的结果
- 同一条记录在两个实例上的最终状态收敛过程

交互项：
- `conflictStrategy`: `server-wins` / `client-wins` / `reject` / `manual`
- 操作顺序：先后写/并发写
- 网络延迟注入（模拟乱序）

指标面板：
- 冲突次数
- reject 原因与 currentValue 展示
- 最终一致性达成时间

最小实现要求：
- 版本字段 + 冲突返回结构
- 本地回写逻辑（ack/reject）

---

## 5) 离线/重连/幂等（Offline-first 可靠性）

示例场景：
- 断网期间连续写入 30 次；恢复网络后自动 flush
- “重复提交”触发幂等命中，确保不会生成重复写

展示点：
- 离线写入：只入 outbox，不丢操作
- 恢复网络：push 重试、幂等命中、最终一致性
- SSE notify 可断开；periodic pull 仍能补齐

交互项：
- 模拟 offline/online（或注入网络错误）
- 幂等 key 重放开/关（对照）
- `periodicPullIntervalMs`、`pullDebounceMs`

指标面板：
- outbox 入队/出队曲线
- 幂等 hit 次数
- pull 次数与每次 changes 数

最小实现要求：
- idempotency store（server 侧）
- outbox 持久化（client 侧）

---

## 6) 索引与本地查询性能（大列表/搜索）

示例场景：
- 1 万/10 万条记录的本地查询与搜索（含 tokenizer）

展示点：
- 开/关索引下的查询耗时对比
- 模糊搜索与 tokenize 配置效果

交互项：
- 数据规模（1w/10w）
- 索引开/关、索引字段选择
- 搜索关键字、最小 token 长度

指标面板：
- 本地查询耗时（p50/p95）
- 命中率/候选集大小

最小实现要求：
- StoreIndexes + tokenizer

---

## 7) Notify → Pull（resources 过滤 + pull 合并调度）

示例场景：
- 后端同时产生 `todos`、`posts` 变更；客户端只关心 `todos`

展示点：
- SSE notify payload 仅作为信号（可带 resources）
- 客户端基于 `resources` 决定是否 `schedulePull`
- 通知风暴下 pull 去抖与 in-flight 合并

交互项：
- 订阅 resources 白名单（例如 `['todos']`）
- 通知频率（每秒 N 次）
- `pullDebounceMs`

指标面板：
- notify 收到次数
- 实际 pull 次数（合并后）
- 每次 pull 的 changes 数

最小实现要求：
- `sync.notify` + `changes.pull`
- pull 调度器（debounce + 合并）

---

## 落地形式（文档站内）

每个 demo 建成一页（同一套 UI 组件 + 同一套主题）：
- 主页卡片入口（标题/一句话/关键能力标签）
- 页面上方是“控制面板”，下方是“业务画面”，右侧/底部是“指标面板”
- 控制项变更立即反映到指标与行为（避免只展示代码片段）
