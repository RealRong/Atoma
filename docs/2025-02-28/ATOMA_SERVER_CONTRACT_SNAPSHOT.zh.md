# Atoma Server 契约快照（Phase 0）

执行日期：`2026-02-28`

## 1. 目的

本快照用于冻结当前 `atoma-server` 对外可观察行为，在大规模重构期间作为回归基线。

约束：

1. 不追求实现细节一致，追求**协议语义一致**。
2. `serverTimeMs/traceId/requestId` 等运行时字段允许变化。
3. 无兼容负担，若需要变更协议必须显式修改本文档并给出迁移理由。

---

## 2. 覆盖能力

1. `ops` query/write 路由。
2. `sync-rxdb` pull/push/stream 路由。
3. 典型成功路径。
4. 冲突路径与输入错误路径。

---

## 3. 请求与响应样例（冻结）

样例目录：`/atoma-server-contract-samples`

1. `ops-query.success.request.json`
2. `ops-query.success.response.json`
3. `ops-write.create.success.request.json`
4. `ops-write.create.success.response.json`
5. `ops-write.update.conflict.request.json`
6. `ops-write.update.conflict.response.json`
7. `invalid-json.request.txt`
8. `sync-pull.success.request.json`
9. `sync-pull.success.response.json`
10. `sync-push.success.request.json`
11. `sync-push.success.response.json`
12. `sync-push.conflict.response.json`
13. `sync-stream.notify.sse.txt`

---

## 4. 协议语义基线

### 4.1 ops

1. 入参必须包含 `meta.v=1` 与 `ops[]`。
2. 返回 envelope：
   - 成功：`{ ok: true, data: { results }, meta }`
   - 失败：`{ ok: false, error, meta }`
3. `write` 结果按 `entries` 索引对齐返回。
4. 冲突语义保留 `CONFLICT + kind=conflict`。

### 4.2 sync pull/push/stream

1. pull 使用 `{ resource, checkpoint?, batchSize }`。
2. push 使用 `{ resource, rows, context? }`。
3. push 冲突通过 `conflicts[]` 返回文档快照。
4. stream 使用 SSE，支持 `retry` 与 `notify` 事件。

### 4.3 错误语义

1. 非法 JSON / 非法请求必须返回 validation 类错误（4xx）。
2. 业务冲突必须返回 conflict 语义，不可吞并为 internal。
3. 内部异常不可直接泄漏底层数据库错误对象。

---

## 5. 回归检查清单

1. `ops-query.success.request.json` -> 响应结构匹配 `ops-query.success.response.json`。
2. `ops-write.create.success.request.json` -> 返回 `ok=true` 且结果数组对齐。
3. `ops-write.update.conflict.request.json` -> 返回冲突项（`CONFLICT`）。
4. `invalid-json.request.txt` -> 4xx validation。
5. `sync-pull.success.request.json` -> 返回 `documents + checkpoint`。
6. `sync-push.success.request.json` -> 返回 `conflicts=[]`。
7. push 冲突场景 -> 响应结构匹配 `sync-push.conflict.response.json`。
8. stream 连接 -> 至少可观察 `retry` 与 `notify` 事件形状。

---

## 6. 变更记录

1. `2026-02-28`：初始快照建立（Phase 0 完成）。
