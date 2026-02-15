# Atoma Devtools 最优架构 V2（能力协商 + 动态面板 + 四通道）

更新时间：2026-02-15

## 1. 结论

`DEVTOOLS_OPTIMAL_ARCHITECTURE.md` 的单层 `DebugProvider` 方案是正确方向，但只适合 V1 最小可用。  
面向“本体 store/index 深度调试 + 未来插件调试生态”的最优解应升级为：

1. 保留单层“数据生产者”模型，不引入 `projector`。
2. 将生产者从“仅 snapshot”升级为四通道能力：
   1. `catalog`：声明自己是谁、能做什么、可渲染到哪些面板。
   2. `snapshot(query)`：按需拉取结构化快照（支持分页/筛选）。
   3. `stream(subscribe)`：推送事件（timeline / invalidation / telemetry）。
   4. `command(invoke)`：执行调试动作（如 undo/redo/start/stop/replay）。
3. Devtools UI 改为能力驱动的动态面板，不再固定 `store/index/sync/history/trace` 枚举。
4. 内置 `Raw` 面板作为永久兜底，未知插件零改动可观测。
5. 不保留兼容层，直接重构到目标模型。

---

## 2. 设计目标

1. 可扩展：新增插件不改 devtools 核心即可接入。
2. 高性能：去除固定轮询，改为事件驱动失效 + 按需查询。
3. 可交互：不仅“看数据”，还可执行调试命令。
4. 统一语义：store/index/sync/history/trace 全部走同一协议。
5. 依赖单向：业务插件只依赖 `atoma-types/devtools` 协议。

## 3. 非目标

1. 不追求一开始就做“业务专用花哨面板”。
2. 不保留旧 `ClientSnapshot` 固定结构并存（旧名：`DevtoolsClientSnapshot`）。
3. 不做“未安装插件时占位伪数据”。

---

## 4. 依赖边界（必须遵守）

1. `atoma-types/devtools`：协议与 token（纯类型契约）。
2. `atoma-client` 与业务插件：调试 source 生产者。
3. `atoma-devtools`：source 消费者与通用 UI。
4. 禁止业务插件依赖 `atoma-devtools` 运行时代码。
5. 禁止 `atoma-devtools` 依赖业务插件实现细节。

---

## 5. 核心协议（V2，命名重设计）

## 5.1 基础类型

```ts
type PanelId = string
type SourceId = string

type Capability = Readonly<{
    snapshot?: boolean
    stream?: boolean
    command?: boolean
    schema?: boolean
    search?: boolean
    paginate?: boolean
}>

type PanelSpec = Readonly<{
    id: PanelId
    title: string
    order?: number
    icon?: string
    renderer?: 'table' | 'tree' | 'timeline' | 'stats' | 'raw'
}>
```

## 5.2 Source 声明

```ts
type CommandSpec = Readonly<{
    name: string
    title?: string
    argsJson?: string
}>

type SourceSpec = Readonly<{
    id: SourceId
    clientId: string
    namespace: string        // 例如: runtime.store / runtime.index / sync / history / obs.trace
    title: string
    priority?: number
    panels: PanelSpec[]
    capability: Capability
    tags?: string[]
    commands?: CommandSpec[] // 用于 UI 快捷命令入口
}>
```

## 5.3 查询/快照

说明：`storeName` 使用 `atoma-types/core` 的 `StoreToken`。

```ts
type SnapshotQuery = Readonly<{
    panelId?: PanelId
    storeName?: StoreToken
    filter?: Record<string, unknown>
    search?: string
    cursor?: string
    limit?: number
}>

type Snapshot = Readonly<{
    version: 1
    sourceId: SourceId
    clientId: string
    panelId?: PanelId
    revision: number
    timestamp: number
    data: unknown
    page?: { cursor?: string; nextCursor?: string; totalApprox?: number }
    meta?: { title?: string; tags?: string[]; warnings?: string[] }
}>
```

## 5.4 事件流

