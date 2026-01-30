# Atoma 插件重写（atoma-sync / atoma-devtools / atoma-history）思路草案

> 目标：把三个插件包迁移到“HandlerMap + PluginRegistry + EndpointRegistry”新模型；
> 不做兼容层；不依赖 capabilities / fallback / client.use / ctx.dispatch。
> 保持 class 风格与清晰的职责分层。

---

## 1. 总体原则

1. **插件只通过 PluginContext 协作**
   - 只能使用 `ctx.runtime`、`ctx.endpoints`、`ctx.clientId`。
   - 不依赖旧 `ClientPluginContext` / `ctx.devtools` / `ctx.persistence.register` / `client.use`。

2. **显式依赖、显式失败**
   - 需要的端点（`role=ops/sync/notify`）必须存在，否则在插件 `setup` 里直接抛错。
   - 不做 fallback，不做“隐式探测能力”。

3. **按 Handler 链接入核心流程**
   - `persist` 拦截写入策略；`read` 处理查询；`io` 处理 ops；`observe` 同步链。
   - 插件内部自行组合多端点调用，不让核心知晓策略细节。

4. **可组合、可替换、可裁剪**
   - 插件之间不直接调用；如需共享状态，用独立“控制器对象”。
   - 开发工具（devtools）不要强绑 sync/history。

5. **类为主，文件名首字母大写**
   - 插件/控制器/transport/adapter 全部 class 化。

---

## 2. 新插件架构里的关键角色

- **EndpointRegistry**：保存端点（`{ id, role, driver }`）。
- **HandlerChain**：按 `priority` 链式执行 Handler（`io/persist/read/observe`）。
- **ClientPlugin**：`setup(ctx, register)` 注册 handlers 或端点。
- **Driver**：仅包含 `executeOps`；其他能力由插件自行扩展 driver 类型。

> 结论：`sync`/`notify` 不属于核心 handler，必须由插件自行扩展与验证。

---

## 3. atoma-sync 重写方向（核心）

### 3.1 目标能力
- 仍保留：`SyncEngine`、`PushLane`、`PullLane`、`NotifyLane`、`OutboxStore`、`CursorStore`。
- 替换旧 `ClientPluginContext` 依赖，改为 `PluginContext`。
- 通过 `persist` handler 接管写入策略（`writeStrategy`）。

### 3.2 新结构建议

```
packages/atoma-sync/src/
  Plugin/SyncPlugin.ts          // 新主插件类（class）
  Transport/SyncOpsTransport.ts // 新 transport：通过 ops driver 拉取 changes.pull
  Transport/NotifySseTransport.ts (可选) // SSE notify
  Persistence/SyncPersistHandler.ts // persist handler（class）
  Applier/WritebackApplier.ts    // 复用现有逻辑，改为 ctx.runtime
```

### 3.3 Sync 插件核心流程

1) **setup(ctx, register)**
- 校验端点：
  - `role=sync` 用于 changes.pull / push（可通过 ops 封装）
  - `role=notify` 用于 notify（可选）
- 初始化：`OutboxStore`、`CursorStore`、`SyncEngine`。
- 注册 `persist` handler：
  - `writeStrategy = 'queue'`：仅入队
  - `writeStrategy = 'local-first'`：先 `next(req)` 再入队
- 暴露控制器：`SyncController`（仅插件包内导出，非 client 扩展）

2) **SyncTransport（基于 ops）**
- 用 `Protocol.ops.build.buildChangesPullOp` 构造 changes.pull。
- 通过 `driver.executeOps` 拉取 `ChangeBatch`。
- push 可沿用旧 RemoteTransport 逻辑，但改为 `executeOps` 或按协议构建 write。

3) **SyncApplier**
- `applyPullChanges`：通过 `runtime.io.query(...)` + `runtime.internal.applyWriteback(...)`
- `applyWriteAck/Reject`：用 `runtime.mutation.ack/reject` + `runtime.write.applyWriteback(...)`

### 3.4 Sync 写入策略处理（persist handler）

- 接入点：`register('persist', handler)`
- 策略由 plugin 解释：
  - `queue`：入 outbox，`PersistResult.status='enqueued'`
  - `local-first`：先 `next(req)` 然后入 outbox
- 不与核心混合：核心只透传 `writeStrategy`。

---

## 4. atoma-history 重写方向

### 4.1 现状问题
旧插件依赖：`ctx.commit.subscribe`、`ctx.commit.applyPatches`、`ctx.devtools`，均已被移除。

