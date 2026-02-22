# Version 语义剥离到 atoma-server 的最终重构方案（一步到位）

## 1. 结论先行

在“`version` 是 `atoma-server` 强绑定语义”的前提下，最优架构是：

1. `atoma-runtime` 与 `atoma-core` **完全不触碰** version。
2. 客户端侧 version 语义由 `atoma-backend-atoma-server` **独占负责**。
3. 服务端侧 version 语义继续由 `atoma-server` 协议与适配器负责。
4. `sync` 不再把 version 当 runtime 公共语义，改为依赖 backend 侧版本协调器。

本方案不保留兼容层，不做双轨迁移，直接收敛到目标架构。

---

## 2. 固定设计前提

1. version 不是通用状态库语义，而是后端并发控制语义（CAS/LWW/回执版本）。
2. runtime 的职责是本地状态编排，不是协议并发策略实现。
3. protocol 允许定义 version，不代表 runtime 必须内建 version。
4. 无用户、无兼容成本，本次重构以架构纯度与长期维护成本最低为目标。

---

## 3. 当前链路问题复盘（代码事实）

### 3.1 runtime/core 已被 version 污染

1. runtime prepare 阶段读取实体 `version` 并写入 `baseVersion`：
- `packages/atoma-runtime/src/runtime/flows/write/prepare/update.ts`
- `packages/atoma-runtime/src/runtime/flows/write/prepare/delete.ts`

2. runtime 本地提交推导 `nextVersion` 并写回：
- `packages/atoma-runtime/src/runtime/flows/write/apply.ts`

3. runtime 远端提交消费 `result.version` 并回写：
- `packages/atoma-runtime/src/runtime/flows/write/commit.ts`

4. core 通用 writeback 直接特化 `current.version` 字段：
- `packages/atoma-core/src/store/writeback.ts`

### 3.2 backend 侧语义边界未闭合

1. `atoma-backend-atoma-server` 目前仅薄封装，直接复用 shared 执行器：
- `packages/plugins/atoma-backend-atoma-server/src/plugin.ts`

2. version 推导逻辑实际上在 `atoma-backend-shared`：
- `packages/plugins/atoma-backend-shared/src/write/buildWriteEntry.ts`

这导致“atoma-server 专属语义”并未真正归位到 `atoma-backend-atoma-server`。

### 3.3 sync 深度耦合 runtime version

1. outbox 存的是 runtime `WriteEntry`，隐含 `baseVersion` 语义：
- `packages/plugins/atoma-sync/src/persistence/SyncWrites.ts`
- `packages/atoma-types/src/sync/outbox.ts`

2. push ack 后会对 outbox 做 `baseVersion` rebase：
- `packages/plugins/atoma-sync/src/lanes/push-lane.ts`
- `packages/plugins/atoma-sync/src/storage/outbox-store.ts`

3. ack 版本通过 `versionUpdates` 回写 runtime store：
- `packages/plugins/atoma-sync/src/applier/writeback-applier.ts`

### 3.4 服务端 version 是强语义（不应上移到 runtime）

1. protocol write 模型要求 update/delete 带 baseVersion，结果带 version：
- `packages/atoma-types/src/protocol/operation.ts`
- `packages/atoma-types/src/protocol-tools/ops/validate/write.ts`

2. atoma-server 写语义明确依赖 version：
- `packages/atoma-server/src/ops/writeSemantics.ts`
- `packages/atoma-server/src/ops/opsExecutor/write.ts`
- `packages/atoma-server/src/adapters/prisma/PrismaAdapter.ts`
- `packages/atoma-server/src/adapters/typeorm/TypeormAdapter.ts`

---

## 4. 目标架构（最终态）

## 4.1 三层职责边界

1. Runtime/Core 域（无 version）
- 只处理 `change/delta/query/processor`。
- 不读写实体 `version`。
- 不生成或消费 `baseVersion/expectedVersion/versionUpdates`。

2. Backend Bridge 域（atoma-backend-atoma-server）
- 负责把 runtime 写意图转成 protocol 写语义。
- 负责注入 `baseVersion/expectedVersion`。
- 负责消费 `result.version` 并维护本地版本视图。
- 负责 conflict/rebase/version 幂等策略。

3. Server Protocol 域（atoma-server）
- 继续执行当前 version 规则（CAS/LWW/服务端递增）。
- 向客户端返回 protocol 级 version 回执。

## 4.2 关键原则

1. runtime 的写模型是“业务意图模型”，不是“协议并发模型”。
2. version 状态只在 backend 插件维护（client 侧单一真相）。
3. sync 使用 backend 版本协调器，不直接操作 runtime version 字段。

## 4.3 Runtime 与插件的固定契约（必须锁死）

