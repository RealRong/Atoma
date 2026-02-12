# Atoma 当前读写调用链（收敛后）

> 目标：给团队一个可直接对照源码的“现状图”。
> 范围：`atoma-client + atoma-runtime + backend plugins`。

## 0. 架构基线（当前）

- 仅保留一条插件外部通道：`ops`
- 运行时外部路由统一由 `strategy` 负责
- `io` 层已移除
- `plugin read/persist` 双链路已移除

---

## 1. Read 调用链（query/get/fetch）

### 1.1 主路径（成功）

1. 业务调用 `store.query(...)` / `store.fetchOne(...)` 等
2. `StoreFactory` 转发到 `runtime.read.*`
3. `ReadFlow` 发出 `readStart`
4. `ReadFlow` 调用 `runtime.strategy.query({ storeName, handle, query, signal })`
5. `StrategyRegistry.query` 解析当前策略（默认 `direct`）并分发
6. `direct.query` 构建 `QueryOp`（`buildQueryOp + createOpId`）并调用 `pluginRegistry.executeOps`
7. `PluginRegistry` 执行 `ops` 责任链（如 observability -> backend）
8. backend 插件通过 `opsClient.executeOps` 访问目标后端（http/memory/indexeddb/local）
9. `direct.query` 校验并解析首个 `query` 结果（`assertQueryResultData`）
10. `ReadFlow` 执行 `writeback`、按 cache policy 决定是否写入 store、发出 `readFinish`

### 1.2 失败回退

- 任意远端异常进入 `ReadFlow` catch
- 回退到本地 `runtime.engine.query.evaluate({ state, query })`
- 返回本地结果并发出 `readFinish`

---

## 2. Write 调用链（add/update/upsert/delete）

### 2.1 主路径（成功）

1. 业务调用 `store.addOne/updateOne/upsertOne/deleteOne...`
2. `StoreFactory` 转发到 `runtime.write.*`
3. `WriteEntryFactory` 生成写计划：`writeEntries + optimistic`
4. `WriteCommitFlow` 根据 `strategy.resolveWritePolicy` 决定 optimistic/implicitFetch 行为
5. `WriteCommitFlow` 调用 `runtime.strategy.persist(req)`
6. `StrategyRegistry.persist` 按 `req.writeStrategy`（或默认）分发
7. `direct.persist` 对 `writeEntries` 按 `action + options` 分组，构建一个或多个 `WriteOp`
8. `direct.persist` 调用 `pluginRegistry.executeOps`
9. backend 处理 `write` ops 返回 `WriteResultData`
10. `direct.persist` 校验结果（`assertWriteResultData`），汇总 `WriteItemResult[]`
11. `WriteCommitFlow` 依据结果执行 writeback/version update，提交最终输出
12. 发出写完成 hooks

### 2.2 失败回滚

- 远端写失败时，`WriteCommitFlow` 回滚 optimistic state
- 抛出错误并发出写失败 hooks

---

## 3. Strategy 与插件扩展点

### 3.1 Strategy 层

- `direct`：默认在线直连策略（query/persist 都走 ops）
- `queue` / `local-first`：由 `atoma-sync` 注入，复用同一 `strategy` 路由入口

### 3.2 Plugin 层（仅 ops）

- 统一注册 `register('ops', ...)`
- 通过 priority 形成责任链
- 常见顺序：`observability(元数据注入)` -> `backend(最终执行)` -> `local fallback`

---

## 4. 与旧模型的关键差异

- 旧：`ReadFlow -> io -> read plugin -> (多数再转 ops)`
- 新：`ReadFlow -> strategy.query -> ops`
- 旧：`strategy.persist -> persist plugin -> (多数再转 ops)`
- 新：`strategy.persist -> ops`
- 结果：删除双跳与重复语义层，读写都走同一“策略分发 + ops执行”模型

---

## 5. 代码定位（便于快速跳转）

- `packages/atoma-runtime/src/runtime/flows/ReadFlow.ts`
- `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts`
- `packages/atoma-runtime/src/runtime/registry/StrategyRegistry.ts`
- `packages/atoma-client/src/createClient.ts`
- `packages/atoma-client/src/plugins/PluginRegistry.ts`
- `packages/atoma-client/src/defaults/LocalBackendPlugin.ts`
- `packages/plugins/atoma-backend-http/src/plugin.ts`
- `packages/plugins/atoma-backend-memory/src/plugin.ts`
- `packages/plugins/atoma-backend-indexeddb/src/plugin.ts`