### 4.2 新方案

- 使用 `ctx.runtime.mutation.subscribeCommit` 获取 commit。
- 通过 `ctx.runtime.internal.dispatchPatches` 回放 patch。
- History 对外 API **不再挂 client**；由插件包导出 `createHistoryController(runtime)`。

### 4.3 结构建议

```
packages/atoma-history/src/
  Plugin/HistoryPlugin.ts        // 只负责监听并记录
  Controller/HistoryController.ts // 对外 API（undo/redo）
  HistoryManager.ts              // 复用
```

### 4.4 HistoryPlugin 流程
1) setup(ctx):
- `history = new HistoryManager()`
- `runtime.mutation.subscribeCommit(commit => history.record(...))`
- 仅提供“状态记录”，不注入扩展。

2) HistoryController：
- `undo/redo` 使用 `runtime.internal.dispatchPatches`。
- `beginAction` 可封装 `OperationContext` 生成。

---

## 5. atoma-devtools 重写方向

### 5.1 新约束
- 不依赖 core 内建 devtools registry（已移除）。
- Devtools 只做“外部观察”，不影响核心行为。

### 5.2 新结构

```
packages/atoma-devtools/src/runtime/
  plugin.ts          // devtoolsPlugin class
  registry.ts        // 全局 registry（本包内维护）
  runtimeAdapter.ts  // 把 runtime 挂接到 registry
  inspector.ts       // UI 读取入口
```

### 5.3 关键改动

- `devtoolsPlugin` 使用 `ctx.runtime`：
  - `attachRuntime(entry, runtime)`
  - store snapshot 通过 `runtime.stores.onCreated` + `runtime.internal.getStoreSnapshot`
- Sync/History 快照：
  - 不从 ctx 读取，改为**显式注入**
  - 插件可接受 `options.syncDevtools` / `options.historyDevtools`

---

## 6. 端点组合场景说明

### A) IndexedDB 本地 + 在线同步
- 安装本地存储插件：注册 `role=ops` 的 IndexedDB endpoint
- 安装 Sync 插件：注册 `role=sync` 的在线 endpoint（HTTP/WS）
- Sync 插件只依赖 `role=sync`，无需“探测 HttpDriver”

### B) 纯远程 HTTP
- 只安装 HttpBackendPlugin（`role=ops`）
- 可选安装 Sync 插件，但必须显式提供 `role=sync` endpoint

### C) 仅本地
- 只安装 IndexedDB/Memory plugin
- 不安装 Sync/Notify 插件

---

## 7. 文件调整清单（建议）

### atoma-sync
- 新增：`src/Plugin/SyncPlugin.ts`
- 新增：`src/Transport/SyncOpsTransport.ts`
- 修改：`WritebackApplier` 改用 `ctx.runtime`
- 修改：`SyncPersistHandlers` -> `SyncPersistHandler`（class，基于 register('persist')）
- 删除：`withSync.ts`（或降级为仅创建 plugin）
- 更新：`index.ts` 导出 `syncPlugin` / `SyncPlugin`

### atoma-history
- 新增：`Plugin/HistoryPlugin.ts`
- 新增：`Controller/HistoryController.ts`
- 修改：`HistoryManager` 复用
- 更新：`index.ts` 重新导出

### atoma-devtools
- 恢复 `devtoolsPlugin`（class）
- 移除对 `ctx.devtools` / registry key 的依赖
- 用 `ctx.runtime` 构建 inspector

---

## 8. 实施步骤（可后续拆分）

1. **Sync 插件重建骨架**
   - 完成端点解析、outbox/cursor 初始化、persist handler 注册。
2. **同步 transport 改造**
   - 改为 `executeOps` 拉 `changes.pull`。
3. **WritebackApplier 接入 runtime**
   - 替换 `ctx.persistence.*` 为 `runtime.write.applyWriteback` 等。
4. **History 改造**
   - 监听 commit，控制器应用 patches。
5. **Devtools 改造**
   - 直接 attach runtime，提供 snapshot/subscribe。

---

## 9. 注意事项

- **不要把 extension 挂到 client**：新架构不提供 `client.use`，避免再做扩展注入。
- **不要嵌套三层配置**：插件构造参数扁平化。
- **默认插件仍然是显式安装**：不要回退到 fallback 逻辑。

---

## 10. 未来可选优化

- 为插件扩展提供“可选扩展 API 注册器”（显式）
- 为 devtools 建立统一的“观测器注入规范”

