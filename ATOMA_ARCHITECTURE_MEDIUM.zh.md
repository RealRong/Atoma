# 从一个 Store API 到可扩展数据内核：Atoma 三层架构实践

> 如果你只看使用层，Atoma 很像一个“有本地缓存能力的 Store 库”。
> 但它的核心目标不是再造一个 API，而是把“本地状态、远端执行、关系投影、写入一致性”放进同一套可演进的内核里。

这篇文章我会先用产品视角把组件讲清楚，再进入架构决策。

不会一上来谈模式，不会先给结论。
先回答更重要的问题：**每一层到底是什么，它在系统里扮演什么角色。**

---

## 1）先看全景：Atoma 里有哪些核心组件？

在真实项目里，Atoma 不是一个包，而是一组分层协作的包：

- `atoma-client`：应用入口层（你最先接触的那层）
- `atoma-runtime`：运行时内核层（真正执行读写流程）
- `atoma-core`：纯算法层（不关心网络和框架）
- `atoma-react`：视图绑定层（让 React 用起来舒服）
- `atoma-types`：契约层（类型与协议定义）

如果只看一句话：

- `client` 负责“把系统装起来”
- `runtime` 负责“把事情跑起来”
- `core` 负责“把规则算清楚”

---

## 2）每个组件是什么（先讲角色，再讲设计）

## 2.1 `atoma-client`：应用真正调用的入口

你在业务里通常只做这几件事：

1. `createClient(...)`
2. 提供 schema / plugins
3. 通过 `client.stores.xxx` 调用 `query/get/update/...`

从职责上讲，`atoma-client` 像一个“装配器 + 启动器”：

- 创建 runtime 实例
- 注册默认执行路由（本地直连）
- 加载插件（例如 HTTP 后端插件）
- 暴露稳定的 Store API 给业务

关键点：它自己不定义读写语义，不重复实现 Query/Write 规则，语义都下沉到 runtime。

换句话说：`client` 是“你和内核之间的门面层”，而不是“第二套内核”。

---

## 2.2 `atoma-runtime`：系统的大脑和调度中枢

`runtime` 是 Atoma 的核心现场。

你可以把它理解为一个拥有多个子系统的 orchestrator：

- `read`：读流程入口（`ReadFlow`）
- `write`：写流程入口（`WriteFlow`）
- `execution`：执行内核（路由解析、执行器分发、错误与事件）
- `transform`：数据处理流水线（inbound/outbound/writeback）
- `stores`：store 目录与句柄管理
- `events`：读写事件总线
- `engine`：对 core 能力的统一编排入口（query/mutation/relation/index/action）

业务侧看到的是几个简单方法；runtime 内部做的是流程编排、策略决策和一致性保证。

所以 runtime 的价值不是“功能多”，而是：
**把复杂决策集中在一个地方，避免每个上层模块各自做一遍。**

---

## 2.3 `atoma-core`：纯逻辑引擎，不碰外部世界

`core` 里放的不是“应用逻辑”，而是“与环境无关的算法与规则”：

- 查询：`runQuery`（filter/sort/page）
- 索引：候选集收集与匹配策略
- 写入底座：mutation / writeback
- 关系：plan 与 project
- action context 的纯构造逻辑

它不关心：

- route 是什么
- 执行器是谁
- 数据来自本地还是远端
- React 有没有渲染

只关心“输入是什么、输出应该是什么”。

这让它天然具备三个特质：

- 易测（纯函数或近纯函数）
- 稳定（受外部变化影响小）
- 可复用（runtime、插件都能复用同一套规则）

---

## 2.4 `atoma-react`：把内核能力变成 UI 可消费能力

`atoma-react` 的位置很明确：

- 通过 `StoreBindings` 读取 snapshot / subscribe
- 复用 runtime 的 relation 投影与预取能力
- 提供 `useQuery`、`useRelations` 等 hook

它不反向入侵 runtime，也不重写 query/write 语义。

这层解决的是“开发体验问题”，不是“内核语义问题”。

---

## 2.5 `atoma-types`：系统的法律文本

任何分层系统要长期稳定，都需要“契约先于实现”。

`atoma-types` 做的就是这件事：

- 定义 Store/Runtime/Execution/Write/Query 的类型契约
- 定义执行协议（query/write request/output）
- 定义关系与读写选项等公共结构

你可以把它看成“跨包通信协议”。
没有这层，分层很容易退化成“名义分层”。

---

## 3）一条真实调用链：从 `store.query` 到结果返回

先不谈“为什么这样设计”，先看系统是怎么动起来的。

当业务代码调用：

```ts
const result = await stores.posts.query({
    filter: { op: 'eq', field: 'authorId', value: userId },
    sort: [{ field: 'createdAt', dir: 'desc' }]
})
```

