# Atoma 插件体系简化方案（Operation 中间件 + Runtime 事件平面）

> 日期：2026-02-13  
> 目标：在不引入新组件爆炸的前提下，降低 `atoma-client` 插件体系复杂度，明确 `ops` 与 `runtime` 事件边界，收敛 `createClient` 与插件耦合面。

---

## 1. 问题定义（当前痛点）

### 1.1 心智模型分裂
当前插件能力实际存在两条通道：
- 通道 A：`ops` 中间件（请求/响应链）
- 通道 B：`ctx.hooks.register`（runtime 本地生命周期事件）

问题不在于“双通道本身”，而在于**缺乏统一抽象语言**，导致使用者误以为都该走 `ops`，或都该走 hooks。

### 1.2 插件上下文权限过宽
`PluginContext` 可直接触达 `runtime`，插件可跨越边界访问过多内部能力，造成：
- 运行时内部结构泄漏
- 插件实现对 runtime 细节耦合
- 后续演进时改动面扩大

### 1.3 createClient 作为“全能文件”
虽已做初步拆分，但从架构层面仍缺少正式约束：
- createClient 应是 composition root（装配器）
- 业务策略、ops 执行、debug/sync/history 不应反向拉回该文件

---

## 2. 设计目标（必须达成）

1. **保留双平面，但统一语义**：
   - `ops` 平面只处理协议/传输链
   - `events` 平面只处理本地 runtime 生命周期
2. **收紧插件权限**：默认插件不再直接拿完整 `runtime`
3. **插件契约收敛**：统一声明 `ops/events/init`，不再“任意方式接入”
4. **sync/history 等强能力插件分类治理**：普通插件与 runtime 扩展插件分层
5. **无兼容包袱优先**：直接收敛到目标模型，不保留长期双轨

---

## 3. 目标架构

## 3.1 两个平面（明确边界）

### A) Ops Plane（协议执行平面）
职责：
- 拦截 `RemoteOpEnvelope`
- 鉴权、trace 注入、重试、路由、transport 调用
- 产出 `RemoteOpResultEnvelope`

不负责：
- 本地 store patch 事件
- undo/redo 历史
- runtime state 生命周期

### B) Runtime Events Plane（本地事件平面）
职责：
- 订阅 `readStart/readFinish/writeStart/writePatches/writeCommitted/writeFailed`
- 驱动 history、devtools 数据、本地观测

不负责：
- 远端 transport
- 协议 envelope 改写

---

## 3.2 插件契约（建议）

```ts
type ClientPlugin<Ext = unknown> = Readonly<{
  id?: string
  operations?: (ctx: PluginOperationContext, register: RegisterOperationMiddleware) => void
  events?: (ctx: PluginEventsContext, on: EventRegister) => void
  init?: (ctx: PluginInitContext) => void | PluginInitResult<Ext>
}>
```

说明：
- `operations`、`events` 为显式平面声明，避免在 `register/init` 中“隐式混用”。
- `init` 仅做扩展对象挂载与资源初始化，不承载平面逻辑。

---

## 3.3 Context 收口（关键）

默认插件上下文拆为三种窄接口：

- `PluginOperationContext`：
  - `clientId`
  - `capabilities`
  - 只读基础信息（如 `now`）

- `PluginEventsContext`：
  - `clientId`
  - `capabilities`
  - `events`（受控事件订阅器）

- `PluginInitContext`：
  - `clientId`
  - `capabilities`
  - 有限 facade（禁止直接触达 runtime 内部对象）

**默认不暴露完整 runtime。**

## 3.4 命名收敛（最优方案，建议一次性执行）

### 目标
- 以 `operation` 替代 `ops`（去缩写，提升可读性）。
- 以 `pipeline/middleware` 表达链式职责，避免 `registry/handler` 语义过散。
- 命名一次性收敛，不保留长期兼容别名。

### 命名基准
- 平面名：`Operation Plane` + `Runtime Events Plane`
- 能力名：`executeOperations`
- 中间件名：`OperationMiddleware`
- 管线名：`OperationPipeline`
- 注册器名：`registerOperationMiddleware`

### 推荐映射表（最优）
| 当前命名 | 推荐命名 | 说明 |
| --- | --- | --- |
| `ops` | `operations` | 去缩写，领域更直观 |
| `OpsContext` | `OperationContext` | 与 operation 语义对齐 |
| `OpsHandler` | `OperationMiddleware` | 体现中间件角色 |
| `OpsRegister` | `registerOperationMiddleware` | 动词短语，职责清晰 |
| `OpsHandlerRegistry` | `OperationPipeline` | 当前本质是执行管线 |
| `executeOps` | `executeOperations` | API 语义完整 |
| `createOpsClient` | `createOperationClient` | 与能力名一致 |
| capability `client.ops` | capability `client.operations` | 统一词根 |

