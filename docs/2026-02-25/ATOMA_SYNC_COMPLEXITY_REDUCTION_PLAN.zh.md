# Atoma Sync 降复杂度整体方案（RxDB，一步到位）

> 面向当前仓库代码的执行方案。目标是让 `packages/plugins/atoma-sync` 的主流程可读、职责清晰、依赖边界稳定，不保留兼容层。

## 0. 元信息

- 状态：`Proposed + Partially Implemented`
- 日期：`2026-02-25`
- 适用范围：
  - `packages/plugins/atoma-sync`
  - `packages/plugins/atoma-backend-atoma-server`
  - `packages/atoma-types/src/client/sync.ts`
- 不在范围：
  - `packages/atoma-core`
  - `packages/atoma-runtime`
- 相关详细设计：`ATOMA_SYNC_RXDB_SYSTEM_DESIGN.zh.md`

## 1. 复杂度来源（结论）

`atoma-sync` 历史复杂度主要来自 4 类问题：

1. 同步编排、状态管理、桥接写入、网络传输混在同层，阅读路径长。
2. 客户端自己维护一套 lane/outbox/lock 基础设施，状态机重。
3. 与后端 HTTP 协议耦合点分散，`sync` 插件本身承担过多传输细节。
4. Atoma 实体与 RxDB 文档互转是必要边界，但如果不集中管理，会在多个模块重复出现。

## 2. 目标架构（简化后）

```text
App CRUD -> atoma runtime.write
              |
              v
         LocalBridge(writeCommitted, origin!=sync)
              |
              v
          RxDB collections
         /              \
  Replication push   Replication pull/stream
        |                  |
        v                  v
 SyncTransport ------> atoma-server
                           |
                           v
                   RemoteApply(origin=sync)
                           |
                           v
                    atoma runtime reconcile
```

关键原则：

1. 主链路 CRUD 不变，继续走 `PluginContext` 暴露的 runtime/event API。
2. 同步作为旁路：监听主链路事件，拦截在桥接层，不侵入 core/runtime。
3. 传输能力由后端插件提供（token 注入），`atoma-sync` 不再直接持有 HTTP 配置。

## 3. 落地方案（按 CODE_SIMPLIFIER 结构）

### S1. 入口编排收敛（已完成）

- 问题：
  - `plugin.ts` 过大时会把解析、实例化、生命周期、错误处理混在一起。
- 修改：
  - `packages/plugins/atoma-sync/src/plugin.ts` 收敛为 `parse -> prepare -> mount/dispose` 单入口。
  - 复杂逻辑下沉到 `SyncController`。
- 收益：
  - 入口可读性显著提升，维护时先看主流程再下钻。
- 风险：
  - 生命周期顺序错误会在运行期暴露。
- 验证方式：
  - `pnpm --filter atoma-sync run typecheck`
  - `pnpm --filter atoma-sync run build`

### S2. 生命周期与复制状态分层（已完成）

- 问题：
  - 启停、重建、模式切换、串行回写混杂，增加状态分支复杂度。
- 修改：
  - 新增 `packages/plugins/atoma-sync/src/replication/ReplicationManager.ts`。
  - 统一管理 `start/stop/pull/push/rebuild/dispose` 与 `remoteApplyQueue`。
- 收益：
  - 状态流集中，行为边界稳定，便于单测覆盖。
- 风险：
  - rebuild 与 start 并发时可能出现时序 bug。
- 验证方式：
  - 增加 `ReplicationManager` 启停/切模/重建测试（下一阶段）。
  - 现阶段通过类型与构建验证。

### S3. 本地写桥接独立化（已完成）

- 问题：
  - `writeCommitted -> RxDB` 若分散在 replication 逻辑中，会导致关注点交叉。
- 修改：
  - 新增 `packages/plugins/atoma-sync/src/bridge/LocalBridge.ts`，只负责监听并落本地文档。
  - 严格过滤 `context.origin === 'sync'` 防环路。
- 收益：
  - 主流程清晰：本地监听与远端复制彻底分层。
- 风险：
  - 事件结构变化可能影响桥接解析。
- 验证方式：
  - 覆盖 `origin=sync` 过滤、upsert/tombstone 生成、异常上报路径测试（下一阶段）。

### S4. 传输能力插件化（已完成）

- 问题：
  - 让 `atoma-sync` 直接配置 `baseURL/fetch/headers` 会把后端耦合压进同步插件。
- 修改：
  - 在 `packages/atoma-types/src/client/sync.ts` 定义 `SyncTransport` 与 `SYNC_TRANSPORT_TOKEN`。
  - `atoma-sync` 改为 `requires: [SYNC_TRANSPORT_TOKEN]`。
  - `atoma-backend-atoma-server` 提供 transport（`createSyncTransport.ts`）。