系统内部大致会走：

1. `atoma-client` 暴露的 store facade 接到调用
2. 转发到 `runtime.read.query(...)`
3. `ReadFlow` 调 `execution.query(...)`
4. `ExecutionKernel` 根据 route 解析到具体 executor
5. executor 执行（本地 or 远端）
6. 若远端返回，先走 `transform.writeback`，再写入 store state
7. `ReadFlow` 发出 `readFinish`，返回统一结果结构

用户只写一行 query，但内部把“执行策略”和“缓存一致性”都吃掉了。

---

## 4）`execution route` 在这张图里到底是什么

很多同类系统会把“本地执行”和“远端执行”写死到分支里。
Atoma 的做法是：把它抽象成 route + executor。

一个 route 本质上是一条可命名的执行策略：

- 指定 query 由哪个 executor 执行
- 指定 write 由哪个 executor 执行
- 可附加一致性策略（例如写入时是否允许补读 base）

路由解析顺序非常直接：

1. 调用时显式 `options.route`
2. 否则使用 `defaultRoute`
3. 都没有就报错（显式失败）

它解决了一个很现实的问题：

- 同一个 Store API，在不同部署形态下可以走不同执行后端
- 但 API 语义保持不变

例如：

- 本地开发：`direct-local`
- 在线环境：`direct-http`

业务代码不用改 query/write 调用方式。

---

## 5）ReadFlow 是什么：它不只是“读数据”

`ReadFlow` 有 5 个入口：

- `query`
- `queryOne`
- `list`
- `get`
- `getMany`

它做的事情是“读编排”，不是“读实现”。

一个典型读取过程包含三类职责：

## A. 观测职责

- 统一发 `readStart` / `readFinish`
- 记录 duration

## B. 执行职责

- 把 query 请求交给 `ExecutionKernel`
- 由内核选中 executor 执行

## C. 一致性职责

- 本地 source：直接返回实体
- 远端 source：先 writeback 归一化，再写入 state，再返回 snapshot 中的实体引用

为什么强调最后这一步？

因为“远端返回的数据”不等于“系统认可的数据”。
先过 writeback，再回到 store，才能让读写两侧共享同一数据语义。

另外，`list/getMany` 的处理都是朝“单义”收敛：

- `list` 会在远端结果下执行同步语义（包含删除对齐）
- `getMany` 是全量读取语义，避免“部分命中时行为模糊”

---

## 6）WriteFlow 是什么：它本质是一条小型事务流水线

写入比读取复杂得多，因为要处理：

- 业务 intent
- 版本控制
- 一致性策略
- optimistic 提交与失败回滚
- 批量写入的结果模型

所以 WriteFlow 被拆成多阶段：

## 阶段 1：Intent 归一化

`create/update/upsert/delete` 统一在 `compileIntentToPlan` 中完成 prepare + outbound 处理。

这一步把“API 形状”统一成“可提交计划”。

## 阶段 2：Plan 构建

`compileIntentToPlan` 生成 `WritePlan`：

- 生成 `entries + optimisticChanges`
- 补全 meta（幂等键、客户端时间）
- 根据 action 补 baseVersion / upsert 选项
- outbound 后得到最终可持久化 entry

这一步把“变化语义”翻译成“执行协议”。

## 阶段 3：Commit 执行

`WriteCommitFlow` 负责真正提交：

- 根据 route consistency 判定 optimistic/confirm 策略
- optimistic 时先应用本地变更
- 调 `execution.write` 执行远端/本地写
- 解析 `WriteItemResult`，做 writeback 与 versionUpdate
- 失败则回滚 optimistic 更改

这一整套流程确保：

- 写入不是黑盒
- 策略不是散落在调用点
- 失败恢复路径是明确的

---

## 7）`atoma-sync`：为什么它最能说明“复杂度留在插件层”

如果前面的内容还比较“原则化”，`atoma-sync` 是最具体、最有说服力的落地样本。

因为同步是一个天然高复杂度问题：离线、重试、去重、冲突、回放、跨标签页竞争、通知风暴……
但在 Atoma 里，这些复杂度基本都被限制在 sync 插件内部，没有扩散进 runtime/core 的公共语义。

先讲它是什么，再讲它如何解耦。

### 7.1 `atoma-sync` 的职责清单（它到底做了什么）

`atoma-sync` 是一个可选插件包，核心是 `SyncEngine`，负责：

- 写入侧：把本地成功写操作放入 outbox，并异步 push 到服务端
- 拉取侧：按 cursor 周期性/手动拉取远端变化（pull）
- 通知侧：通过 SSE 订阅 notify，再触发增量 pull
- 回放侧：把 ack/reject/pull changes 统一写回本地 store
- 可靠性：重试退避、singleflight、防并发实例锁、in-flight 恢复
- 可观测：输出 sync 事件流并对接 devtools hub

