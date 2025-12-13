# Atoma 架构详解（2025-12-06）

## 1. 总览
- **定位**：基于 Jotai + Immer 的同步型状态引擎，提供统一的存储适配层（HTTP / IndexedDB / Hybrid）、查询与索引、乐观更新、历史回滚、注册表式的多实例管理。
- **核心数据结构**：以 `Map<StoreKey, Entity>` 作为单个资源的权威缓存，通过 Jotai `PrimitiveAtom` 暴露给 React。
- **执行链**：调用 Store API → 进入队列 → `OperationApplier` 产出 patches/changedFields → `AdapterSync` 写入持久层并记录历史 → Jotai Store 更新驱动 UI。

## 2. 模块分层
### core
- **BaseStore**：纯函数 CRUD（基于 Immer），统一调度 `dispatch`，提供版本快照、全局 `globalStore`。
- **StoreContext**：封装 per-store 依赖（版本跟踪、队列、历史、操作应用、同步器、队列配置），避免全局单例导致的 SSR 共享。
- **initializeLocalStore**：将适配器与原子绑定，返回具备 `add/update/delete/get/findMany` 的 `IStore`；处理批量 get、schema 校验、生命周期钩子、索引维护。
- **OperationApplier**：在内存中应用一批操作，生成 `patches / inversePatches / changedFields / appliedData`。
- **AdapterSync**：根据队列模式（乐观 optimistic / 严格 strict）写适配器，回滚/回调，成功后记录历史。
- **QueueManager**：按原子分组的待处理队列 + 按 id 合并（add/update/remove 优先级）。
- **AtomVersionTracker**：全局与字段级版本号，用于 `useFindMany` 的版本快照依赖。
- **query & indexes**：`applyQuery`（where/orderBy/limit/offset + Top-K 优化）；`IndexManager` + Number/String/Text 索引，支持候选集收缩与按索引排序。
- **idGenerator**：默认类似 Snowflake 的 53-bit 数字 id，可设置自定义生成器。

### adapters
- **HTTPAdapter**：可配置端点、重试、冲突解决（ETag/版本字段、策略 last-write-wins/server-wins/manual）、批量、离线队列、并发控制、事件回调。
- **IndexedDBAdapter**：基于 Dexie，本地离线缓存，支持 `findMany`（本地 applyQuery + 简易 cursor）。
- **HybridAdapter**：组合 local + remote，读写策略（local-first/remote-first/both 等）、缓存超时、删除同步、后台刷新。

### server
- **目标**：提供一套语言无关的 HTTP 协议（REST + Batch）与参考实现；后端可以直接使用 `src/server/*`，也可以在 Java/PHP 等环境按同一协议自行实现解析与数据库访问。
- **统一执行链**：`parseHttp → validateAndNormalizeRequest → guardRequest → executeRequest`（`src/server/handler.ts`）。
- **REST（默认路径，面向普通开发者）**：
  - 路由：`GET /:resource`、`GET /:resource/:id`、`POST /:resource`、`PUT|PATCH /:resource/:id`、`DELETE /:resource/:id`
  - 查询参数（分页/过滤/排序）：`limit/offset/includeTotal/after/before/orderBy/where[...]`
    - where 示例：`where[id]=1`、`where[id][in][]=1&where[id][in][]=2`、`where[age][gte]=18`
  - 响应形态：列表返回 `{ data: T[], pageInfo? }`；单条返回 `{ data: T }`；错误返回 `{ error }`
- **Batch（性能路径）**：
  - 路由：`POST /batch`
  - 请求形态：`{ action:'query'|'bulkUpdate'|..., ... }`
  - 响应形态：`{ results: [...] }`
  - 约束：启用 Batch 时，前端（HTTPAdapter/BatchEngine）应将所有操作都发往 `/batch`，避免 REST 与 Batch 两套语义漂移。

### hooks
- `createUseValue`：按 id 精细订阅（selectAtom），缺失时触发 `getOneById`。
- `createUseAll`：订阅整个 Map，返回数组。
- `createUseFindMany`：支持 `fetchPolicy`（local | remote | local-then-remote）、`skipStore`（瞬时模式），带分页 `pageInfo`，提供 `refetch / fetchMore`。

### history
- `HistoryRecorder`：在适配器成功后记录 patches。
- `HistoryManager`：undo/redo 栈，可选持久化到适配器，支持回滚失败处理。

### registry
- `StoreFactory`：通过注册表惰性创建/缓存 Store，支持默认适配器工厂 + 资源级 HTTP 配置覆写。

