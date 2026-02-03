# atoma-history 适配新插件系统研究与“历史/回放/撤回统一模型”复核

本文基于仓库当前实现进行梳理，覆盖两部分：
1) atoma-history 如何接入 atoma-client 新插件系统；
2) `ATOMA_FUNCTIONAL_GAPS_AND_NEXT_STEPS.zh.md` 中“历史 / 回放 / 撤回统一模型”段落的准确性与修订建议。

---

## 一、atoma-history 适配 atoma-client 新插件系统

### 1. 现状结论（基于代码）
- `packages/atoma-history/src/index.ts` 的 `historyPlugin()` 目前直接抛错，明确标注“未完成适配”。
- `HistoryManager` 是可用的（负责记录 patches/inversePatches，并提供 undo/redo）。
- 新插件系统为 `ClientPlugin` + `register/init`：
  - `register` 用于注册 io/persist/read/observe handler；
  - `init` 负责运行时 wiring，可返回 extension；
  - `ctx.capabilities` 用于注册 devtools registry。 

因此：**history 必须通过 `init` 接入，并主动接管 runtime.write 的记录逻辑**，而不是依赖 handler 链。

### 2. 新插件系统需要的核心接入点
结合 `packages/atoma-client/src/internal/createClient.ts`：
- 插件 `init` 在 runtime 已就绪后被调用，可安全访问 `ctx.runtime`。
- devtools registry 已由 createClient 预注册（`DEVTOOLS_REGISTRY_KEY`），插件可直接注册 `history` provider。
- 插件返回的 `extension` 会合并到 client（用于对外暴露 `history` API）。

**结论：historyPlugin 只需使用 `init`，无需注册 handler。**

### 3. 推荐的适配方案（不改 core）

#### 3.1 核心思路
- 在 `init` 中创建 `HistoryManager`。
- **包装 `runtime.write` 的写入方法**，在成功写入后生成 patches/inversePatches 并 `record`。
- `undo/redo` 通过 `runtime.write.patches` 回放；`opContext.origin = 'history'` 以避免二次记录。
- 向 devtools registry 注册 `history` provider，提供 `scopes` 快照。

该方案无需改动 core/runtime，完全以插件形式实现。

#### 3.2 包装点与避免重复记录
`WriteFlow` 的 `updateMany/upsertMany/deleteMany` 会内部调用 `updateOne/upsertOne/deleteOne`。
- **只包装单体方法**：`addOne/updateOne/upsertOne/deleteOne/patches`。
- 不包装 `updateMany/upsertMany/deleteMany`，避免 double-record。

#### 3.3 patches 生成策略（建议）
利用“根路径 patch”即可满足 `HistoryManager` 与 `buildWriteIntentsFromPatches` 的使用：
- add：`patch = { op: 'add', path: [id], value: newItem }`
- update：`patch = { op: 'replace', path: [id], value: newItem }`
- delete：`patch = { op: 'remove', path: [id] }`
- inverse 对应：add↔remove、replace↔replace(旧值)

**注意**：`buildWriteIntentsFromPatches` 只依赖 root id 与 inverse root add；
根级 replace 可以满足 write intents 的生成需求。

#### 3.4 关键流程（伪代码级）
```
init(ctx):
  manager = new HistoryManager()
  runtime = ctx.runtime

  // 1) 注册 devtools provider
  registry = ctx.capabilities.get(DEVTOOLS_REGISTRY_KEY)
  registry?.register('history', { snapshot: () => buildSnapshot(manager) })

  // 2) 包装 runtime.write
  wrapWriteMethod('addOne' | 'updateOne' | 'upsertOne' | 'deleteOne' | 'patches')

  // 3) 暴露 extension
  return {
    extension: { history: { canUndo, canRedo, undo, redo, clear } },
    dispose: () => { restore original methods; unregister devtools provider }
  }
```

#### 3.5 opContext 一致性
为避免 actionId 不一致：
- 在 wrapper 内先 `normalizeOperationContext(options?.opContext)` 得到 `opContext`；
- 再将该 `opContext` 写回 options 调用原方法；
- 记录时复用同一个 `opContext`。

这样 `HistoryManager` 的 actionId 与 runtime 写入一致。

#### 3.6 对外 API（AtomaHistory）
`AtomaHistory` 类型当前定义：
- `canUndo(scope?)`
- `canRedo(scope?)`
- `undo({scope?})`
- `redo({scope?})`
- `clear(scope?)`

