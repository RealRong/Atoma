# Sync（阅读指南）

本目录包含 Atoma 的同步运行时：基于 **outbox** 的写入推送、基于 **cursor** 的变更拉取，以及可选的 SSE 订阅（准实时）。

本文目标：帮助你从上到下读懂实现，并把关键不变量（不会轻易变的规则）讲清楚。

## 一分钟心智模型

同步由三条相互独立的 “lane” 组成：

1) **Push lane**：本地写入先进入 **outbox**，再以 `write` 操作推送到服务端。
2) **Pull lane**：调用 `changes.pull` 拉取服务端变更，并推进持久化的 **cursor**。
3) **Subscribe lane**（可选）：保持 SSE 连接；服务端每下发一个 batch，就应用 changes 并推进同一个 cursor。

所有“应用变更”的动作最终都会通过 `applier` 调用用户传入的回调（只做薄封装，不耦合具体 store 实现）。

## 文件导航（从哪里开始看）

- 编排 / 生命周期：
  - `engine/SyncEngine.ts`
- 三条 lane：
  - `lanes/PushLane.ts`
  - `lanes/PullLane.ts`
  - `lanes/SubscribeLane.ts`
- 持久化（IndexedDB KV）：
  - `store.ts`（outbox + cursor）
  - `kvStore.ts`
- 策略 / 工具：
  - `policies/retryBackoff.ts`（统一重试/退避计数与计算）
  - `policies/backoffPolicy.ts`（退避 delay 计算 + sleep）
  - `policies/singleInstanceLock.ts`（同一 outboxKey 只允许一个实例工作）
  - `policies/batchPolicy.ts`（outbox items 组 batch）
  - `policies/cursorGuard.ts`（cursor 单调比较）
- 类型 & 小工具：
  - `types.ts`
  - `internal.ts`

## 核心不变量（最重要的规则）

1) **cursor 单调前进**：cursor 只会向前推进（尽力比较）。
   - `DefaultCursorStore.set(...)` 会通过 `defaultCompareCursor(...)` 做单调性判断。
2) **outbox 追加为主**：enqueue 后的条目只会在 ack/reject 时移除。
3) **inFlight 不会被重复拿到**：被标记 `inFlightAtMs` 的条目会被 `peek(...)` 跳过。
4) **inFlight 超时恢复**：如果页面崩溃/关闭导致 inFlight 卡住，超过 `inFlightTimeoutMs` 会自动回到可发送状态。
5) **单实例**：同一个 `outboxKey`（同一浏览器 profile）同一时间只能有一个 `SyncEngine` 真正在跑（push/pull/subscribe）。

## 生命周期（`start()` 到底做了什么）

建议按 `SyncEngine.start()` → `startWithLock()` 的顺序阅读：

1) 先获取 `SingleInstanceLock`（底层也是存到 IndexedDB KV，key 默认是 `${outboxKey}:lock`）。
2) 如果抢锁成功且仍然“应该运行”：
   - 启动 subscribe lane（但只有 enabled 才会真正建立连接）
   - 触发一次 push flush（尽快把 outbox 里的写入推上去）
   - 启动 periodic pull 定时器（可关闭，interval<=0 时不启用）

停止（`stop()`）会：

- 停止 subscribe lane
- 清掉 periodic pull 定时器
- 释放 lock

销毁（`dispose()`）会：

- 调用 `stop()`，并把各 lane 置为永久不可用

## 三条数据流（最适合新手的读法）

### 1) 本地写入 → outbox → 服务端（`write`）

路径：

- `SyncEngine.enqueueWrite(...)`
  - 为每个 `WriteItem` 补齐 `meta.idempotencyKey`
  - 以 `SyncOutboxItem` 形式写入 `DefaultOutboxStore`
  - 触发 `PushLane.requestFlush()`

然后：

- `PushLane.flush()` 循环执行：
  - `outbox.peek(max)` 取待发送条目
  - `buildWriteBatch(...)` 按 `(resource, action)` 把连续条目组装成一个写入 batch
  - 可选：把这些 key 标记为 inFlight
  - `transport.executeOps({ ops: [writeOp], meta })`
  - 对每条结果：
    - ok：`applyWriteAck(...)` → `outbox.ack(keys)`
    - not ok：`applyWriteReject(...)` → `outbox.reject(keys)`

备注：

- 只有“可重试”的 operation error 才会进入退避重试（见 `isRetryableOpError`）。
- 重试前会把 inFlight key release 回 pending，避免卡死。

### 2) 拉取变更（`changes.pull`）

路径：

- `SyncEngine.pullNow()` → `PullLane.pullNow()`
  - 读取当前 cursor（没有则用 `initialCursor`，再没有则 `'0'`）
  - `transport.executeOps({ ops: [changes.pull], meta })`
  - `applier.applyChanges(batch.changes)`
  - `cursor.set(batch.nextCursor)`

此外 `SyncEngine` 还会按 interval 做 periodic pull；失败时会退避并重试。

### 3) 订阅变更（SSE）

路径：

- `SyncEngine.start()` 会启动 lane；`setSubscribed(true)` 才会启用连接。
- `SubscribeLane`：
  - 读取 cursor（规则与 pull 相同）
  - 通过 `transport.subscribe(...)` 打开订阅（默认实现为 `subscribeChangesSse(...)`）
  - 每个 batch：
    - apply changes
    - 推进 cursor
  - 出错：
    - close 连接
    - 退避后重连

重要：pull 与 subscribe 共用同一个 cursor store，任何一方推进 cursor 都会影响另一方的起点。

## 重试/退避（统一模式）

- `RetryBackoff` 统一管理：
  - attempt 计数
  - maxAttempts 截止
  - delay 计算（指数退避 + jitter）
- 各 lane 只保留“怎么等”的差异：
  - Push：`sleepMs(delay)`
  - Subscribe：`setTimeout(delay)`
  - Periodic pull：`setTimeout(delay)`

## Transport & Applier（对接点）

- `SyncTransport.executeOps(...)` 是必需的服务端对接点。
- 订阅需要 `subscribeUrl`（可选 `eventSourceFactory`）。
- `applier` 负责把 sync 事件转成用户回调：
  - `onPullChanges(changes)`
  - `onWriteAck(ack)`
  - `onWriteReject(reject, conflictStrategy)`

这样 sync 逻辑就不会依赖你具体的 store/adapter 实现细节。

## 快速排查清单

- 写入没推送：
  - 是否调用了 `SyncEngine.start()`？
  - 是否抢到 lock？（看 lifecycle 事件）
  - outbox 是否真的有数据？（`DefaultOutboxStore.size()`）
- 订阅不工作/不重连：
  - 是否调用了 `setSubscribed(true)`？
  - 是否配置了 `subscribeUrl`？
  - 运行环境是否有 `EventSource`（没有就需要 `eventSourceFactory`）？