## 3. 核心流程（以 addOne 为例）
1) 调用 `addOne` → beforeSave 钩子 → schema 校验 → transform → `BaseStore.dispatch`.
2) `QueueManager` 入队；微任务中 `handleQueue` 批量取队列。
3) `OperationApplier` 对当前 Map 做草稿修改，生成 patches / inversePatches / changedFields。
4) `AdapterSync` 根据 `queueConfig.mode`：
   - **optimistic**：先写 Jotai store，再异步写适配器；成功回调立即触发。
   - **strict**：先写适配器，成功后才落地 Jotai store。
5) 适配器成功 → 记录历史 → 回调 onSuccess；失败 → 回滚（optimistic）并调 onFail。

## 4. 队列与合并
- 同一 atom 的操作按 id 合并：delete 优先级最高；add+update 折叠为 add；多次 update 合并字段。
- 默认 `queueConfig.enabled=true`；可通过 `createSyncStore({ queue: { enabled: false }})` 关闭立即执行。

## 5. 版本与订阅
- `AtomVersionTracker` 为每个 atom 维护全局版本与字段版本；`getVersionSnapshot(atom, fields)` 用于 `useFindMany` 依赖，避免粗暴全量订阅。

## 6. 索引与查询
- `IndexManager` 按字段持有不同索引类型，`collectCandidates(where)` 返回候选 id 交集（允许为超集候选），最终过滤/排序/分页统一由 `applyQuery` 完成。
- `applyQuery` 提供 where/orderBy/limit/offset；当 limit 占比 <10% 采用 quick-select Top-K，减少全排序成本。
- 乐观模式下索引与 Map 同步更新：写入前先更新索引，失败回滚；严格模式在持久化成功后更新索引。
- `skipStore` 用于大数据/瞬时查询：即便在 strict 模式也不会把结果写入 Map，避免内存膨胀；若需要缓存，请取消 `skipStore`。
- `useFindMany` 的远程请求触发仅依赖 `queryKey/fetchPolicy/store`，不会因本地缓存变化重复请求。

### IndexedDBAdapter 优化
- `findMany` 在「无 where / orderBy.id」场景走 Dexie 游标分页：`where('id').above/below` + `offset/limit`，避免全量 `toArray()`；仅在需要总数或复杂过滤时回退全量。
- 快速路径下不计算 total，降低 IO；需要 total 时由回退路径处理。

### 数字/日期索引校验
- `normalizeNumber` 现拒绝 NaN/Infinity（含无效日期字符串转数值失败的情况），防止不可排序键进入索引。

## 7. 乐观与严格模式
- 配置入口：`createSyncStore({ queue: { mode: 'optimistic' | 'strict' }})`。
- 乐观模式：UI/atom 立即更新；**onSuccess 在适配器成功后才触发**，失败则回滚本地并触发 onFail。
- 严格模式：适配器成功后才写 atom，并触发 onSuccess；失败不改本地。

## 8. 离线与冲突（HTTPAdapter）
- 重试：指数/线性回退，支持最大尝试次数与抖动。
- 冲突：基于 ETag/版本字段，策略可选 last-write-wins / server-wins / manual（onConflict 回调）。
- 离线队列：可启用本地存储排队，重连后重放；事件回调 onSyncStart/onSyncComplete/onQueueFull 等。

## 9. 扩展点
- 自定义适配器：实现 `IAdapter<T>`（put/bulkPut/delete/bulkDelete/get/bulkGet/getAll，选实现 applyPatches）。
- 自定义索引：实现 `IIndex<T>`（add/remove/queryCandidates/clear/getStats）。
- 自定义 id 生成：`setDefaultIdGenerator` 或在 `createSyncStore` 传入 `idGenerator`。
- Schema：接受 Zod/Yup 或函数，支持 sync/async。
- 生命周期钩子：beforeSave / afterSave。

## 10. 默认值速查
- queue.enabled = true，queue.mode = 'optimistic'
- fetchPolicy (useFindMany) 默认 `local-then-remote`
- TextIndex tokenizer：Intl.Segmenter (可用时)；最小 token 长度 3，fuzzy 距离默认 1
- Hybrid cacheTimeout 默认 5 分钟，syncDeletes 默认 true

## 11. 开发者快速路径
1) 定义适配器（HTTP / IndexedDB / Hybrid）。
2) `const todoStore = createSyncStore({ name: 'todos', adapter, indexes: [...] })`
3) 组件使用 `const todos = todoStore.useFindMany({...})` / `useValue(id)`。
4) 可选：`setHistoryCallback(history.record)` 启用 undo/redo。
5) 需要多资源时，用 `StoreRegistry` 注册并设置默认适配器工厂。

## 12. 备注与改进方向
- 统一回调语义（乐观回滚与 onSuccess/onFail 的顺序）和索引同步时机。
- 增加可插拔 logger/metrics，便于生产观测。
- 补充端到端示例与测试矩阵，覆盖队列、索引、乐观/严格模式、离线与冲突场景。
