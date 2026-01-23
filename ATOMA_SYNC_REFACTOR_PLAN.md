# atoma-sync 重构方案（允许破坏式变更）

本文档目标：给出一个可落地的重构方案，把 `packages/atoma-sync` 从“可用但偏实验/偏 KV 粗糙实现”升级为“高性能、可取消、可观测、边界清晰”的同步引擎。**明确允许破坏式变更**（当前没有外部用户），因此我们优先把接口与模型一次性理顺。

---

## 0. 现状与核心问题（基于当前代码）

当前引擎核心由：
- `SyncEngine`（生命周期 + 单实例锁，使用 xstate）：`packages/atoma-sync/src/engine/SyncEngine.ts`
- 三条 lane：`PushLane` / `PullLane` / `NotifyLane`
- `DefaultOutboxStore`：内存数组 + 每次变更整包写入 IndexedDB KV：`packages/atoma-sync/src/store.ts`
- `createOpsTransport`：每个 outbox entry 对应一个 write op（items=1），批量执行：`packages/atoma-sync/src/transport/opsTransport.ts`

主要痛点（按优先级）：
1) **Outbox 持久化方式是最大性能瓶颈**：每次 enqueue / markInFlight / ack / reject / rebase 都会 `kv.set(storageKey, queueArray)`，体积 O(queueLength)。当 outbox 变大或 push 批次频繁时，IDB 写放大严重。
2) **缺少“取消（Abort）”语义**：stop/lock_lost 时无法中止 in-flight 的 pull/push/subscribe，存在丢锁后仍继续 apply/ack 的概率，破坏单实例语义。
3) **重试边界过宽**：p-retry 包裹了包含 applier/store 的逻辑，applier 抛错会触发重试并可能重复 apply（除非 applier 强幂等）。
4) **推送网络模型低效**：`createOpsTransport` 当前“一条 entry -> 一个 op”，payload 与服务端开销线性膨胀；也让 `maxItems` 更像“op 数”而不是“item 数”。
5) **调度/并发模型重复且依赖较多**：PushLane/PullLane 依赖 `p-queue`、`p-debounce`，SyncEngine 依赖 xstate；总体可维护面偏大，且类型上存在 `as any`。
6) **可观测性不足**：有事件但缺少关键维度（耗时、batch 大小、cursor 值、inFlight 数、错误分类）。

---

## 1. 重构目标（明确可验收）

### 1.1 性能目标
- Outbox 相关写入：从“每次整包写”变为“按 key 点写/事务批写”，典型 push batch 只触发 1 次 IDB 事务（或 O(k) 点写），避免 O(n) 放大。
- Push 的网络发送：支持按 `(resource, action, options)` 合并 items；减少 op 数量与 JSON 开销。

### 1.2 正确性目标
- **stop / dispose / lock_lost 必须强制取消**：不会再发生“丢锁后还在 apply/ack”的情况。
- 重试边界清晰：只对“可判定的瞬态网络/服务端错误”重试；applier 错误默认 fail-fast，并进入可观测事件。

### 1.3 工程目标
- 减少依赖：移除 xstate、p-queue、p-debounce、p-retry（或至少把其使用集中到内部小模块，未来可替换）。
- API 边界更清楚：Outbox/Lock/Transport/Applier 的职责与一致性语义明确，便于测试与扩展。

---

## 2. 新架构总览（一步到位）

### 2.1 模块结构建议

建议把 `src/` 内部按职责重新组织（允许破坏式变更）：

- `src/core/SyncEngine.ts`：新的引擎核心（不再使用 xstate）
- `src/core/scheduler.ts`：统一的单飞 + 串行 drain + debounce（替代 p-queue/p-debounce）
- `src/core/backoff.ts`：统一退避（替代 p-retry；或封装 p-retry 但只用于 transport）
- `src/outbox/OutboxStore.ts`：OutboxStore 接口
- `src/outbox/idbOutboxStore.ts`：IndexedDB 实现（objectStore + indexes）
- `src/cursor/CursorStore.ts` + `src/cursor/idbCursorStore.ts`：cursor 存储（可沿用 KV，但建议也 objectStore 化）
- `src/lock/SingleInstanceLock.ts`：锁实现（保留 IDB KV RMW，但完善取消/续租策略）
- `src/transport/*`：transport 实现；保留 opsTransport 但升级到新接口
- `src/events.ts`：事件类型与观测协议（更细粒度）