```ts
type StreamEvent = Readonly<{
    version: 1
    sourceId: SourceId
    clientId: string
    panelId?: PanelId
    type:
        | 'source:registered'
        | 'source:unregistered'
        | 'data:changed'
        | 'timeline:event'
        | 'command:result'
        | 'error'
    revision?: number
    timestamp: number
    payload?: unknown
}>
```

## 5.5 调试命令

```ts
type Command = Readonly<{
    sourceId: SourceId
    name: string
    args?: Record<string, unknown>
}>

type CommandResult = Readonly<{
    ok: boolean
    message?: string
    data?: unknown
}>
```

## 5.6 Hub 接口

```ts
type Source = Readonly<{
    spec: SourceSpec
    snapshot?: (query?: SnapshotQuery) => Snapshot
    subscribe?: (fn: (event: StreamEvent) => void) => () => void
    invoke?: (command: Command) => Promise<CommandResult> | CommandResult
}>

type Hub = Readonly<{
    register: (source: Source) => () => void
    list: (args?: { clientId?: string; panelId?: string; namespace?: string }) => SourceSpec[]
    snapshot: (args: { sourceId: SourceId; query?: SnapshotQuery }) => Snapshot
    subscribe: (
        args: { clientId?: string; sourceIds?: string[]; panelId?: string },
        fn: (event: StreamEvent) => void
    ) => () => void
    invoke: (command: Command) => Promise<CommandResult>
}>
```

---

## 6. 包内职责拆分

## 6.1 atoma-client（内置 source）

1. 注册 `runtime.store` source：实体计数、样本、容量、可选分页。
2. 注册 `runtime.index` source：索引状态、query plan、候选量统计。
3. 仅负责数据生产，不做 UI 组装。

## 6.2 atoma-sync

1. 提供 `sync` source（状态 + 队列 + timeline 事件）。
2. 暴露 `command`：`sync.start`、`sync.stop`、`sync.pull`、`sync.push`。

## 6.3 atoma-history

1. 提供 `history` source（scope 栈状态 + timeline 事件）。
2. 暴露 `command`：`history.undo`、`history.redo`、`history.clear`。

## 6.4 atoma-observability

1. 提供 `obs.trace` source（按 traceId/requestId 检索事件）。
2. 面板声明可指向 `timeline` 或 `trace`。

## 6.5 atoma-devtools

1. 仅读取 `Hub`，按 source/panel 动态生成 UI。
2. 提供通用渲染器：`table/tree/timeline/raw`。
3. 未知 renderer 或未知数据结构统一回退 `raw`。

---

## 7. UI 架构

## 7.1 动态面板生成

1. 面板集合来自 `list({ clientId })` 的 `spec.panels` 聚合去重。
2. 排序规则：`panel.order` -> `source.priority` -> `source.id`。
3. 不再硬编码固定 tabs。

## 7.2 数据加载策略

1. 切换到面板时按需调用该面板相关 source 的 `snapshot(query)`。
2. 收到 `data:changed` 且命中当前 panel/source 时局部刷新。
3. 后台面板不主动刷新。

## 7.3 事件时间线

1. `timeline:event` 进入面板本地 ring buffer。
2. 支持按 source/storeName/traceId 过滤。
3. buffer 超限按 FIFO 丢弃，保证 UI 常驻稳定。

---

## 8. 性能与安全预算（硬约束）

1. 单 source 默认事件 buffer 上限：1000。
2. 全局事件上限：10000。
3. 单条事件 payload 默认软上限：64KB（超限截断并标记）。
4. `snapshot(limit)` 默认 100，最大 1000。
5. Hub 内部必须有异常隔离：source 抛错不影响其他 source。
6. 支持 payload sanitizer/redact 钩子，避免敏感信息直出。

---

## 9. 重构路径（一步到位，无兼容）