1. runtime 负责定义并产出“统一写语义”（create/update/upsert/delete + meta + options）。
2. 插件负责把 runtime 写语义映射为后端协议 `WriteEntry`，并处理后端结果映射。
3. 插件可以维护私有 side effect（如 VersionStore），但不能重定义 runtime 的公共写模型。
4. runtime 的公共 `writeback` 契约固定为业务数据回写，不接受插件私有字段。
5. 结论：插件负责“协议映射与语义实现”，runtime 负责“统一语义与状态编排”。

---

## 5. 类型与契约重构（一步到位）

## 5.1 atoma-types/core

1. `packages/atoma-types/src/core/entity.ts`
- 从 `Base` 移除 `version` 字段。

2. `packages/atoma-types/src/core/writeback.ts`
- 从 `StoreWritebackArgs` 移除 `versionUpdates`。
- `writeback` 仅保留 `upserts/deletes`。

## 5.2 atoma-types/runtime

1. `packages/atoma-types/src/runtime/persistence.ts`
- `WriteEntry.update/delete` 去掉 `baseVersion`。
- `WriteEntry.upsert` 去掉 `expectedVersion`。
- `WriteItemResult.ok` 去掉 `version`。
- `WriteItemResult.current` 去掉 `current.version`。

2. runtime 只保留：
- `action + item + meta + options` 的业务写意图。

3. runtime 写回契约固定为：
- `writeback({ upserts?, deletes? })`
- 不允许插件注入 `pluginMeta`、`versionUpdates` 等私有字段到 runtime 写回接口。

## 5.3 atoma-types/sync

1. `packages/atoma-types/src/sync/outbox.ts`
- `commit.rebase` 去掉 `baseVersion` 模型。

2. sync outbox 不再承载“待提升 baseVersion”的职责。

## 5.4 atoma-types/protocol（保持）

1. `protocol/operation.ts` 继续保留 version 强约束。
2. protocol-tools 校验继续保留 version 规则。

说明：protocol 是 atoma-server 域契约，保持不变。

---

## 6. 运行时与核心实现重构

## 6.1 atoma-core

1. `packages/atoma-core/src/store/writeback.ts`
- 删除 `version` 字段特化逻辑。
- 仅保留 map upsert/delete 与 change 合并算法。

## 6.2 atoma-runtime

1. 删除 version 相关写准备：
- `prepare/update.ts`
- `prepare/delete.ts`

2. 删除本地版本推导：
- `write/apply.ts` 中 `collectLocalVersionUpdates` 全链路删除。

3. 删除远端版本回写：
- `write/commit.ts` 中 `result.version -> versionUpdates` 删除。

4. `StoreState.writeback` 仅处理 `upserts/deletes`。

---

## 7. atoma-backend-atoma-server 作为 version 唯一客户端入口

## 7.1 新增内部模块（建议）

在 `packages/plugins/atoma-backend-atoma-server/src/` 新增：

1. `version/VersionStore.ts`
- 维护 `resource + id -> latestServerVersion`。
- 支持内存/持久化实现。

2. `version/VersionCoordinator.ts`
- 根据 runtime 写意图与 VersionStore 生成 protocol 写条目。
- 处理 `update/delete` 的 baseVersion 解析。
- 处理 `upsert(cas)` 的 expectedVersion 解析。

3. `write/encodeWriteEntries.ts`
- runtime entries -> protocol entries（注入 version 字段）。

4. `write/applyWriteResults.ts`
- 消费 protocol `result.version`，更新 VersionStore。
- 输出 runtime 需要的结果结构（无 version）。

5. `sync/VersionRebase.ts`
- 处理 push ack 后的版本前推逻辑（更新 VersionStore，而非改 runtime/outbox entry）。

## 7.2 执行器接入

`atoma-backend-atoma-server` 不再直接裸用 shared 的版本构造逻辑，而是：

1. 先用 coordinator 编码写请求。
2. 调用 `HttpOperationClient` 发 protocol 请求。
3. 解码响应并更新 VersionStore。
4. 将结果映射回 runtime 结果模型（无 version 字段）。

## 7.3 插件边界约束（防止职责回流）

1. 插件只能做编码/解码与 side effect，不得改写 runtime 事件语义。
2. 插件不得扩展 runtime 的 `StoreState` / `writeback` 公共结构。
3. 插件若需要额外数据（如 serverVersion、conflictMeta），只保存在插件私有存储或私有事件中。

---

## 8. atoma-backend-shared 收敛策略

1. `atoma-backend-shared` 只保留通用 op 执行骨架、错误归一、query/write 调度。
2. 移除 atoma-server 专属 version 注入逻辑（尤其 `buildWriteEntry` 的 base/expected 推导）。
3. 若需要可扩展，改为“注入 codec/coordinator hook”，但 shared 默认不包含 version 策略。

---

## 9. sync 全链路重构（与 version 脱耦）

## 9.1 Outbox 模型

