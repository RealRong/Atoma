# 抽离 Sync 为独立包（atoma-sync）方案

本文档描述：如何把当前仓库里的 sync（`src/sync` + client 侧 wiring）抽离成一个独立 npm 包 `atoma-sync`，以及 client 侧如何安装与接入；同时给出“尽量用成熟开源库替代自研样板代码”的推荐清单与落地方式。

前提与原则：
- 允许破坏式变更（不做兼容层/过渡命名）。
- 主包（atoma）优先保持轻量、低依赖、低心智负担。
- `atoma-sync` 允许引入更多依赖以换取更少样板代码、更清晰的状态机与更可靠的重试/背压语义。

---

## 1. 为什么 sync 看起来“天然复杂”

sync 复杂度来源并不主要是“没用库”，而是系统本身需要同时处理：
- 多 lane 并行：push/pull/notify（SSE）各自循环 + 互相触发/抑制
- 不确定网络：断线、重连、重复消息、乱序、部分失败
- 持久化状态：cursor/outbox/lock 跨重启稳定
- 幂等与冲突：idempotencyKey、baseVersion、ack/reject、冲突策略
- 生命周期/状态机：start/stop/dispose、锁丢失、重试 backoff、手动触发

抽包的核心收益是“隔离复杂度”，让主包阅读、测试、发布时不再被 sync 牵连；而 `atoma-sync` 内部则可以更自由地用成熟库收敛样板。

---

## 2. 目标架构（抽包后的分层）

### 2.1 atoma（主包）保留/负责
- core/store/history/registry/backend/protocol 等“基础能力”
- 最小同步边界接口（只保留能力抽象，而非引擎实现）：
  - `OpsClientLike` / `OutboxWriter` / `OutboxReader` / `CursorStore`（这些已经较稳定）
  - 与 store 集成所需的最少 hooks（例如 applier 接口，或由 client 适配层实现）
- client 侧只保留“薄适配层”（建议）：
  - 把已 normalize/validated 的配置、backend transport、outbox/cursor/lockKey、applier 等打包成 `SyncRuntimeConfig`
  - 调用 `atoma-sync` 来创建引擎并暴露 `client.Sync`

### 2.2 atoma-sync（新包）保留/负责
- `SyncEngine`（push/pull/notify/lock 的编排与状态机）
- lane 实现（PushLane/PullLane/NotifyLane/LockLane 等）
- 重试/退避/背压/事件流机制（尽量由开源库承接）
- sync 内部类型：`SyncRuntimeConfig`、`SyncClient`、`SyncEvent`、`SyncPhase` 等
- 可选：跨环境 SSE 适配（browser/node）

### 2.3 client 侧（atoma 内部）建议形态
当前你已经开始把 `SyncController` 变薄。抽包后，建议把 client sync 逻辑进一步收敛成：
- `ClientRuntimeSyncDiagnostics`：devtools/统计（留在 atoma）
- `ClientRuntimeSseTransport`：traceId/requestId 注入（留在 atoma；或作为 atoma-sync 的可选 helper）
- `resolveSyncRuntimeConfig`：由 client 侧派生 `SyncRuntimeConfig`（留在 atoma）
- 由 `atoma-sync` 提供 `createSyncEngine(config): SyncClient`

这样 `SyncController` 只负责：
- engine 缓存（按 mode 重建）
- start/stop/dispose 的生命周期

---

## 3. 抽离范围与文件边界（建议）

### 3.1 迁移到 atoma-sync 的目录（强建议）
- `src/sync/**`（整体搬迁）
- 与 sync 强相关且只被 sync 引擎使用的工具/策略（例如 retry/backoff、notify 解析辅助等）

### 3.2 留在 atoma（主包）的目录（强建议）
- `src/client/internal/controllers/SyncController.ts`（变成很薄的 adapter/controller）
- `src/client/internal/controllers/SyncReplicatorApplier.ts`（这是“把协议结果落到本地 store”的域逻辑，更贴近 client/runtime）
- `src/client/internal/sync/**`（diagnostics、SSE transport、resolve config 这些属于“client wiring”）

