# Atoma Runtime 写入链路优化方案（WriteFlow / prepareLocalWrite / commitWrites）

## 1. 背景与目标

当前 `packages/atoma-runtime/src/runtime/flows/WriteFlow.ts` 到 `prepareLocalWrite.ts` 再到 `commitWrites.ts` 的主链路可以工作，但存在两类结构性问题：

1. `version` 在通用写路径中存在“强绑定默认化”倾向（尤其 update/delete）。
2. runtime 职责边界混杂：本地状态变更、远程执行、一致性策略、写回收敛集中在同一流程层。

本方案目标：

- 将 runtime 写链路拆分为清晰的本地写入管线与远程复制管线。
- 将版本模型收敛为**单一 version + CAS**（不引入第二套版本模型）。
- 前端 runtime 不强绑定 `atoma-server`，后端接入通过插件体系完成。

## 2. 现状诊断（基于当前代码）

### 2.1 入口编排层（WriteFlow）

- 文件：`packages/atoma-runtime/src/runtime/flows/WriteFlow.ts`
- 现状：
1. `WriteFlow` 同时承担 session 构造、事件触发、prepare 调度、commit 调度、单条结果拆包。
2. `ensureUniqueIds` 在编排层执行，属于准备阶段约束但未下沉。

### 2.2 准备层（prepareLocalWrite）

- 文件：`packages/atoma-runtime/src/runtime/flows/write/prepare/prepareLocalWrite.ts`
- 现状：
1. `update/delete` 使用 `requireBaseVersion` 作为强前置（缺失即失败）。
2. `upsert` 在 `conflict === 'cas'` 时设置 `expectedVersion`，属于条件化绑定。
3. 准备阶段直接处理 outbound transform + meta + 版本字段拼装，协议细节耦合在 runtime prepare 主逻辑中。

### 2.3 提交层（commitWrites）

- 文件：`packages/atoma-runtime/src/runtime/flows/write/commit/commitWrites.ts`
- 现状：
1. 同一函数内包含：乐观应用/回滚、本地 state 写回、远程 execution.write 调用、writeback transform。
2. “本地事务收敛”与“远程执行语义”耦合，后续扩展离线/多后端/重放路径成本高。

## 3. 与通用状态库职责的偏差

对通用状态库而言，默认假设应是“本地状态管理优先，远程一致性通过适配层接入”。当前实现的问题：

1. 本地写流程过早承担协议级版本语义细节。
2. runtime 层难以区分本地写与远程复制职责。
3. 后端适配（尤其 `atoma-server`）没有独立语义边界，容易被误用为 runtime 默认耦合。

## 4. 目标架构

### 4.1 分层模型

将写入链路拆为 3 层单向依赖：

1. `local-write-pipeline`
- 责任：intent 归一化、schema/输入准备、optimistic change 计算。
- 不负责：远程执行、网络路由决策。

2. `replication-pipeline`
- 责任：将本地准备结果映射为协议写入，调用 `runtime.execution.write`。
- 不负责：本地输入规范化。

3. `reconciliation-pipeline`
- 责任：把 optimistic 变化与远程 `writeback/versionUpdates` 合并收敛。
- 不负责：协议字段拼装。

### 4.2 单一 version 模型（CAS）

本期只保留一套模型，不扩展 `none/lww/custom`：

1. 类型保持现状：`atoma-types/shared` 的 `Version = number`。
2. 写入规则统一：
- `create`：不要求 version。
- `update/delete`：必须提交 `baseVersion`。
- `upsert`：按 CAS 语义提交 `expectedVersion`（存在 current 时带上；不存在按创建路径）。
3. 冲突结果统一：通过 `WriteItemResult` 的 `current.value/current.version` 返回。
4. 本地最终版本以远端回包为准，通过 `writeback/versionUpdates` 回写。

## 5. 一步到位重构方案（不保留兼容双轨）

### 5.1 文件结构重组（建议）

在 `packages/atoma-runtime/src/runtime/flows/write/` 下重排：

1. `orchestrateWrite.ts`
- 承担主流程编排：`normalize -> prepare -> commit -> reconcile -> emit`。

2. `local/prepareLocalWrite.ts`
- 承担当前 `prepareWrite.ts` 的本地准备职责。
- 输出 `LocalPreparedWrite`，不直接拼接完整协议 entry。

3. `replication/commitRemoteWrite.ts`
- 承担当前 `commitWrites.ts` 的远程执行职责（`execution.write`、route/signal）。