1. 在 `atoma-types/devtools` 定义 V2 协议（source/capability/panel/event/command）。
2. 将 `atoma-client` 内置 debug 重构为 `runtime.store` + `runtime.index` source。
3. 将 `atoma-sync`、`atoma-history` provider 升级为 source，接入 command。
4. 给 `atoma-observability` 增加 `obs.trace` source，接入 timeline。
5. 删除 `atoma-devtools` 中固定 snapshot 类型：
   1. 删除 `ClientSnapshot`、`StoreSnapshot` 等固定结构（旧名：`DevtoolsClientSnapshot`、`DevtoolsStoreSnapshot`）。
   2. 删除 `inspector.ts` 中按 kind 的硬编码解包逻辑。
6. UI 改为 `spec` 驱动的动态 tab + 通用 renderer。
7. 删除 500ms 全量轮询，改为订阅驱动 + 可见面板按需快照。
8. 保留 `Raw` 作为永久兜底。

---

## 10. 验收标准

1. 新增任意插件，仅注册 source 即可自动出现在 devtools。
2. 插件卸载后对应面板/数据自动消失，不报错。
3. 在 10+ source 并发事件下 UI 不卡死、内存不持续增长。
4. 无固定业务 tab 枚举、无业务硬编码解析链。
5. `pnpm --filter atoma-devtools run typecheck` 通过。
6. `pnpm typecheck` 全仓通过。

---

## 11. 命名与术语约定

1. `core/runtime/client` 仍使用 `StoreToken` 与 `storeName`。
2. `sync/transport/protocol` 仍使用 `ResourceToken` 与 `resource`。
3. `atoma-types/devtools` 子路径内公开类型/常量不带 `Devtools` 前缀。
4. 协议命名统一为短语义：`Hub`、`Source`、`SourceSpec`、`PanelSpec`、`Snapshot`、`StreamEvent`、`Command`、`HUB_TOKEN`。
5. Devtools 协议层不引入新的业务术语别名。
6. `namespace` 只表达来源语义，不重复路径前缀。

---

## 12. 风险与应对

1. 风险：插件 source 质量参差导致 UI 崩溃。
   1. 应对：Hub 做 schema guard + try/catch + 错误事件化。
2. 风险：事件风暴导致性能退化。
   1. 应对：ring buffer、节流刷新、后台面板暂停渲染。
3. 风险：命令能力滥用。
   1. 应对：命令白名单 + 明确返回错误码 + 可选只读模式。

---

## 13. 与 V1 的关系

1. V1 的“单层生产者、无 projector”原则保留。
2. V2 新增能力协商与四通道，解决 V1 在扩展性、交互性、性能上的结构性不足。
3. V2 是 V1 的替代，不是兼容叠加。

---

## 14. 改造任务单（按包拆分，可直接执行）

说明：以下任务默认“全量替换，不保留旧名与旧协议并存”。

## 14.1 Task A：协议层（atoma-types/devtools）

目标：把当前 `DebugProvider/DebugHub` 升级为 V2 `Source/Hub`。

1. 文件改造：
   1. 修改 `packages/atoma-types/src/devtools/index.ts`，删除旧 `DebugProvider/DebugHub` 类型。
   2. 新增 V2 类型：`PanelSpec`、`SourceSpec`、`SnapshotQuery`、`Snapshot`、`StreamEvent`、`Command`、`CommandResult`、`Source`、`Hub`。
2. token 改造：
   1. 将 `DEBUG_HUB_TOKEN` 直接替换为 `HUB_TOKEN`。
3. 验收：
   1. 全仓无 `DebugProvider`、`DebugHub` 旧类型引用。
   2. `pnpm --filter atoma-types run typecheck` 通过。

## 14.2 Task B：Hub 实现与 client 内置 source（atoma-client）

目标：`createClient` 默认提供 V2 hub，并注册 `runtime.store/runtime.index` source。

1. 文件改造：
   1. 重写 `packages/atoma-client/src/debug/debugHub.ts` 为 V2 hub（`register/list/snapshot/subscribe/invoke`）。
   2. 重写 `packages/atoma-client/src/plugins/builtinDebugPlugin.ts` 为 builtin devtools source 插件：
      1. `runtime.store` source
      2. `runtime.index` source