说明：本次重构不引入 “版本号分支/兼容层/双轨 API”。代码与 Atoma 集成将**一次性迁移到新接口**，旧接口直接删除或重命名。

### 2.2 数据流
- 写入：`enqueueWrites` -> outbox.pending -> scheduler 触发 push -> transport.push -> outbox.commit(acked/rejected/retryable) -> applier 批量 apply ack/reject
- 拉取：scheduler 合并 pull 请求 -> transport.pull -> applier.applyPullChanges -> cursor.advance
- 订阅：transport.subscribe 收到 notify -> scheduler.requestPull（可按资源过滤）

关键变化：
- lane 仍可保留“推/拉/订阅”概念，但它们不再各自维护一套调度/重试；调度与 backoff 下沉为共享模块。
- 所有网络调用都带 `AbortSignal`，被 stop/lock_lost/dispose 统一取消。

---

## 3. 关键接口（破坏式变更提案）

### 3.1 OutboxStore（事务化 + 点写）

目标：把 push 批次内的多次 outbox 读写合并，避免“markInFlight + ack/release + rebase 多次整包写”。

建议接口：

```ts
export type OutboxEntry = {
  key: string;              // idempotencyKey
  resource: string;
  action: 'create' | 'update' | 'delete' | 'upsert';
  item: unknown;            // 协议形状，但存储层不强耦合 protocol
  options?: unknown;
  enqueuedAtMs: number;
  status: 'pending' | 'in_flight'; // 可扩展 'failed'
  inFlightAtMs?: number;
};

export interface OutboxStore {
  enqueue(writes: OutboxEntry[]): Promise<void>;

  // 一次性“领取”一批 pending，原子性地标记 in_flight，并返回 entries。
  reserve(args: { limit: number; nowMs: number }): Promise<OutboxEntry[]>;

  // 针对刚 reserve 的那批 entries，完成提交：ack/reject/retryable/rebase。
  // commit 内部应尽可能用一个事务完成。
  commit(args: {
    ack: string[];
    reject: string[];
    retryable: string[]; // 退回 pending（或仅清 inFlightAtMs）
    rebase?: Array<{ resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs?: number }>;
  }): Promise<void>;

  // 崩溃恢复：把超时的 in_flight 自动恢复为 pending（也应是事务）。
  recover(args: { nowMs: number; inFlightTimeoutMs: number }): Promise<void>;

  stats(): Promise<{ pending: number; inFlight: number; total: number }>;
}
```

说明：
- `reserve()` 取代现有 `peek()+markInFlight()`，直接避免一次 batch 两次写。
- `commit()` 统一 ack/reject/retryable/rebase，减少事务数，且把一致性语义集中在 store 内。
- `stats()` 为诊断提供 pending/inFlight 维度（比当前 `size()` 更有用）。

### 3.2 CursorStore（推进语义更明确）

建议把 `CursorStore.set(next)` 改为：

```ts
export interface CursorStore {
  get(): Promise<string | undefined>;
  // 返回是否推进成功 + 原因（便于诊断）
  advance(next: string): Promise<{ advanced: boolean; previous?: string }>;
}
```

并明确 cursor 单调性：如果 cursor 不是纯数字字符串，默认“尽力推进”（保守推进或强制推进需要配置）。

### 3.3 SyncTransport（支持 Abort + 更高效 push）

