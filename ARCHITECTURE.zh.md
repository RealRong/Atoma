# Atoma 架构说明

> 基于 Jotai 的原子化持久化引擎，聚合状态、查询、适配器与历史能力。

## 1. 核心组成
- **状态容器**：每个 Store 持有 `Map<StoreKey, Entity>`，默认复用全局 Jotai `globalStore`（`core/BaseStore.ts`）。
- **调度与队列**：写操作经 `BaseStore.dispatch → QueueManager → OperationApplier → AdapterSync`，支持批处理、乐观/严格模式、Immer patches 回放。
- **版本跟踪**：`AtomVersionTracker` 记录全局与字段级版本，驱动查询重算与订阅精准更新。
- **索引与查询**：`IndexManager` 维护 number/date/string/text 索引，`findMany/applyQuery` 结合索引候选集与排序 Top-K 优化。
- **适配器层**：`IAdapter` 定义持久化接口，提供 IndexedDB、HTTP、Hybrid 三类实现，HTTP 支持离线队列、重试、冲突策略；Hybrid 组合本地缓存与远端。
- **历史与撤销**：`HistoryRecorder` 捕获成功的 patches；`HistoryManager` 基于 patches/inversePatches 提供 undo/redo，并可回写适配器。
- **扩展入口**：`StoreRegistry` 统一注册/获取 Store；`idGenerator` 默认雪花算法，可全局或单 Store 覆盖。

## 2. Store 创建与数据流
1. `createSyncStore(config)`（`core/createSyncStore.ts`）创建实体 Map 原子、装配 `initializeLocalStore`，并生成 React hooks（`useValue/useAll/useFindMany`）。
2. `initializeLocalStore` 挂载适配器、索引、schema 校验及生命周期钩子，返回 `IStore` 接口。
3. 读取路径：`getOneById`/`getMultipleByIds` 先查缓存，未命中时将请求批入 `batchGetOneTaskQueue`，一次性 `bulkGet`，填充缓存并重建索引；`getAll` 直接走适配器后回填缓存。
4. 写入路径（`addOne/updateOne/deleteOneById`）：
   - 预处理：`initBaseObject` 填充 id/时间戳 → `beforeSave` → `transformData` → `schema` 校验。
   - 调度：`BaseStore.dispatch` 根据 `queueConfig.enabled` 决定同步或微任务批量；事件聚合到同一原子的队列。
   - 应用：`OperationApplier` 在草稿上合并多事件，生成 `newValue + patches + inversePatches + changedFields`。
   - 同步：`AdapterSync` 在乐观模式下先写入 Jotai、递增版本，再调用适配器 `applyPatches`（或 put/delete 回退）。失败则回滚并触发 `onFail`；成功后记录历史回调。
   - 后处理：`afterSave` 触发；索引增删对应实体。
5. `queueConfig`（`core/BaseStore.ts`）控制是否批处理与模式（`optimistic`/`strict`），便于在弱网/调试场景切换。

## 3. 查询与索引
- **查询管线**：`findMany` 先基于当前缓存计算本地结果（即时反馈），随后从适配器拉全量更新缓存，再用最新数据重算。
- **索引选择**：`IndexManager.collectCandidates` 针对 `where` 中已建索引字段生成候选 ID 集；`coversWhere` 判断是否全索引覆盖以决定是否在索引层应用 limit/offset。
- **排序优化**：单字段 `orderBy` 且存在可排序索引时，`getOrderedCandidates` 直接返回有序 ID，减少排序开销。
- **过滤/排序实现**：`applyQuery` 支持 `eq/in/gt/gte/lt/lte/startsWith/endsWith/contains`，在有 `limit` 时采用 QuickSelect Top-K 优化。
- **索引类型**（`core/indexes`）：`NumberDateIndex`（区间/有序）、`StringIndex`（等值/前缀）、`TextIndex`（分词模糊）；均维护 `IndexStats` 便于观测。
- **订阅两层缓存**：`useFindMany` 先基于缓存过滤出 ID，再映射到最新实体；依赖字段版本快照，避免全局变动导致的过度重算。

## 4. React 订阅层
- `useValue(id)`: `selectAtom` 精确订阅单条；缓存缺失时触发 `getOneById` 批量获取。
- `useAll()`: 直接将 Map 转数组，Memo 避免重复分配。
- `useFindMany(opts)`: 结合版本快照、稳定序列化 queryKey、状态位（loading/error/isStale），并暴露 `refetch`。

## 5. 适配器层细节
- **接口契约**：`IAdapter` 统一 put/bulkPut/delete/bulkDelete/get/bulkGet/getAll/applyPatches，以及 `onConnect/onDisconnect/onError`。
- **IndexedDBAdapter**：基于 Dexie，序列化 Map/Set；支持批量、transformData；直接应用 Immer patches。
- **HTTPAdapter**：REST 适配器，内建重试（指数/线性+抖动）、ETag/版本头、冲突策略（LWW/server/manual + `onConflict` 钩子）、离线写入队列（localStorage 持久化、重连重放）、PATCH/PUT/DELETE 分流。
- **HybridAdapter**：组合本地+远端，可配置读（local-first/remote-first/...）写（remote-first/local-first/both/...）、缓存过期、删除同步；远端刷新时回填本地并记录同步时间。

## 6. 模型、校验与钩子
- `schema` 支持 zod/yup/函数，`validateWithSchema` 统一处理 sync/async 结果。
- `hooks.beforeSave/afterSave` 在 add/update 前后运行，可做时间戳、审计等处理；钩子失败会阻断写入。
- `transformData` 贯穿读/写，便于类型修正或兼容旧数据。

## 7. 历史与撤销
- `HistoryRecorder` 仅在适配器写入成功后记录 patches/inversePatches。
- `HistoryManager`（`src/history`）管理 undo/redo 栈，`applyPatchesOnAtom` 直接对 Jotai 原子应用 patches；可配置最大栈、持久化回写适配器、失败回滚与回调。

## 8. ID 策略
- 默认雪花号（53bit，安全 Number）：`timestamp<<12 + sequence`，epoch 2023-01-01，4k ids/ms。
- 全局 `setDefaultIdGenerator` 或 Store 级 `idGenerator` 可替换为字符串/UUID。

## 9. Store Registry
- `setDefaultAdapterFactory(name => adapter)` 设定统一工厂，`registerStore` 针对单 Store 自定义配置（适配器/transform/id/schema/hooks/indexes）。
- `Store('todos')` 按名称延迟创建并缓存，`preloadStores` 预加载；`clearStoreCache` 面向测试环境重置。

## 10. 关键文件导览
- `src/core/BaseStore.ts`：全局 store、队列配置、版本管理、调度入口。
- `src/core/initializeLocalStore.ts`：Store 装配、读写实现、索引重建。
- `src/core/ops/*`：操作合并与适配器同步。
- `src/core/indexes/*`：索引实现与工具。
- `src/hooks/*`：React 订阅层。
- `src/adapters/*`：三类适配器。
- `src/history/*`：撤销/重做。
- `src/registry/*`：Store 注册与工厂。