2. createClient 链路：
   1. 确保 `packages/atoma-client/src/createClient.ts` 始终安装内置 devtools hub/source 插件。
3. 性能约束：
   1. hub 内置事件上限、payload 截断、异常隔离。
4. 验收：
   1. 不安装 `atoma-devtools` 时也能注册 source（仅不可视化）。
   2. `pnpm --filter atoma-client run typecheck` 通过。

## 14.3 Task C：业务插件 source 化（sync/history/observability）

目标：业务插件统一以 source 接口对外提供调试能力。

1. `atoma-sync`：
   1. `packages/plugins/atoma-sync/src/plugin.ts` 注册 `sync` source。
   2. 实现 `invoke`：`sync.start/sync.stop/sync.pull/sync.push`。
2. `atoma-history`：
   1. `packages/plugins/atoma-history/src/plugin.ts` 注册 `history` source。
   2. 实现 `invoke`：`history.undo/history.redo/history.clear`。
3. `atoma-observability`：
   1. `packages/plugins/atoma-observability/src/plugin.ts` 注册 `obs.trace` source。
   2. 提供按 `traceId/requestId/type` 查询及 timeline 事件推送。
4. 验收：
   1. 插件卸载后 source 自动消失。
   2. 三个包各自 typecheck 通过。

## 14.4 Task D：devtools 消费端重构（atoma-devtools）

目标：删除固定 snapshot 模型，改为 `spec/capability` 驱动 UI。

1. runtime 层：
   1. 删除 `packages/plugins/atoma-devtools/src/runtime/types.ts` 里的固定业务快照类型。
   2. 删除 `packages/plugins/atoma-devtools/src/runtime/inspector.ts` 的 kind 硬编码解析链。
   3. 新增通用 view-model 组装层：基于 `list/snapshot/subscribe/invoke`。
2. UI 层：
   1. `packages/plugins/atoma-devtools/src/ui/DevtoolsApp.tsx` 改为动态 tab（来源 `spec.panels`）。
   2. 删除固定 tabs 组件常量（`store/index/sync/history/trace`）。
   3. 新增通用 renderer：`table/tree/timeline/raw`。
   4. 若 source 声明 `commands`，渲染快捷命令按钮并可一键填充 `command + args`。
3. 刷新策略：
   1. 去掉固定 500ms 全量轮询。
   2. 改为“事件失效 + 当前可见面板按需 snapshot”。
4. 验收：
   1. 无固定业务 tab 枚举。
   2. 未知插件数据可在 `Raw` 面板展示。
   3. `pnpm --filter atoma-devtools run typecheck` 通过。

## 14.5 Task E：demo 与验证

目标：demo 作为系统验收场。

1. 更新 `demo/web`，移除旧 devtools probe 依赖。
2. 使用新 hub/source API 展示动态面板与命令调用。
3. 验收场景：
   1. 仅安装 client：出现 store/index 面板。
   2. 安装 sync/history/observability：对应面板自动出现。
   3. 卸载任意插件：对应面板自动消失。
4. 最终验证：
   1. `pnpm --filter atoma-devtools run typecheck`
   2. `pnpm --filter atoma-client run typecheck`
   3. `pnpm --filter atoma-sync run typecheck`
   4. `pnpm --filter atoma-history run typecheck`
   5. `pnpm --filter atoma-observability run typecheck`
   6. `pnpm typecheck`

---

## 15. 示例代码（source 产出与 devtools 消费）

以下代码是最小骨架，用于说明协议落地方式。

## 15.1 生产端：插件注册 source