1. outbox 仅存业务写意图（无 baseVersion/expectedVersion）。
2. push 前由 `atoma-backend-atoma-server` 协调器注入协议 version 字段。

## 9.2 PushLane rebase

1. 删除 `rebaseById.baseVersion` 回写 outbox 逻辑。
2. 改为 `ack -> VersionStore.bump(resource,id,serverVersion)`。

## 9.3 WritebackApplier

1. 删除 `versionUpdates` 写回 runtime。
2. 仅写回业务数据（upserts/deletes）。
3. version 状态维护留在 backend 插件。

## 9.4 Sync driver

1. `operation-driver` 不再从 runtime `WriteEntry` 直接要求 `baseVersion`。
2. 增加 backend 协调器依赖（由 `atoma-backend-atoma-server` 通过 service token 提供）。
3. 没有该协调器时，对需要版本的动作直接 fail-fast（错误信息明确）。
4. sync 侧只调用协调器获取协议条目，不直接读取 runtime/store 的 version 信息。

---

## 10. 其他 backend 插件的定位（必须明确）

为了保持架构一致性，需做单一决策（推荐 A）：

1. 方案 A（推荐）：
- `atoma-backend-memory`、`atoma-backend-indexeddb` 转为“version-free 本地后端”。
- 不模拟 atoma-server 版本语义。
- 若要走 sync + CAS，统一使用 `atoma-backend-atoma-server`。

2. 方案 B：
- 让 memory/indexeddb 也实现一套 server-like version 协调器。
- 代价是维护两套后端 version 语义，不符合“最简架构”目标。

本方案采用 **A**。

---

## 11. 一次性实施顺序（无兼容）

1. 修改 `atoma-types`：runtime/core/sync 去 version；protocol 保持。
2. 先定义固定契约：runtime 写语义模型 + runtime writeback 最小模型 + backend 协调器 service token。
3. 修改 `atoma-core`：删除 writeback version 特化。
4. 修改 `atoma-runtime`：删除 prepare/apply/commit 中所有 version 逻辑。
5. 修改 `atoma-backend-shared`：剥离 version 注入能力。
6. 修改 `atoma-backend-atoma-server`：新增 VersionStore + VersionCoordinator 并接管写编码/回执处理。
7. 修改 `atoma-sync`：outbox/push/applier/driver 改为 backend 侧 version 协调。
8. 修改 memory/indexeddb：切到 version-free 执行路径。
9. 清理 `atoma-shared` 中仅服务 runtime 的 version helper（如不再需要则迁移或删除）。

---

## 12. 验证矩阵

## 12.1 结构性验证

1. runtime/core 代码中不再出现：
- `baseVersion`
- `expectedVersion`
- `versionUpdates`
- 对实体 `version` 的读写

2. version 相关实现仅存在于：
- `atoma-backend-atoma-server`
- `atoma-server`
- `protocol/protocol-tools`

3. runtime 公共接口中不再出现插件私有写回字段：
- `writeback` 仅允许 `upserts/deletes`。
- 插件私有信息只能停留在插件内部存储与内部流程。

## 12.2 行为验证

1. atoma-server 路径下：
- create/update/upsert/delete 的 CAS/LWW 行为与现状一致。
- 冲突返回与幂等行为一致。

2. sync 路径下：
- ack/retry/reject 不丢单。
- 不出现版本回退。
- 不再依赖 runtime/store 的 version 字段。

3. 非 atoma-server 路径下：
- runtime 本地写与查询正常。
- 不要求任何 version 字段即可工作。

## 12.3 命令建议

1. `pnpm --filter atoma-types run typecheck`
2. `pnpm --filter atoma-core run typecheck`
3. `pnpm --filter atoma-runtime run typecheck`
4. `pnpm --filter atoma-backend-shared run typecheck`
5. `pnpm --filter atoma-backend-atoma-server run typecheck`
6. `pnpm --filter atoma-sync run typecheck`
7. `pnpm typecheck`
8. `pnpm test`

---

## 13. 风险与控制

1. 风险：sync 改造跨度大。
- 控制：先锁定 outbox 语义，再改 driver，再改 applier，最后联调 push lane。

2. 风险：shared 与 atoma-server plugin 职责拆分后接口不稳定。
- 控制：先定义稳定的 codec/coordinator 接口，再做包内迁移。

3. 风险：memory/indexeddb 行为变化。
- 控制：文档明确其定位为 version-free，本地开发用途；需要 server 语义时使用 atoma-server plugin。

---

## 14. 最终决策（本方案生效）

1. `version` 从 runtime/core **完全剥离**。
2. `version` 客户端职责收敛到 `atoma-backend-atoma-server`。
3. `atoma-server` 保持 version 强语义中心。
4. `sync` 改为依赖 backend 版本协调器，不再依赖 runtime version。
5. 全仓不保留兼容别名与过渡路径，直接一次性收敛。