建议 extension 按此实现；如需更强分组能力，可额外提供 `beginAction()`/`createOpContext()`，但需同步更新 atoma-types。

#### 3.7 需要显式考虑的边界
- **乐观写入失败**：写失败会 revert，但 wrapper 仅在成功完成后 record，可接受。
- **sync/writeback 变更**：多来自 `stateWriter.applyWriteback`，不走 runtime.write，不应进入 history。
- **scope 分区**：依赖 `opContext.scope`，默认 `default`；用户如需多栈需自行传入。

---

## 四、可选方案：改造插件系统（提供通用 write hooks）

如果不希望使用 monkey-patch，可在插件系统层面补齐“通用 runtime hooks”，使 history 等插件以标准接口接入。

### 4.1 建议新增的接口（TypeScript 示例）

建议在 `atoma-types` 层新增 hooks 类型，并把注册入口放在 `ctx.hooks.register(...)`：

```ts
// packages/atoma-types/src/runtime/hooks.ts（建议新增）
import type { Patch } from 'immer'
import type * as Types from '../core'
import type { StoreHandle } from './handleTypes'

export type RuntimeWriteHookSource =
    | 'addOne'
    | 'updateOne'
    | 'upsertOne'
    | 'deleteOne'
    | 'patches'

export type RuntimeWriteStartArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    intents: Array<Types.WriteIntent<any>>
    source: RuntimeWriteHookSource
}>

export type RuntimeWritePatchesArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    patches: Patch[]
    inversePatches: Patch[]
    source: RuntimeWriteHookSource
}>

export type RuntimeWriteCommittedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    result?: unknown
}>

export type RuntimeWriteFailedArgs = Readonly<{
    handle: StoreHandle<any>
    opContext: Types.OperationContext
    error: unknown
}>

export type RuntimeHooks = Readonly<{
    write?: Readonly<{
        onStart?: (args: RuntimeWriteStartArgs) => void
        onPatches?: (args: RuntimeWritePatchesArgs) => void
        onCommitted?: (args: RuntimeWriteCommittedArgs) => void
        onFailed?: (args: RuntimeWriteFailedArgs) => void
    }>
    store?: Readonly<{
        onCreated?: (args: { handle: StoreHandle<any>; storeName: string }) => void
    }>
}>

export type RuntimeHookRegistry = Readonly<{
    register: (hooks: RuntimeHooks) => () => void
    has: Readonly<{ writePatches: boolean }>
    emit: Readonly<{
        writeStart: (args: RuntimeWriteStartArgs) => void
        writePatches: (args: RuntimeWritePatchesArgs) => void
        writeCommitted: (args: RuntimeWriteCommittedArgs) => void
        writeFailed: (args: RuntimeWriteFailedArgs) => void
        storeCreated: (args: { handle: StoreHandle<any>; storeName: string }) => void
    }>
}>
```

说明：
- `RuntimeHookRegistry` 用于聚合多个插件 hook，并提供 `has.writePatches` 来决定是否生成 patches。
- `ctx.hooks.register(...)` 是唯一入口，避免多入口的理解成本与动态注册能力缺失。

### 4.2 运行时实现方案（改动点清单）

1) **新增 HookRegistry 实现**  
   - 位置建议：`packages/atoma-runtime/src/runtime/registry/HookRegistry.ts`  
   - 负责：注册/注销 hooks，维护 `has.writePatches`，并提供 emit 方法。

2) **Runtime 增加 hooks**  
   - `packages/atoma-runtime/src/runtime/Runtime.ts`  
   - 新增 `hooks: RuntimeHookRegistry` 字段，构造时传入或默认空实现。

3) **createClient 暴露 hooks 注册入口**  
   - `packages/atoma-client/src/internal/createClient.ts`  
   - 在 `PluginContext` 增加 `hooks` 字段（指向 `runtime.hooks`），插件在 `init` 中直接调用 `ctx.hooks.register(...)`。

4) **WriteFlow 触发 hooks**  
   - `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`  
   - 触发时机建议：
     - `writeStart`：构建 intents 后、持久化前
     - `writePatches`：只有 `has.writePatches === true` 时生成 patches 并 emit
     - `writeCommitted`：持久化成功后
     - `writeFailed`：持久化异常/回滚后

5) **Store 创建通知**  
   - `packages/atoma-runtime/src/store/Stores.ts`  
   - 在 `notifyCreated` 时触发 `runtime.hooks.emit.storeCreated(...)`。

