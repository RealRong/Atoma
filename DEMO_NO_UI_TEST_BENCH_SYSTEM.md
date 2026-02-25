# Demo 无 UI 测试与压测系统（设计与实现）

## 1. 目标

本系统用于替代 `demo/web` 的手工 UI 验证，提供一套可脚本化、可 CI 化的自动化能力：

1. 覆盖 Atoma Client 核心 API（CRUD / Query / History / Sync）。
2. 覆盖本地 HTTP 后端 + SQLite 数据库链路。
3. 提供基准压测（benchmark）并可一键执行。
核心入口：

```bash
pnpm demo:test-system
```

## 2. 一键执行模型

### 2.1 命令

- 默认（推荐，CI 友好）：`pnpm demo:test-system`
- 真 TCP 本地端口模式：`pnpm demo:test-system:tcp`

### 2.2 脚本行为

`scripts/run-demo-no-ui-system.sh` 按顺序执行：

1. `vitest run`：跑集成测试 `tests/noUiSystem/noUiSystem.test.ts`
2. `vitest bench`：跑压测 `bench/demo-client-http-sqlite.bench.ts`

可通过环境变量调优：

- `ATOMA_DEMO_SERVER_MODE=in-process|tcp`（默认 `in-process`）
- `ATOMA_DEMO_BENCH_TIME_MS=700`（每个 benchmark case 采样时长）

## 3. 系统架构

### 3.1 组成

- 配置层：`vitest.demo.config.ts`
- 测试层：`tests/noUiSystem/noUiSystem.test.ts`
- 压测层：`bench/demo-client-http-sqlite.bench.ts`
- 支撑层：
  - `tests/noUiSystem/support/demoSchema.ts`
  - `tests/noUiSystem/support/createDemoClient.ts`
  - `tests/noUiSystem/support/createSqliteDemoServer.ts`

### 3.2 服务模式

`createSqliteDemoServer` 支持两种模式：

1. `in-process`（默认）
   - 不监听端口。
   - 通过 `Request -> createAtomaHandlers -> Response` 直接路由。
   - 适合受限环境与 CI。
2. `tcp`
   - 启动真实本地 HTTP server。
   - 用于端到端网络栈验证。

两种模式都使用 TypeORM + SQLite，且都复用 `createAtomaHandlers` 与 `createTypeormServerAdapter`。

## 4. 覆盖范围

### 4.1 集成测试覆盖

`tests/noUiSystem/noUiSystem.test.ts` 当前包含三类测试：

1. `memory` 链路
   - `create/createMany/update/query/list`
   - `history` 插件 `undo`
2. `http + sqlite` 链路
   - `httpBackendPlugin` + Client API 调用
   - 数据库持久化结果校验（SQL count）
3. `sync pull` 链路
   - `syncOperationDriverPlugin` + `syncPlugin`
   - 验证 `sync.pull()` 可打通 `changes.pull` 传输路径并产出预期事件
   - 验证后端 `atoma_changes` 元表确实记录变更

### 4.2 压测覆盖

`bench/demo-client-http-sqlite.bench.ts` 当前包含：

1. Memory 基线
   - `users.upsertMany(400)`
   - 组合条件查询
2. HTTP + SQLite 基线
   - `users.upsertMany(250)`
   - 组合条件查询
   - `sync.pull(one remote write)`

## 5. 关键实现点

### 5.1 Client 构造统一化

`createDemoClient.ts` 提供统一工厂：

- `createMemoryDemoClient`
- `createHttpDemoClient`

统一使用当前架构约定：

- `createClient({ stores: { schema }, plugins })`
- `syncOperationDriverPlugin`（非旧名）
- `syncPlugin` / `historyPlugin`

### 5.2 SQLite 服务器构造

`createSqliteDemoServer.ts` 使用 `EntitySchema` 定义表结构（避免装饰器编译链耦合），并创建：

- `users`
- `posts`
- `comments`
- `atoma_changes`
- `atoma_idempotency`

这与 demo server 的业务语义对齐，可支持 sync pull/push 所需元表。

### 5.3 依赖解析

`vitest.demo.config.ts` 对 Atoma workspace 包做了显式 alias，避免受本地 `node_modules` 链接状态影响。

额外将 `typeorm` 指向 `demo/server/node_modules/typeorm`，确保 sqlite3 peer 依赖可用。

## 6. 使用建议

1. 日常开发与 CI：使用 `pnpm demo:test-system`（`in-process`）。
2. 发布前联调：额外执行 `pnpm demo:test-system:tcp`。
3. 性能回归对比：固定 `ATOMA_DEMO_BENCH_TIME_MS`，并记录 `hz/mean/p99` 指标变化。

## 7. 后续扩展建议

1. 增加多并发写入冲突测试（CAS / LWW）。
2. 增加错误注入场景（网络抖动、5xx、超时）并统计重试行为。
3. 将 benchmark 输出转成 JSON 并接入 CI 历史趋势图。