### 3.3 类型与协议的归属（建议）
- `SyncEvent/SyncPhase/SyncRuntimeConfig/SyncClient`：归 `atoma-sync`
- `OutboxWriter/OutboxReader/CursorStore`：可继续沿用 core 的能力接口（`atoma-sync` 依赖 `atoma` 或单独复制定义都行）
  - 推荐：`atoma-sync` 依赖 `atoma`（workspace/monorepo 下非常自然），直接复用 core 的最小接口
- `Protocol` 校验（ops validate）仍在 `atoma`（协议属于基础设施）

---

## 4. atoma-sync 的对外 API（建议最小化）

建议 `atoma-sync` 的 public API 尽量小，核心只暴露：
- `createSyncEngine(config: SyncRuntimeConfig): SyncClient`
- `wantsPush(mode)` / `wantsSubscribe(mode)`（如果仍需要）
- types：`SyncClient`、`SyncRuntimeConfig`、`SyncEvent`、`SyncPhase`、`SyncMode`

避免暴露 lane、内部策略、内部错误类型（减少主包耦合）。

---

## 5. client 如何“安装并接入” atoma-sync

目标是做成类似 `slate` / `slate-react` / `slate-history` 的模式：
- `atoma`：纯本地状态库（core + protocol）
- `atoma-sync`：可选扩展（同步引擎 + lanes + 可靠性机制）
- 用户需要 sync 时才 `npm i atoma-sync`，不需要就不装

关键点：**不需要复制一遍 types**。`atoma-sync` 直接复用 `atoma` 导出的最小接口/类型（通过依赖/peer 关系保证只存在一份 `atoma` 类型来源）。

### 方案 A（仓库开发形态）：monorepo/workspace 内部包
适合本仓库持续迭代（最少摩擦），最终发布仍按方案 B：
1) 目录结构：
   - `packages/atoma/`（或保留根为 atoma）
   - `packages/atoma-sync/`
2) `atoma-sync` 的 `package.json` 依赖 `atoma`（workspace 引用）：
   - 只依赖 `atoma` 暴露出来的最小接口/类型
3) `atoma`（client）侧直接 import：
   - `import { createSyncEngine } from 'atoma-sync'`
4) 发布时按需分别发包（或只内部用，不发布也可）。

优点：
- 类型共享最顺畅（不需要复制 types）
- 开发调试最简单（同 repo 同 tsconfig 策略）

### 方案 B（最终发布形态，推荐）：外部可选依赖（用户项目 npm 安装）
目标是“主包不包含 sync，实现按需安装”，并且像 `slate-react` 一样**不复制类型**：
1) `atoma`（主包）不依赖 `atoma-sync`，保持纯 core（可包含或不包含 createClient，但不要把 sync 强行打进来）。
2) `atoma-sync` 作为独立 npm 包发布，**使用 peerDependencies 复用 atoma 的类型**：

```jsonc
// packages/atoma-sync/package.json（示意）
{
  "name": "atoma-sync",
  "peerDependencies": {
    "atoma": "^X.Y.Z"
  },
  "devDependencies": {
    "atoma": "workspace:*"
  }
}
```

3) 用户项目安装方式：
   - `npm i atoma`（只要本地状态库）
   - 需要同步时再 `npm i atoma-sync`（以及按运行环境选择 SSE polyfill）
4) client 接入方式（建议做成“显式安装/组合”，而不是主包隐式内置）：
   - `atoma` 主包不内置 createClient；对外用子入口 `atoma/client`（类似 `slate-react`）
   - `atoma/client` 内部使用 `atoma-sync` 来创建引擎（例如 `createSyncEngine(...)`）
   - `atoma/client` 侧把已归一化的 `SyncRuntimeConfig`（transport/outbox/cursor/applier/lockKey 等）交给 `atoma-sync`

优点：
- 主包依赖树最干净、体积最小
- 模式成熟（与大量生态类似：核心包 + 可选扩展包）
- 不需要复制 types（peerDependencies 确保只存在一份 `atoma` 类型来源）
缺点：
- 需要把“client sync wiring”做成可组合入口（但你不需要兼容，一次性整理边界即可）

---

## 6. 推荐引入的开源库（尽量替代自研样板）

目标：把“机制代码”交给成熟库，把“域逻辑”（outbox rebase、ack/reject 应用）留在我们代码里。