```ts
export interface SyncTransport {
  pullChanges(args: {
    cursor: string;
    limit: number;
    resources?: string[];
    meta: { v: 1; clientTimeMs: number; [k: string]: unknown };
    signal?: AbortSignal;
  }): Promise<{ changes: any[]; nextCursor: string }>;

  // push：允许按资源/动作分组 items，减少 op 数
  pushWrites(args: {
    writes: Array<{
      resource: string;
      action: string;
      items: any[];
      options?: any;
    }>;
    meta: any;
    signal?: AbortSignal;
  }): Promise<Array<
    | { kind: 'ack'; key: string; result: any }
    | { kind: 'reject'; key: string; result: any }
    | { kind: 'retry'; key: string; error: any }
  >>;

  subscribe?(args: {
    resources?: string[];
    onMessage: (msg: { resources?: string[]; traceId?: string }) => void;
    onError: (error: unknown) => void;
    signal?: AbortSignal;
  }): { close: () => void };
}
```

说明：
- push 的返回要能映射回 outbox entry（用 `key`），避免“顺序对齐”假设。
- `createOpsTransport` 仍然保留，但会改造成符合新接口的实现：内部把 outbox entries 分组构建 write op（items=N），或者在协议限制下退化为 items=1。

### 3.4 SyncApplier（可选批处理 + 明确错误语义）

```ts
export interface SyncApplier {
  applyPullChanges(changes: any[], ctx: { signal?: AbortSignal }): Promise<void>;

  // 支持批处理（单事务）
  applyWriteResults(args: {
    acks: any[];
    rejects: any[];
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual';
    signal?: AbortSignal;
  }): Promise<void>;
}
```

明确：applier 抛错默认不重试（除非用户显式声明幂等并开启重试）。

---

## 4. 引擎运行模型（取消、锁、调度、重试）

### 4.1 取消模型（必须实现）
- 引擎维护一个 `engineController: AbortController`
- `stop()`：abort controller + 关闭订阅 + 停止定时器 + 清空调度队列
- `lock_lost`：等价于 stop（并 emit 事件），确保不会继续 push/pull/apply

### 4.2 锁模型（保留 IDB KV，但更稳健）
当前锁是 IDB KV 的 RMW + confirm，续租用 `setInterval`：`packages/atoma-sync/src/policies/singleInstanceLock.ts`。

改进：
- 续租改成“串行 setTimeout 链”（上一轮 renew 完成后再 schedule 下一轮），避免并发堆叠。
- `acquire()` 支持 signal：stop/disposing 时能中止 acquire 重试。
- `onLost` 触发后立刻 abort 引擎 controller。

（可选）进一步增强：
- 在浏览器下同时用 `BroadcastChannel` 做“快速互斥通知”，减少争锁的 IDB 压力；IDB 锁仍是最终裁决。

### 4.3 调度器（替代 p-queue/p-debounce）
统一提供：
- `requestPush()`：合并触发（微任务/宏任务 debounce）
- `requestPull(cause)`：notify 可 debounce；manual/periodic 立即排队
- 单飞：同一时刻最多一个 push drain、一个 pull drain（可配置）

### 4.4 重试边界（收窄）
- 只对 `transport.pullChanges/pushWrites` 抛出的“可判定 retryable”错误重试
- store/applier 错误：
  - 默认直接 fail 并停止该 lane（或进入 degraded 状态），避免重复 apply
  - 上报可观测事件，交给上层策略决定是否继续

---

## 5. 可观测性（事件体系升级）

现有事件在 `packages/atoma-sync/src/types.ts`，建议扩展为带维度的事件（仍然保持轻量）。

新增建议字段：
- push：`batchSize`, `acked`, `rejected`, `retryable`, `durationMs`, `outboxPending`, `outboxInFlight`
- pull：`changesCount`, `cursorBefore`, `cursorAfter`, `durationMs`
- notify：`connectedAt`, `disconnectReason`, `messageCount`
- lifecycle：`lockKey`, `ownerId`（可选）

并明确 error 分类：
- `error.kind = 'transport' | 'applier' | 'store' | 'lock' | 'unknown'`