- 收益：
  - 职责边界清晰：`sync` 只做同步编排，后端插件负责协议实现。
- 风险：
  - 未挂后端插件时会运行期失败。
- 验证方式：
  - 启动时缺少 token 立即抛错（已在 `SyncController.parse`）。
  - `pnpm --filter atoma-backend-atoma-server run typecheck && pnpm --filter atoma-backend-atoma-server run build`

### S5. 配置面收敛（已完成）

- 问题：
  - 旧配置项同时含业务语义和传输细节，参数多、认知负担高。
- 修改：
  - `SyncPluginOptions` 仅保留同步语义项：`resources/mode/live/pull/push/stream/onEvent/onError`。
  - 去除 `baseURL/fetchFn/headers`。
- 收益：
  - 配置模型更内聚，插件 API 更稳定。
- 风险：
  - 旧调用方需要一次性迁移。
- 验证方式：
  - 仓库内编译失败点即迁移清单，完成后全量 typecheck。

### S6. 文档互转集中化（部分完成，继续收敛）

- 问题：
  - Atoma <-> RxDB 互转是核心复杂度之一，若分散会导致重复清洗和语义漂移。
- 修改：
  - 已集中到 `packages/plugins/atoma-sync/src/mapping/document.ts`。
  - 下一步进一步收敛为单一 `DocumentCodec`（函数族或 class 均可），统一 5 个入口：
    - `fromLocalChanges`
    - `toPushPayload`
    - `fromPullPayload`
    - `toRuntimeEntity`
    - `toTombstone`
- 收益：
  - 互转规则单点维护，减少重复遍历和重复字段过滤。
- 风险：
  - codec 重构若不全量覆盖会引入边界回归。
- 验证方式：
  - 增加映射单测：新增/更新/删除/冲突/脏字段清洗。
  - 回归 `atoma-sync` build + 关键 demo 流程。

### S7. 远端回写顺序控制（已完成）

- 问题：
  - `received$` 并发回写可能造成同实体时序覆盖问题。
- 修改：
  - 通过 `remoteApplyQueue` 串行执行回写任务。
- 收益：
  - 避免并发覆盖，时序更可预测。
- 风险：
  - 高峰期单队列可能产生延迟。
- 验证方式：
  - 后续压测观察长队列场景；必要时按 `resource` 分队列。

### S8. 观测面和控制面拆分（已完成）

- 问题：
  - 事件上报、状态快照、同步控制若耦合，会导致接口噪声上升。
- 修改：
  - `SyncController` 只聚合控制接口，`SyncDevtools` 只处理事件和快照。
- 收益：
  - 调试能力保留，同时不污染主逻辑。
- 风险：
  - 事件类型扩展时可能出现漏记。
- 验证方式：
  - 事件订阅快照一致性测试（下一阶段）。

## 4. 推荐目录终态（sync 插件）

```text
packages/plugins/atoma-sync/src/
  plugin.ts
  types.ts
  controller/SyncController.ts
  replication/ReplicationManager.ts
  replication/runtime.ts
  bridge/LocalBridge.ts
  bridge/remoteApply.ts
  mapping/document.ts
  mapping/resources.ts
  rxdb/database.ts
  rxdb/schema.ts
  devtools/sync-devtools.ts
```

## 5. 执行计划（一步到位，无兼容层）

1. 已完成：
   - 入口拆分、职责分层、transport token 注入、options 收敛。
2. 下一步（高优先）：
   - 文档互转 codec 再收敛（S6 完成态）。
   - 为 `SyncController`/`ReplicationManager`/`LocalBridge` 补单测。
3. 完成标准：
   - `pnpm --filter atoma-sync run typecheck`
   - `pnpm --filter atoma-sync run build`
   - `pnpm --filter atoma-backend-atoma-server run typecheck`
   - `pnpm --filter atoma-backend-atoma-server run build`
   - `pnpm --filter atoma-types run typecheck`
   - `pnpm --filter atoma-types run build`
   - `pnpm --filter atoma-client run typecheck`

## 6. 关于“atoma-sync 复杂度是否主要来自文档互转”

结论：是，且是“主要复杂度之一”。

原因：

1. 互转同时承担版本语义、删除语义（tombstone）、系统字段清洗、回写数据形态统一。
2. 互转跨越主链路（Atoma）和同步引擎（RxDB）边界，天然是复杂度集中点。
3. 若互转不单点治理，会在 push/pull/localWrite/remoteApply 形成重复分支。

策略：

1. 保留互转边界（不能消失）。
2. 把互转复杂度压缩到单模块（能集中）。
3. 其余模块只消费稳定数据形态（能降认知成本）。