### 文件命名建议（配套）
- `OpsHandlerRegistry.ts` -> `OperationPipeline.ts`
- `createOpsClient.ts` -> `createOperationClient.ts`
- `installDirectStrategy.ts` 内部变量 `opsRegistry` -> `operationPipeline`

### 迁移策略（无兼容包袱）
1. **第一批：类型与接口**
   - 先改 `atoma-types/client/plugins` 与 `atoma-types/client/ops` 的类型名、函数名、capability key。
2. **第二批：atoma-client 装配层**
   - 改 `createClient`、`plugins/*`、`client/*` 文件名与符号名。
3. **第三批：官方插件**
   - 改 `backend-*`、`observability`、`sync`、`devtools`、`history` 的导入与注册调用。
4. **第四批：文档与示例**
   - 全量替换 `ops` 术语，统一为 `operations`。

### 验收门槛（命名专项）
- 代码中不再出现新的 `Ops*` 类型/函数。
- capability key 不再新增 `client.ops`。
- `pnpm typecheck` 全仓通过。

---

## 4. 现有插件映射（迁移目标）

## 4.1 纯 Ops 插件
- `backend-http`
- `backend-memory`
- `backend-indexeddb`
- `observability`（trace 注入部分）

迁移后仅实现 `ops`。

## 4.2 纯 Events 插件
- `history`（write patches / undo-redo 相关）
- `devtools`（读调试快照与订阅）
- `observability`（读写事件埋点部分）

迁移后仅实现 `events`（或 `events + init`）。

## 4.3 Runtime Extension 插件（特例）
- `sync`

`sync` 跨 transport + writeback + outbox，建议标记为 `runtime extension plugin`：
- 仍可同时使用 `ops` + `events` + `init`
- 但必须走“扩展白名单上下文”，不继承普通插件全量能力

---

## 5. createClient 目标职责

`createClient` 仅保留：
1. 构造基础对象（runtime/capabilities/registry）
2. 装配插件平面（ops/events/init）
3. 注册 direct strategy 与 ops client
4. 统一回收 `dispose`

禁止：
- 直接出现插件业务逻辑
- 直接承载复杂 ops 构造细节
- 直接操作 runtime hooks 细节

---

## 6. 迁移路线（按批次）

## 阶段 0（已完成/基线）
- ops-only 注册模型已收敛
- `createClient` 已拆出 direct/debug/operationClient 安装器

## 阶段 1：引入事件平面适配层（不改插件行为）
- 提供 `EventRegister`（对 runtime hooks 的薄封装）
- 在不改业务逻辑前提下，把 `ctx.hooks.register` 使用迁入 `events` 平面

交付物：
- `events` 注册器
- 原 hooks 调用点替换完成

## 阶段 2：命名域收敛到 `operation*`（一次性）
- 按 3.4 映射表完成类型、API、文件名、capability key 重命名
- 不保留长期双命名兼容

交付物：
- `Ops*` 命名在主干消失
- 所有引用改为 `operation*`

## 阶段 3：插件契约切换到 `operations/events/init`
- 修改插件类型定义
- 逐插件改造：backend -> history/devtools/observability -> sync

交付物：
- 旧契约清理
- 所有官方插件迁移完成

## 阶段 4：收紧上下文权限
- 普通插件移除 `runtime` 直接访问
- 仅 runtime extension 插件通过白名单能力访问必要 facade

交付物：
- `PluginContext` 拆分完成
- 权限边界文档

## 阶段 5：最终清理
- 删除中间过渡类型
- 文档与示例统一到目标命名

---

## 7. 风险与控制

### 风险 A：history/sync 行为回归
控制：
- 对 write patches / writeback 流程加回归测试
- 分包 typecheck + 集成 smoke

### 风险 B：observability trace 中断
控制：
- ops 注入与 events 埋点拆分后，分别断言链路

### 风险 C：插件生态断裂
控制：
- 先迁官方插件，再发布迁移指南
- 提供明确“旧接口删除窗口”（短窗口）

---

## 8. 验收标准

1. 所有官方插件可在 `ops/events/init` 契约下运行
2. 普通插件代码中无 `ctx.runtime` 直接引用
3. `createClient` 只保留装配逻辑
4. `pnpm typecheck` 全仓通过
5. 文档中明确：
   - ops 平面负责什么
   - events 平面负责什么
   - runtime extension 插件边界

---

## 9. 推荐落地顺序（最稳）

1. 先做事件平面适配（最小侵入）
2. 再迁 observability/history/devtools（收益高、风险可控）
3. 最后迁 sync（复杂度最高，单独批次）
4. 完成后一次性删除旧插件契约

---

## 10. 一句话结论

**不要把一切硬并到 ops 中间件；应保留 “ops + events” 双平面，但把它们从“隐式双轨”升级为“显式契约”，并收紧插件上下文权限。**

这条路径能在不增加组件复杂度的前提下，显著降低长期维护成本与概念混乱。