4. `reconcile/reconcileWriteResult.ts`
- 承担 optimistic merge/rollback + writeback/versionUpdates 收敛。

5. `packages/plugins/atoma-backend-shared/src/write/buildWriteEntry.ts`
- 统一 CAS 版本字段注入（`baseVersion/expectedVersion`），由后端适配层复用。

### 5.2 关键行为调整

1. `prepareLocalWrite` 只生成本地语义结果，不直接依赖 `requireBaseVersion`。
2. version 字段不在 runtime 注入，由后端适配层的 `buildWriteEntry` 注入。
3. `commitRemoteWrite` 只返回标准化远程结果，不直接改本地 state。
4. 本地 state 变更统一在 `reconcileWriteResult` 执行。
5. `ensureUniqueIds` 下沉到 local prepare 批处理末尾。

## 6. 分阶段落地计划

### Phase 1：边界切开（低风险）

1. 从 `commitWrites.ts` 抽离 `commitRemoteWrite` 与 `reconcileWriteResult`。
2. 保持现有行为一致，先不改变外部 API。
3. 增加分层单测，确保错误映射与回滚一致。

验收：

- `commitWrites.ts` 只做协调，不再同时承载远程执行和本地回写细节。

### Phase 2：单一 version 契约收敛（中风险）

1. 在 `atoma-backend-shared` 引入 `write/buildWriteEntry.ts`，统一处理 `baseVersion/expectedVersion`。
2. `prepareLocalWrite.ts` 改为产出不含协议 version 字段的本地准备结果。
3. 在后端适配入口统一组装协议 `WriteEntry`，runtime 仅传递本地语义写入结果。

验收：

- `create/update/upsert/delete` 都遵循同一套 CAS 规则。
- 冲突返回结构保持稳定，不新增分支模型。

### Phase 3：插件体系接入 `atoma-server`（中风险）

1. 新增后端插件包（建议：`packages/plugins/atoma-backend-atoma-server`）。
2. 插件通过 `ctx.runtime.execution.apply(...)` 注册 route/executor，不改 runtime 核心。
3. 在 client 侧通过 `plugins + defaultRoute` 选择后端，不在 runtime 写死。

验收：

- 移除插件后，client 仍可走 local route 正常工作。
- 切换到 server 插件后，不修改 runtime 写流程代码即可完成远程写入。

### Phase 4：公共 API 收敛（中高风险）

1. `WriteFlow` 只保留对外 API 与事件发射。
2. 内部统一单入口：`orchestrateWrite({ scope, intents })`。
3. 删除旧内部 helper 命名，避免同义函数并存。

验收：

- 写链路生命周期可从单入口函数完整阅读。

## 7. 测试与验证计划

按仓库建议顺序执行：

1. `pnpm --filter atoma-runtime run typecheck`
2. `pnpm --filter atoma-runtime run build`
3. `pnpm --filter atoma-backend-http run typecheck`
4. `pnpm --filter atoma-backend-atoma-server run typecheck`（新增后）
5. `pnpm typecheck`
6. `pnpm test`

新增测试重点：

1. 单一 CAS 规则下 `create/update/upsert/delete` 的 version 行为矩阵。
2. 批量写部分失败时 optimistic rollback 与 transactionChanges 合并顺序。
3. 写状态固定为 `confirmed/partial/rejected`，不存在 `enqueued` 分支。
4. `returning/select` 对 writeback 应用的边界行为。
5. 不同 route（`direct-local` / server route）下相同行为的一致性。

## 8. 风险与控制

1. 风险：拆分 reconcile 后可能改变 `mergeChanges` 语义。
- 控制：锁定 `failed ? transactionChanges : mergeChanges(...)` 回归用例。

2. 风险：版本注入下沉到后端适配层后，`upsert` 冲突行为偏移。
- 控制：为 `expectedVersion` 场景增加表格化测试。

3. 风险：插件化接入后 route 冲突或默认路由误配。
- 控制：为 `execution.apply` route 冲突、defaultRoute 缺失添加失败测试。

## 9. 预期收益

1. runtime 责任边界清晰：本地写、远程复制、收敛回写可独立演进。
2. 版本模型保持单一，复杂度受控，便于与 `atoma-server` 一致。
3. 前端不强绑后端实现，`memory/http/indexeddb/atoma-server` 可按插件切换。

## 10. 建议的首批实施清单（可直接开工）

