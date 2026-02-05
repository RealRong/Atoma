# Atoma Sync 插件化最终方案（纯插件）

## 目标
在不引入 `drivers` 语法糖、不依赖 Endpoint 的前提下，让 `atoma-sync` 通过纯插件注册能力来完成：
- `pull/push`（基于 `SyncDriver`）
- `subscribe`（基于 `SyncSubscribeDriver`）

## 核心原则
1. **能力注册唯一机制**：所有 sync 传输能力必须由插件注册到 `capabilities`。
2. **sync 仅消费能力**：`syncPlugin` 不创建 driver，不做协议实现，不依赖 Endpoint。
3. **单一职责**：传输细节（HTTP/SSE/WS/本地/自定义）全部由专门插件完成。
4. **无兼容包袱**：可删除 `syncPlugin` 中与 driver 相关的 options（`driver/subscribeDriver/endpointId`）。
5. **无默认 backend 配置**：移除 `backend: string`，强制显式引入传输插件。

## 角色与职责
### 1) 传输类插件（Transport Plugin）
负责注册以下能力：
- `sync.driver`（实现 `SyncTransport`：`pullChanges/pushWrites`）
- `sync.subscribe`（实现 `SyncSubscribeTransport`：`subscribe`）

示例职责：
- HTTP/SSE 插件：同时注册 `sync.driver` 与 `sync.subscribe`
- 仅 pull/push 的插件：只注册 `sync.driver`
- 仅 subscribe 的插件：只注册 `sync.subscribe`

### 2) `syncPlugin`
只做三件事：
- 从 `capabilities` 取 driver
- 组装 `SyncEngine`（根据 mode）
- 管理运行态（start/stop/pull/push）

### 3) Runtime/Store
不需要改动；sync 只在运行时读取能力并驱动引擎。

## 能力键与约束
使用现有键：
- `sync.driver`：`SyncDriver`（`SyncTransport`）
- `sync.subscribe`：`SyncSubscribeDriver`（`SyncSubscribeTransport`）

约束：
- 每个键只保留一个有效驱动（后注册覆盖前注册）
- 若模式需要 driver 但能力缺失，应抛出明确错误

## 运行时决策规则（建议）
- `pull/push`：必须存在 `sync.driver`
- `subscribe`：必须存在 `sync.subscribe`，否则自动降级为 `pull-only` 或直接报错（建议报错，行为更显式）

## 命名建议
### 结论
保留 `SyncDriver` / `SyncSubscribeDriver`（与现有类型一致），不要在 sync 层引入泛化命名。

### 原因
- sync 是明确的子域，使用专用命名更清晰
- 泛化命名容易和其他子域混淆（比如 read/write/notify）
- 其它插件可以自行定义各自子域的 driver，不必共用同一套命名

## subscribe 设计规则
`SyncSubscribeDriver` 只负责“通知”，不负责拉数据：
- 收到通知 → 触发引擎 `pull`
- 重连/退避由 `NotifyLane` 统一控制
- driver 不做内部循环或重试

## SubscribeDriver 实现要点
### 接口约束
`subscribe(args)` 的输入输出：
- 入参：`resources?` / `onMessage` / `onError` / `signal`
- 返回：`{ close: () => void }`

### 实现策略（推荐）
1. **SSE**
   - 建立事件流连接，解析消息
   - 收到通知后调用 `onMessage({ resources })`
   - `signal` 取消时关闭连接

2. **WebSocket**
   - 连接后发送订阅 payload（含 `resources`）
   - 收到消息后调用 `onMessage`
   - `close()` 断开连接

3. **长轮询**
   - 单次请求等待通知，返回后调用 `onMessage`
   - 不在 driver 内自循环，交由 `NotifyLane` 统一重连

### 约束
- driver 内不要做重试与退避（避免与 `NotifyLane` 冲突）
- driver 内不要触发 `pull`，只负责通知

## backend 配置策略
### 结论
移除 `createClient({ backend: string })` 这类隐式配置，改为：
- 用户显式引入传输插件
- 插件注册 `sync.driver / sync.subscribe`

### 示例
```ts
createClient({
    plugins: [
        httpSyncTransportPlugin({ baseUrl: '...' }),
        syncPlugin()
    ]
})
```

## 推荐插件接口（示例）
可提供单独插件完成注册（不进入 syncPlugin）：

```ts
httpSyncTransportPlugin({
    baseUrl: string,
    headers?: Record<string, string>,
    sseUrl?: string
})
```

职责：
- `pullChanges/pushWrites` 走 HTTP
- `subscribe` 走 SSE 或 WS

## 迁移与清理建议
1. 删除 `syncPlugin` 的 `driver/subscribeDriver/endpointId` options
2. 删除 `resolveExecuteOps` 内对 endpoint 的依赖
3. 删除 `backend: string` 这类默认配置入口
4. 将 ops/http/sse 等能力放到独立插件中注册
5. 文档中明确：**Sync 必须依赖插件提供能力**

## 可能需要的 driver 能力清单（供未来插件使用）
以下是可能会被其它插件复用的能力类型，建议各自独立定义并注册到 `capabilities`：

### 传输/网络
- `ops.driver`：执行通用 ops（例如 `executeOps`）
- `http.driver`：通用 HTTP 请求能力（基于 fetch/axios 封装）
- `subscribe.driver`：通用订阅能力（非 sync 专用，消息格式由插件定义）

### 存储/状态
- `storage.kv`：键值存储（可用于 outbox、cursor、lock 等）
- `storage.blob`：二进制/大对象存储
- `cache.driver`：读缓存与失效管理

### 同步相关（sync 子域）
- `sync.driver`：pull/push
- `sync.subscribe`：notify/subscribe
- `sync.lock`：锁能力（多实例/跨标签页）

### 时钟/调度
- `clock`：统一时间源（可注入用于测试）
- `scheduler`：间隔执行/退避执行能力

### 可观测性
- `logger`：统一日志
- `tracing`：trace/metrics 埋点

> 说明：以上仅为能力方向清单，不要求核心层一次性内置；保持按需引入、由插件注册。

## 好处总结
- 架构一致：能力 = 插件注册
- 扩展简单：任意插件都能提供 sync 能力
- 复用强：同一 driver 可被多个系统消费
- 规避 Endpoint 耦合与重复实现

## 最终结论
采用“**纯插件能力注册**”作为唯一方案，`syncPlugin` 只消费能力、不创建能力，Endpoint 可完全移除。