注意：这些都不是 runtime 内核的“默认负担”，而是插件按需提供的能力。

### 7.2 它怎么接进系统（而不是侵入系统）

`atoma-sync` 不是通过“改 Runtime 类”接入，而是通过插件契约接入：

- 依赖 `PluginContext.runtime` 暴露的稳定能力：
  - `runtime.execution.subscribe(...)` 监听写成功事件
  - `runtime.stores.query/applyWriteback/applyChanges` 回放结果
  - `runtime.execution.apply/subscribe` 执行与观测能力
- 依赖 service token 注入驱动：
  - `sync.transport`（push/pull）
  - `sync.subscribe.transport`（notify）

也就是说，sync 插件只消费公开扩展面，不读取 runtime 私有状态，不反向耦合 core。

一个典型接入方式大概是这样：

```ts
import { createClient } from 'atoma-client'
import { httpBackendPlugin } from 'atoma-backend-http'
import {
    syncPlugin,
    syncOperationDriverPlugin,
    sseSubscribeDriverPlugin
} from 'atoma-sync'

const client = createClient({
    plugins: [
        httpBackendPlugin({ baseURL: 'https://api.example.com' }),
        syncOperationDriverPlugin(), // 把 operation client 适配为 sync.transport
        sseSubscribeDriverPlugin({ baseURL: 'https://api.example.com' }), // 提供 sync.subscribe.transport
        syncPlugin({ mode: 'full' }) // 组装 outbox/push/pull/notify
    ]
})
```

这里可以看到四个层级职责非常清晰：

- `httpBackendPlugin` 提供远端 ops 能力
- `syncOperationDriverPlugin` 做协议适配（ops -> SyncTransport）
- `sseSubscribeDriverPlugin` 提供通知通道
- `syncPlugin` 只做同步编排，不关心具体后端实现细节

### 7.3 三条 lane：把同步拆成可替换的流水线

`SyncEngine` 内部不是一个大循环，而是 3 条职责单一的 lane：

1. `PushLane`
   - 从 outbox `reserve` 一批写入
   - 调 `transport.pushWrites`
   - 按 outcome 分 ack/reject/retry
   - 调 `applier` 写回本地，再 `outbox.commit`

2. `PullLane`
   - 从 `cursor store` 读当前 cursor
   - 调 `transport.pullChanges`
   - 调 `applier.applyPullChanges`
   - 成功后 `cursor.advance(nextCursor)`
   - 内置 singleflight + notify debounce，避免并发拉取风暴

3. `NotifyLane`
   - 通过 `subscribe transport` 订阅 SSE/stream
   - 收到 notify 后触发 `PullLane.requestPull({ cause: 'notify' })`
   - 断连后按 backoff 重连

这三个 lane 的意义是：同步复杂度被拆散，不会形成“一个巨型状态机文件”。

### 7.4 `SyncWrites`：最关键的一刀解耦

很多系统会把“写入时顺手做同步入队”塞到写内核里，结果内核语义被污染。

Atoma 的做法是：

- `SyncWrites` 订阅 `execution` 事件
- 只在 `write.succeeded` 时做 outbox 入队
- 可按 `route` 过滤（例如只入队 `direct-local`）
- 严格要求 `idempotencyKey/clientTimeMs` 元信息

这意味着：

- runtime 只负责“写成功事件发布”
- sync 插件负责“要不要入队、怎么入队”

内核与同步策略完全解耦。

### 7.5 存储与传输都可替换：复杂，但边界清晰

`atoma-sync` 里有两组关键抽象：

- 存储抽象
  - `OutboxStore`：`enqueue/reserve/commit/recover/stats`
  - `CursorStore`：`get/advance`
  - 默认实现是 IndexedDB，降级有内存实现

- 传输抽象
  - `SyncTransport`：`pullChanges/pushWrites`
  - `SyncSubscribeTransport`：`subscribe`
  - 可通过不同 driver 插件注入（operation driver / SSE driver）

所以你可以改后端协议或通知通道，而不用改 SyncEngine 主流程。

### 7.6 冲突与恢复语义：在插件层闭环

同步最难的是失败与恢复。`atoma-sync` 把它做到插件内闭环：

- 网络失败：走 retry/backoff
- in-flight 超时：`recover()` 释放回 pending
- 写冲突：reject 结果可携带 `current`，applier 回写最新服务端值
- 版本前移：outbox `commit` 支持 `rebase`，自动提升后续 pending 写的 baseVersion
- 多实例竞争：`SingleInstanceLock` 保障同 namespace 单活