1. 从 `commitWrites.ts` 抽出 `commitRemoteWrite` 与 `reconcileWriteResult`。
2. 在 `atoma-backend-shared` 新增 `write/buildWriteEntry.ts` 并迁移 version 注入逻辑。
3. 继续保持 `prepareLocalWrite.ts` 仅承载本地准备职责，不回流协议组装逻辑。
4. 给 `WriteFlow` 引入单入口 `orchestrateWrite`。
5. 新建 `packages/plugins/atoma-backend-atoma-server` 插件包并接入 `execution.apply`（复用 `atoma-backend-shared` 的 write entry 构建逻辑）。

## 11. 插件体系接入说明（atoma-server）

### 11.1 目标边界

1. `atoma-runtime` 不直接依赖 `atoma-server`。
2. `atoma-server` 协议接入放在插件包内。
3. `createClient` 只负责装配插件和设置默认 route。
4. CAS 版本映射逻辑放在 `atoma-backend-shared`，`atoma-server` 插件只做 atoma-server 约定封装。

### 11.2 插件包结构（建议）

路径：`packages/plugins/atoma-backend-atoma-server/`

建议文件：

1. `src/types.ts`
- 定义插件配置：`baseURL`、`operationsPath`、`headers`、`retry`、`route`。

2. `src/plugin.ts`
- 暴露 `atomaServerBackendPlugin(options)`。
- `setup(ctx)` 内完成 service 注册与 route 注入。

3. `src/index.ts`
- 导出 plugin 与 types。

### 11.3 插件实现骨架

```ts
import { buildOperationExecutor } from 'atoma-backend-shared'
import { HttpOperationClient } from 'atoma-backend-http'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { ExecutionRoute } from 'atoma-types/core'

const EXECUTOR_ID = 'backend.atoma-server.operation'
export const ATOMA_SERVER_ROUTE: ExecutionRoute = 'direct-atoma-server'

export function atomaServerBackendPlugin(options: AtomaServerBackendPluginOptions): ClientPlugin {
    return {
        id: `atoma-server:${options.baseURL}`,
        provides: [OPERATION_CLIENT_TOKEN],
        setup: (ctx) => {
            const operationClient = new HttpOperationClient({
                baseURL: options.baseURL,
                operationsPath: options.operationsPath,
                headers: options.headers,
                retry: options.retry,
                fetchFn: options.fetchFn
            })

            const unregisterService = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            const unregisterRoute = ctx.runtime.execution.apply({
                id: `backend.atoma-server.route:${options.baseURL}`,
                executors: {
                    [EXECUTOR_ID]: buildOperationExecutor({
                        runtime: { now: ctx.runtime.now },
                        operationClient
                    })
                },
                routes: {
                    [options.route ?? ATOMA_SERVER_ROUTE]: {
                        query: EXECUTOR_ID,
                        write: EXECUTOR_ID
                    }
                }
            })

            return {
                dispose: () => {
                    unregisterRoute()
                    unregisterService()
                }
            }
        }
    }
}
```

### 11.4 Client 接入方式

```ts
import { createClient } from 'atoma-client'
import {
    atomaServerBackendPlugin,
    ATOMA_SERVER_ROUTE
} from 'atoma-backend-atoma-server'

const client = createClient({
    schema,
    plugins: [
        atomaServerBackendPlugin({
            baseURL: 'http://localhost:3000/api',
            operationsPath: '/ops'
        })
    ],
    defaultRoute: ATOMA_SERVER_ROUTE
})
```

### 11.5 与 WriteFlow 优化后的协作关系

1. `WriteFlow` 只编排，不感知后端类型。
2. `replication-pipeline` 统一调用 `runtime.execution.write`。
3. 由 route 决定命中哪个 executor（local/http/atoma-server）。
4. 无论后端类型，返回都走统一 `WriteItemResult` 与 `reconcileWriteResult`。

补充：

1. `buildWriteEntry` 放在 `atoma-backend-shared`，避免 `atoma-server` / `http` / `memory` / `indexeddb` 各自重复实现 CAS 注入。
2. `atoma-backend-atoma-server` 仅负责 URL、headers、route 与 transport 约定，不承担通用版本映射职责。

### 11.6 迁移策略

1. 先引入插件包，不改现有 `httpBackendPlugin`。
2. demo/业务项目优先替换为 `atomaServerBackendPlugin`。
3. 观察稳定后，再决定是否将 `httpBackendPlugin` 作为底层实现细节保留。