下面按优先级给出推荐组合（每类只选一个，避免依赖膨胀）。

### 6.1 状态机（强烈推荐）
用途：收敛 start/stop/dispose、lock lost、notify reconnect、push/pull backoff 等分支。
- 推荐：`xstate`（用状态机表达引擎生命周期 + lane 协调）
  - 把 sync 的“隐式状态”（started/enabled/disposed/reconnecting/backoff）显式化
  - 事件驱动（SyncEvent）天然适配

替代：如果你不想引入完整状态机，也至少引入一个“最小事件驱动状态 reducer”模型，但收益会打折。

### 6.2 重试 + 退避（强烈推荐）
用途：替代自研 retry/backoff/jitter 的拼装与边界处理。
- 推荐：`p-retry`（简单、易读，适合把“某个动作”包一层 retry）
  - 对 push/pull/notify reconnect 等动作都可以统一封装

如果更偏“策略对象/断路器”风格：
- 备选：`cockatiel`（更“可靠性工程”风格：retry、circuit breaker、timeout）

### 6.3 事件总线（推荐）
用途：替代手写 subscribers Set、emit try/catch；让 devtools/onEvent 更一致。
- 推荐：`mitt`（超轻量 emitter）
  - sync 引擎内部 event -> emitter
  - client 侧 diagnostics 可以直接订阅 emitter 或桥接

### 6.4 并发与队列（可选，但可能显著简化 PushLane）
用途：push drain 批次、并发控制、节流/串行化。
- 推荐：`p-queue`
  - 更容易表达“单并发 + batch + 触发合并”

### 6.5 SSE / 事件流解析（按环境选择）
如果 `atoma-sync` 需要在 node 环境运行（非浏览器），建议：
- 引入一个 EventSource polyfill（具体选型取决于运行目标：node18+/edge/runtime）
如果只在浏览器运行：
- 继续使用原生 `EventSource` 即可，把 “buildUrl/connect” 抽象留在 transport。

---

## 7. 迁移步骤（一次到位，破坏式）

建议按“先能跑，再逐步换库”来做，避免一次改太大失控。

### Phase 1：纯抽包（不改变行为）
- 把 `src/sync/**` 搬到 `packages/atoma-sync/src/**`
- `atoma-sync` 先保持现有实现（暂不引入新库）
- `atoma` 的 `SyncController` 改为 import `atoma-sync` 的 `createSyncEngine`

### Phase 2：引擎生命周期状态机化（xstate）
- 用 `xstate` 表达 SyncEngine 的 lifecycle + lane 启停
- lane 之间的触发（notify -> pull）通过状态机事件统一

### Phase 3：重试/退避库替换（p-retry 或 cockatiel）
- 删除自研 RetryBackoff/计时器管理的样板
- 统一 push/pull/notify 的 retry 结构与日志/事件

### Phase 4：事件总线统一（mitt）
- SyncEngine 内部 event 全走 emitter
- `onEvent/onError` 变成“订阅 emitter + 可选桥接”

### Phase 5：PushLane 队列化（p-queue，可选）
- 把“flush、批次、并发、去重/合并触发”变成一个队列模型
- outbox size/queue_full 事件从 queue 层统一发出

---

## 8. 对测试与质量的建议（抽包后）

- `atoma-sync` 单测专注于：
  - mode 行为（pull-only/push-only/full）
  - retry/backoff 触发与 stop/dispose 的正确收敛
  - notify 触发 pull 的协作逻辑
- `atoma`（client）单测专注于：
  - applier 正确应用 ack/reject/pull changes
  - wiring（resolveSyncRuntimeConfig）正确派生配置
  - diagnostics/devtools 的统计与事件桥接正确

---

## 9. 结论

把 sync 抽成 `atoma-sync` 可显著降低主包复杂度，并允许引入更成熟的库来替代样板（状态机、重试、事件总线、队列）。推荐先“纯抽包保持行为”，再逐步引入 `xstate` + `p-retry` + `mitt`（可选 `p-queue`）把 sync 的机制代码大幅减少，最终让 sync 更像“少量域逻辑 + 明确状态机”，而不是大量分支与计时器拼装。
