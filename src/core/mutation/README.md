# Mutation（写入）链路速读

目的：让你打开 `src/core/mutation/` 就能快速理解 Atoma 的写入链路在干什么、各文件分别负责什么、Direct/Outbox 差异在哪里。

---

## 一句话

Mutation = **把一段 StoreDispatchEvent 写入序列** “编译”成一个 `MutationProgram`（唯一写入协议是 ops），先做本地乐观提交，再选择 **Direct**（立即发 ops）或 **Outbox**（enqueue），最后用服务端确认结果（created/writeback/versionUpdates）把本地状态收敛到一致。

---

## 流程（从“读代码顺序”出发）

推荐阅读入口（线性流程）：

1) `pipeline/Flow.ts`（主流程：compile → optimistic → persist → finalize）
2) `pipeline/Persist.ts`（Direct vs Outbox 的唯一分叉点）
3) `pipeline/Program.ts`（operations → MutationProgram）
4) `pipeline/Ops.ts`（program → ops；direct 执行/解释）
5) `pipeline/Scheduler.ts` / `pipeline/TicketTracker.ts`（调度与票据）

简化版流程图：

```
operations (StoreDispatchEvent[])
    ↓
program (MutationProgram)
    ↓
commit optimistic (prepare)
    ↓
persist (direct/outbox)
    ↓
commit final / rollback
    ↓
settle tickets + callbacks
```

---

## Direct vs Outbox（只看语义）

- Direct：`persist.status === 'confirmed'`
  - 本次写入会立即通过 ops client 发到后端
  - 会拿到服务端 write result，从中抽取 `created` / `writeback`

- Outbox：`persist.status === 'enqueued'`
  - enqueue 落盘成功即视为“系统已接管”，后续由 sync/outbox 推送、重试、合并
  - 可选 local-first：先 direct 确认一次（提升本地一致性/回写），再 enqueue

差异集中在：`pipeline/Persist.ts`

---

## 关键类型（最少集合）

- `StoreDispatchEvent`：写入事件（add/update/upsert/patches…），可带 ticket/onSuccess/onFail
- `MutationProgram`：一次 mutation 的编译产物（base/optimistic/rollback state + changedIds + writeOps）
- `PersistResult`：direct/outbox 的统一输出（confirmed/enqueued + created/writeback）
- `WriteTicket`：统一 await 语义（enqueued/confirmed）

---

## 文件职责速查

- `MutationPipeline.ts`：对外的 mutation runtime（queue/dispatch + 内置 history）
- `pipeline/Flow.ts`：**必读入口**，线性串起一次 mutation 的完整生命周期
- `pipeline/Program.ts`：把 operations 编译为 `MutationProgram`（内部会调用 `Plan.ts`）
- `pipeline/Ops.ts`：ops 翻译/执行/解释（写入细节集中）
- `pipeline/Persist.ts`：Direct/Outbox 分支与 local-first 规则的集中点
- `pipeline/Scheduler.ts` / `pipeline/TicketTracker.ts`：调度与票据（异步/分段/确认语义）

---

## 常见疑问（快速答案）

### 为什么 patches 不直接“逐 patch 写后端”？

patches 更像是 history undo/redo 的高级语义；我们会按受影响 id 把最终状态翻译为 **upsert(merge=false)+delete**，从而在后端获得可重复、可批量、可校验版本的写入序列。