```ts
import type { ClientPlugin } from 'atoma-types/client/plugins'
import {
    HUB_TOKEN,
    type Source
} from 'atoma-types/devtools'

export function exampleStatsPlugin(): ClientPlugin {
    return {
        id: 'example.stats',
        setup: (ctx) => {
            const hub = ctx.services.resolve(HUB_TOKEN)
            if (!hub) return

            let revision = 0
            const sourceId = `example.stats.${ctx.clientId}`

            const source: Source = {
                spec: {
                    id: sourceId,
                    clientId: ctx.clientId,
                    namespace: 'example.stats',
                    title: 'Example Stats',
                    priority: 100,
                    panels: [
                        { id: 'stats', title: 'Stats', order: 100, renderer: 'table' },
                        { id: 'raw', title: 'Raw', order: 999, renderer: 'raw' }
                    ],
                    capability: {
                        snapshot: true,
                        stream: true,
                        command: true
                    },
                    commands: [
                        { name: 'stats.reset', title: 'Reset' }
                    ]
                },
                snapshot: (query) => {
                    const limit = Math.min(Math.max(Number(query?.limit ?? 50), 1), 1000)
                    return {
                        version: 1,
                        sourceId,
                        clientId: ctx.clientId,
                        panelId: query?.panelId ?? 'stats',
                        revision,
                        timestamp: ctx.runtime.now(),
                        data: {
                            rows: [
                                { key: 'storeCount', value: 3 },
                                { key: 'activeJobs', value: 7 }
                            ].slice(0, limit)
                        }
                    }
                },
                subscribe: (emit) => {
                    const stop = ctx.events.register({
                        write: {
                            onCommitted: () => {
                                revision += 1
                                emit({
                                    version: 1,
                                    sourceId,
                                    clientId: ctx.clientId,
                                    panelId: 'stats',
                                    type: 'data:changed',
                                    revision,
                                    timestamp: ctx.runtime.now()
                                })
                            }
                        }
                    })

                    return () => {
                        try {
                            stop()
                        } catch {
                            // ignore
                        }
                    }
                },
                invoke: async (request) => {
                    if (request.name === 'stats.reset') {
                        revision += 1
                        return { ok: true, message: 'reset done' }
                    }
                    return { ok: false, message: `unknown command: ${request.name}` }
                }
            }

            const unregister = hub.register(source)
            return {
                dispose: () => {
                    try {
                        unregister()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
```

## 15.2 消费端：devtools 插件创建 inspector

```ts
import type { ClientPlugin } from 'atoma-types/client/plugins'
import { HUB_TOKEN } from 'atoma-types/devtools'

export function devtoolsPlugin(): ClientPlugin {
    return {
        id: 'atoma-devtools',
        setup: (ctx) => {
            const hub = ctx.services.resolve(HUB_TOKEN)
            if (!hub) throw new Error('[Atoma Devtools] hub missing')

            const getPanels = () => {
                const specs = hub.list({ clientId: ctx.clientId })
                const panels = new Map<string, { id: string; title: string; order: number }>()
                for (const source of specs) {
                    for (const panel of source.panels) {
                        const order = panel.order ?? 500
                        if (!panels.has(panel.id)) {
                            panels.set(panel.id, { id: panel.id, title: panel.title, order })
                        }
                    }
                }
                return Array.from(panels.values()).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
            }

            const getCommands = (sourceId: string) => {
                const source = hub.list({ clientId: ctx.clientId }).find((item) => item.id === sourceId)
                return source?.commands ?? []
            }

            const snapshotPanel = (panelId: string) => {
                const specs = hub.list({ clientId: ctx.clientId, panelId })
                return specs.map((source) => {
                    return hub.snapshot({
                        sourceId: source.id,
                        query: { panelId, limit: 100 }
                    })
                })
            }

            const unsubscribe = hub.subscribe({ clientId: ctx.clientId }, (event) => {
                if (event.type !== 'data:changed') return
                // 触发 UI 局部刷新：仅刷新当前可见 panel/source
            })

            void getPanels
            void getCommands
            void snapshotPanel

            return {
                dispose: () => {
                    try {
                        unsubscribe()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
```

---

## 16. 实施顺序建议（低风险）

1. 先完成 Task A（协议）+ Task B（hub 与 builtin source）。
2. 再完成 Task D（devtools 消费端），确保新协议可视化闭环先跑通。
3. 然后并行推进 Task C（sync/history/observability）。
4. 最后做 Task E（demo 与全仓验收）。
