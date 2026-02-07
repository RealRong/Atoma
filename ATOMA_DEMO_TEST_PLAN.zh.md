# Atoma Demo 功能测试方案（含插件）

> 目标：设计一套可操作的 Demo，用来系统覆盖核心能力与所有插件（backend、sync、history、observability、devtools）。
> 假设：核心 API 已稳定，类型检查已通过。

## 1. 目标与边界
- **目标**：用一个 Demo 覆盖 Atoma 的核心职责与插件扩展能力，并形成可复用的测试清单。
- **边界**：只验证功能与交互正确性，不做性能基准或生产级安全验证。
- **运行入口**：建议基于现有 `demo/` 的 Vite React 应用（`pnpm demo:web`）。

## 2. Demo 结构与页面划分
建议把 Demo 划分为以下模块（可页签或路由）：
- **Setup**：选择 backend、启用插件、初始化 schema
- **Stores**：CRUD + 订阅 + 快照
- **Query**：查询条件、排序、分页、select 字段
- **Indexes**：索引状态、查询命中、更新后维护
- **Relations**：belongsTo/hasOne/hasMany 展示与变更
- **Sync**：push / pull / subscribe 模式验证
- **History**：undo / redo / scope
- **Observability**：traceId/requestId + debug event 流
- **Devtools**：与 devtools 插件联动、监控快照

## 3. 核心能力覆盖清单
### 3.1 Client + Runtime
- `createClient`：不同插件组合是否能正常启动
- `stores.ensure`：创建 store + 读写基础路径
- `runtime.io.executeOps`：通过 IO handler 链执行
- `hooks`：read/write 生命周期是否触发

### 3.2 CRUD + Query
- Create / Update / Delete / Upsert
- Query：where / orderBy / limit / offset / select
- Patch / Writeback：操作日志一致性

### 3.3 Indexes
- 索引建表与同步
- 查询命中索引与 fallback 路径

### 3.4 Relations
- 单向与双向关系模型
- 关联更新后的读一致性

## 4. 插件覆盖清单
### 4.1 Backend 插件
**目标**：在 Setup 中可切换 backend，保持功能一致。
- `atoma-backend-memory`
    - 适合基础 CRUD/Query 验证
- `atoma-backend-indexeddb`
    - 持久化 + reload 后数据保留
- `atoma-backend-http`
    - 远程 ops 执行（需 mock server）

### 4.2 Sync 插件
**目标**：验证推拉、订阅、重连、错误处理。
- `syncOpsDriverPlugin()`：注册 `sync.driver`
- `sseSubscribeDriverPlugin()`：注册 `sync.subscribe`
- `syncPlugin()`：引擎装配

场景：
- push-only / pull-only / subscribe-only / pull+subscribe / full
- subscribe 断开后重连
- push 队列堆积与清理

### 4.3 History 插件
**目标**：undo/redo 与 scope 行为正确。
- 记录写操作 patches
- 同一 scope undo/redo 链

### 4.4 Observability 插件
**目标**：trace 贯通与事件可视化。
- `observe.createContext`
- 读写事件 `obs:*`
- traceId/requestId 注入

### 4.5 Devtools 插件
**目标**：能观察 stores/index/sync/history 的快照。
- `devtoolsPlugin()` 注册
- devtools registry 接入

## 5. Demo 数据集建议
准备 2-3 个 stores：
- `users`：id/name/age/region
- `posts`：id/title/authorId
- `comments`：id/postId/content

关系：
- users hasMany posts
- posts hasMany comments
- posts belongsTo users

索引：
- users: `region`, `age`
- posts: `authorId`

## 6. 交互流程建议（关键路径）
1) 选择 backend + 插件组合 → 创建 client  
2) 初始化数据 → CRUD/Query/Index/Relations 全部验证  
3) 开启 history → 多步写入后 undo/redo  
4) 开启 observability → 查看 trace/debug 事件  
5) 开启 sync → push/pull/subscribe 模式切换  
6) Devtools 快照查看 → stores / indexes / sync / history  

## 7. 验收清单（测试通过标准）
- 任一 backend 下核心 CRUD/Query 一致
- 索引命中与非命中路径一致
- Relations 在更新后读一致
- sync 5 种模式均可启动/停止/恢复
- history undo/redo 可跨多步验证
- observability debug event 可视化
- devtools 快照不报错且字段完整

## 8. Mock/Adapter 建议
若没有真实后端：
- http backend 可以使用 mock server 提供 ops endpoint
- sse subscribe 可使用本地 mock SSE

## 9. 后续可扩展
- 性能基准：批量写入、批量查询
- 大数据量分页/索引压力
- 多 client 协作 + sync 冲突模拟

