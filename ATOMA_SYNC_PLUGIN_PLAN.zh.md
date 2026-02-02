# Atoma Sync 插件化最终方案（createClient plugins + SyncDriver）

## 目标
- 通过 `createClient({ plugins })` 直接得到 `client.sync`。
- 插件具备完整生命周期（init/extension/dispose）。
- Sync 传输层不再依赖旧的 `ctx.transport`，改为 **自动发现 SyncDriver**。
- 简化链路与职责：插件只依赖 `runtime + endpoints`，不引入旧式 `client.use` 模式。

## 现状问题
- `atoma-sync` 依赖旧的 `ClientPluginContext`（`ctx.transport / ctx.devtools / ctx.persistence` 等），和当前 `atoma-client` 插件体系不匹配。
- 当前 `plugins` 只用于 handler 注册，没有扩展 `client` 能力、也没有 dispose 生命周期。

## 最终方案（唯一方案）

### 1) 插件体系升级为“两阶段”
**接口形态（概念）：**
- `register(ctx, registerHandlers)`：只负责注册 `io/persist/read/observe` handler。
- `init(ctx)`：在 runtime wiring 完成后执行，返回 `{ extension?, dispose? }`。

**createClient 执行顺序（固定）：**
1. 解析 options。
2. 构建 runtime（io/read/persist/observe 尚未接好）。
3. `plugin.register(...)` 注册 handler。
4. 组装 handler chain，注入 runtime。
5. `plugin.init(...)`：收集 extension 与 dispose。
6. 合并 extension 到 `client`（例如 `client.sync`）。
7. `client.dispose()` 时：先执行所有插件 dispose，再清理 endpoints。

**PluginContext（保持精简）：**
- `clientId`
- `endpoints`（EndpointRegistry）
- `runtime`（CoreRuntime）

> 不再引入旧的 `ctx.transport / ctx.devtools / ctx.core`，避免回退旧体系。

---

### 2) 合并式插件 + SyncDriver（用户零心智）
**新增能力接口（概念）：**
- `SyncDriver.pullChanges(args)`
- `SyncDriver.pushWrites(args)`
- `SyncDriver.subscribe?(args)`（可选）

**合并式插件的行为：**
- `syncPlugin` 内部 **直接创建 SyncDriver**（例如 HTTP/WS）。
- 插件 **自己注册 endpoint**（`role: 'sync'` 或 `capabilities: ['sync']`）。
- 插件 **自己直接使用该 driver**（不走 discovery，避免歧义）。

**可选覆盖（高级用户）：**
- `syncPlugin({ driver })`：直接使用外部 driver（仍会注册 endpoint）。
- `syncPlugin({ endpointId })`：仅当用户明确指定时才走 discovery。

---

### 3) Sync 插件的职责与流程（合并式）
**register 阶段：**
- 创建并注册 SyncDriver（或者使用传入 driver）。
- 不需要注册 io/read/observe handler（除非扩展需求）。

**init 阶段：**
- 直接使用已注册的 SyncDriver 构造 `SyncTransport`。
- 注册 persistence 策略（`queue` / `local-first`）：
  - `runtime.persistence.register(...)`
- 初始化 `SyncEngine` / `SyncDevtools`。
- 返回 `{ extension: { sync }, dispose }`：
  - `client.sync` 即为扩展对象（start/stop/pull/push/etc）。
  - `dispose` 关闭 engine、订阅、清理 outbox 处理器。

---

### 4) Sync Transport 与 Driver 的边界
- **SyncDriver**：底层接口（HTTP/WS/自定义协议）。
- **SyncTransport**：Sync 引擎所需的运行时适配层（从 driver 构造）。
- 插件只负责 **driver 发现** 和 **transport 适配**，不关心具体协议细节。

---

### 5) 与 atoma-devtools 的协作（推荐实现）
**原则：不把 devtools 塞回 PluginContext。**

**统一做法：**
1. 在 runtime 上挂一个轻量 devtools registry（Symbol key）。
2. `syncPlugin` 在 init 时注册 provider：
   - `registry.register('sync', { snapshot, subscribe })`
3. `atoma-devtools` 插件只读 registry：
   - 读取 `runtime[Symbol.for('atoma.devtools.registry')]`
   - 订阅 `register` 事件，自动接入 sync provider

**对 atoma-devtools 的改动建议：**
**改造目标：**
- 兼容新插件生命周期（register/init/dispose）。
- 只依赖 `ctx.runtime` + runtime registry，不依赖旧 `ctx.core`。
- Devtools 插件仍是“用户可选插入”的普通插件（无需额外 API）。

**具体改造建议：**
1. **插件接口升级**
   - `devtoolsPlugin` 实现 `init(ctx)`，不再使用旧的 `setup`/`ctx.core`。
   - `init` 返回 `{ dispose }`，由 createClient 收集并在 `client.dispose()` 时执行。
2. **runtime 读取统一**
   - 从 `ctx.core.runtime` 改为 `ctx.runtime`。
   - 通过 `runtime[Symbol.for('atoma.devtools.registry')]` 读取 registry。
3. **provider 接入逻辑不变**
   - 仍监听 registry `register` 事件，并在发现 `sync/history` 时 attach provider。
4. **API 不变**
   - 用户仍然 `plugins: [devtoolsPlugin()]`。
   - Devtools UI/inspector 逻辑无需变化。

---

## 迁移建议（只保留最终方案）
1. 现有 `atoma-sync` 全面改为新插件形态（register/init + extension/dispose）。
2. 去掉对旧 `ClientPluginContext` / `ctx.transport` 的依赖。
3. 新增 `SyncDriver` 与 `capabilities` 机制。
4. `createClient` 完成插件生命周期升级并合并 extension。

---

## 预期结果
- `createClient({ plugins: [syncPlugin(...)] })` 得到 `client.sync`。
- `client.dispose()` 自动释放 sync engine/订阅。
- sync 与 ops driver 解耦，职责清晰、可扩展。