### 4.3 patches 生成的建议实现

为了保持通用性与性能，建议按如下策略生成 patches：
- 只有 `runtime.hooks.has.writePatches` 为 true 时才生成 patches。
- `updateOne` 可改用 `produceWithPatches` 获得 patches/inversePatches。
- `addOne/upsertOne/deleteOne` 用 root 级 patch 合成：
  - add: `{ op: 'add', path: [id], value: newItem }`
  - update/upsert: `{ op: 'replace', path: [id], value: newItem }`
  - delete: `{ op: 'remove', path: [id] }`
- `patches()` 方法直接转发调用参数并 emit。

### 4.4 history 插件的接入方式（不再 monkey-patch）

history 插件只需订阅 hooks：  
- `onPatches` 中 `origin === 'user'` 时 `HistoryManager.record(...)`。  
- `undo/redo` 走 `runtime.write.patches(...)`，并设置 `origin: 'history'`。  
- devtools provider 继续使用 `DEVTOOLS_REGISTRY_KEY` 注册 `history` snapshot。

该方案形成稳定扩展点：history、审计、指标、调试回放都可统一接入。

---

## 二、“历史 / 回放 / 撤回统一模型”段落复核

### 1. 现有表述的主要问题
对应 `ATOMA_FUNCTIONAL_GAPS_AND_NEXT_STEPS.zh.md` 第 4 节：

1) **“history/replay 能工作”与当前事实不一致**
   - 现有 `atoma-history` 插件未适配新插件系统（直接抛错）。
   - 仅有 `HistoryManager`，但没有 wiring，因此“能工作”不成立。

2) **“历史 / 回放 / 撤回统一模型”表述过于抽象，缺少层级拆分**
   - undo 需要“可逆变化”（inverse patches / 前值），而 sync 通常依赖“可传播变化”（write ops / change log）。
   - debug replay 更偏“可复现 trace”，与 undo / sync 并非同一层级。

3) **未显式考虑 dataProcessor 的 inbound/outbound/writeback**
   - undo 若只记录 outbound write op，无法保证回滚到当前 store 的真实形态。
   - replay 若不记录 transform 结果与版本信息，可能无法稳定复现。

4) **缺少对冲突/回滚的说明**
   - local-first/queue 可能出现后续 reject 或 writeback 覆盖，统一模型必须说明“冲突归一策略”与“事件最终态”。

### 2. 建议的修订方向（更具体）
建议将“统一模型”拆成三层，并明确各层目标：

- **Layer A：Undo/Redo（本地、可逆）**
  - 记录 inverse patches（或前值快照）。
  - 只针对 `origin='user'`。
  - 依赖 `opContext.actionId` 进行动作聚合。

- **Layer B：Sync/Replication（跨端、可传播）**
  - 使用 write ops / change log；保证可重放、可对齐版本。
  - 不要求可逆，但要求幂等与冲突策略可解释。

- **Layer C：Replay/Trace（可复现）**
  - 依赖 DebugEvent/TraceEvent，强调顺序、上下文与输入。
  - 仅在必要时与 Layer A/B 对齐（例如对齐 actionId）。

这三层可共享 **事件元信息**（actionId/scope/traceId），但**不一定共享事件载荷**。

### 3. 建议的替换文本（可直接更新原文）
可替换第 4 节“建议”为以下更精确的表述：

- 建议
  - 明确拆分三层：Undo/Redo（可逆补丁）、Sync（可传播变更）、Replay（可复现 trace）。
  - 三层共享 actionId/scope/traceId，但载荷可不同：
    - Undo/Redo 使用 inverse patches（或前值快照）；
    - Sync 使用 write ops/change log；
    - Replay 使用 DebugEvent/TraceEvent。
  - 只有在定义“统一的事件语义 + 变换阶段（inbound/outbound/writeback）”后，才考虑进一步合并载荷格式。

并更新“现状”描述：
- history 插件尚未适配新插件系统，仅有 HistoryManager；实际功能尚未 wiring。

---

## 三、最终结论
- **atoma-history 适配方案可完全基于插件 init + runtime.write 包装实现**，无需改动 core。
- 当前“历史/回放/撤回统一模型”章节存在事实与表述层级问题，建议按“三层模型 + 共享元信息”的思路修订。
- 若按本方案落地，建议同步补充测试：
  - 单 store undo/redo
  - 多 store 同 actionId 聚合
  - origin=sync/history 不入栈
  - optimistic/reject 情况下的历史一致性