这些机制都很复杂，但都没有侵入 `ReadFlow/WriteFlow` 的核心语义。

### 7.7 为什么它是“分层正确性”的最好证据

如果架构边界不清晰，sync 这种能力一定会把整个系统拖进泥潭。

而在 Atoma 里，sync 做到了：

- 高复杂度能力可插拔
- 内核语义不被污染
- 路由、传输、存储、回放各自可替换
- runtime/core 仍保持单义职责

这就是“复杂度留给插件，稳定性留给内核”的真实工程价值。

### 7.8 一次完整同步时序（从本地写到最终一致）

为了让上下文更直观，我们把一次典型流程拆开看：

#### 场景 A：用户本地写入 -> 服务端确认

1. 业务调用 `store.create/update/...`
2. `WriteFlow` 完成本地写入流程并发出 `write.succeeded`
3. `SyncWrites` 监听到事件，把成功 entry 入队到 outbox
4. `PushLane` 从 outbox `reserve` 批量拿数据
5. `SyncTransport.pushWrites` 发到远端
6. 返回 `ack/reject/retry` 三类 outcome
7. `WritebackApplier` 回放：
   - ack：更新 version / 服务端返回实体
   - reject：冲突时用 `current.value` 覆盖本地
8. outbox `commit`：
   - ack/reject 出队
   - retryable 回 pending
   - 必要时 rebase 后续 pending 的 baseVersion

#### 场景 B：远端通知 -> 本地增量拉取

1. `NotifyLane` 收到 SSE `sync.notify`
2. 通知被去抖后触发 `PullLane.requestPull({ cause: 'notify' })`
3. `PullLane` 读取 cursor，调用 `pullChanges`
4. applier 把 change batch 回放到本地 store
5. cursor 前进到 `nextCursor`

这两个时序共同保证：本地写入与远端变化最终会在同一 store 语义下收敛。

### 7.9 职责矩阵：加了 sync 后，哪些层需要改，哪些层不需要改

这是分层价值最直观的地方：

- 需要新增/修改的主要是 `atoma-sync` 插件包本身
- `atoma-client` 只负责装配（多挂几个插件）
- `atoma-runtime` 不需要增加“同步专用 API”
- `atoma-core` 不需要引入任何“同步分支逻辑”

换句话说，sync 的复杂性增长没有转化为内核语义复杂性增长。

---

## 8）再回头看三层：为什么必须拆成 `client/runtime/core`

前面把组件都讲清楚后，再看分层决策就很自然。

## `core` 不知道执行环境

它只算规则，不做 IO，不做路由。
好处是算法纯净，稳定性高。

## `runtime` 不关心业务框架

它只负责编排，统一读写、执行、转换、事件。
好处是策略集中，不会被 React/插件细节污染。

## `client` 不重写语义

它只负责装配与暴露入口。
好处是接入层可变，内核层不受影响。

这就是复杂系统里最重要的一件事：

**让变化发生在该变化的层，不要把变化向下渗透。**

---

## 9）这套设计在工程上的直接收益

不谈理念，只谈会发生什么：

1. **执行后端可替换**
   - route 切换即可，不用改业务调用。

2. **读写语义可预测**
   - 通过 flow 固定流程，减少“同 API 不同场景行为不同”。

3. **批量操作语义统一**
   - `*Many` 统一 all-settled 结果模型，调用方更容易处理失败。

4. **调试与观测更完整**
   - execution/read/write 都有标准事件轨迹。

5. **测试成本可控**
   - core 可纯测，runtime 可流程测，client 可装配测。

6. **长期演进更稳**
   - 新能力优先通过 route/executor/plugin 扩展，不需要不断重写核心语义。

---

## 10）这不是没有代价，但代价是“可控的”

分层会带来额外抽象和学习成本，这是事实。

你需要理解：

- handle/state/bindings 的边界
- route 与 executor 的关系
- flow 的阶段语义

但这类成本是一次性的、文档化可传递的；
而“耦合失控”的成本是持续性的、不可预测的。

我们选择前者。

---

## 11）结语：把“能跑”变成“可演进”

如果目标只是“今天能跑”，把逻辑塞在一起永远最快。

但如果目标是：

- 三个月后还能快速加能力
- 六个月后还能解释每条读写路径
- 一年后还能在不破坏语义的前提下替换执行后端

那你迟早会走到类似 Atoma 的拆分：

- `atoma-core`：规则与算法
- `atoma-runtime`：流程与策略
- `atoma-client`：装配与接入

再配上 `execution route`、`ReadFlow`、`WriteFlow` 这三根主骨架，
系统就从“功能集合”变成了“可持续演进的内核”。

这就是我们坚持这套结构的根本原因。