---

## 6. 实施步骤（分阶段，便于回滚/对比；但允许破坏）

本次重构建议按任务拆分实现与验收，但对外表现为：**旧接口直接删除/替换，Atoma 同步修改，一次性切到新接口**（不保留任何兼容层）。

### Task 1：先把“存储与一致性”一次性换掉（最大性能收益）
1) 新增 OutboxStore（reserve/commit）+ IDB 实现（objectStore：`outbox_entries` + 必要索引）
2) 新增 CursorStore（advance）实现（可继续 KV，也可 objectStore 化）
3) 迁移 `createStores`（或直接删除，改为显式构造 Outbox/Cursor）

验收：
- 本地 demo/测试中大量 enqueue 时，IDB 写入不会随 queueLength 放大
- stop/lock_lost 后不会继续发请求/写入/调用 applier

### Task 2：把取消/重试边界一次性做正确（最大正确性收益）
1) transport 全面支持 `AbortSignal`，引擎 stop/lock_lost/dispose 会 abort 所有 in-flight
2) 重试边界收窄：只重试 transport 的“可判定 retryable”，不重试 applier/store

验收：
- 触发 stop/lock_lost 后，不会再出现“后续仍在 pull/push/apply/ack”的事件
- applier 抛错不会触发重复 apply（不会被 p-retry 包裹重入）

### Task 3：把 push 网络与 apply 批处理做成“更省请求/更省事务”
1) opsTransport 支持按 resource/action/options 合并 items
2) applier 提供 `applyWriteResults` 批处理路径（Atoma 侧尽量单事务落地）

验收：
- 相同资源的连续写入，op 数显著下降
- 单次 push 的 CPU/序列化耗时下降

### Task 4：清理旧实现与依赖
1) 删除 xstate、p-queue、p-debounce、p-retry（或保留极少封装）
2) 删除/落实 `queueMode`（当前基本无效）
3) 简化 types（避免 `any` 泄漏）

---

## 7. 数据迁移策略（允许破坏：可直接清库）

由于当前没有外部用户，建议最简单：
- Outbox/Cursor 存储 schema 版本 bump
- 检测到旧 schema：直接清理旧 key（或整库）并重新开始

（如果未来需要迁移，再补迁移脚本与版本字段。）

---

## 8. 测试计划（建议补齐）

新增/重写测试建议（放在 `packages/atoma-sync` 内，或者在 atoma 侧做集成测试）：
- OutboxStore：
  - reserve/commit 原子性（reserve 后 commit ack/retryable）
  - 崩溃恢复 recover（超时 inFlight 回 pending）
  - maxQueueSize 策略（默认拒绝/背压，而不是 silent drop）
- Engine：
  - stop/lock_lost 触发 abort，确保 transport/applier 不再被调用
  - notify burst 下 pull 合并（debounce + singleflight）
- Transport（opsTransport）：
  - push 分组映射回 key 的正确性
  - retryable error 分类正确

---

## 9. 对 Atoma 集成点的改动（预期破坏）

Atoma 当前主要用到：
- `createStores` / `createSyncEngine` / `createOpsTransport` / `subscribeNotifySse`
- 以及 types（SyncRuntimeConfig 等）

重构后建议：
- Atoma 侧只依赖更小的 public API：`SyncEngine.create(config)`（或保留 `createSyncEngine(config)` 但参数结构更新）、`createOpsTransport(...)`、`subscribeNotifySse(...)`
- `resolveSyncRuntimeConfig` 需要同步更新以适配新 config 与新增 abort/backoff/事件字段

---

## 10. 交付物清单（完成后应看到的变化）

- 新的 outbox 存储实现（IDB objectStore + 事务化 reserve/commit）
- 引擎全面支持 Abort，stop/lock_lost 行为可证明正确
- push 支持分组 items，减少 op 数
- 依赖与代码量下降（lane 的调度逻辑集中）
- 事件更可诊断（含 batch 大小/耗时/cursor 等）
