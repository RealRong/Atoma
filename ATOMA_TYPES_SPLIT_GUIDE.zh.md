ATOMA Types 拆分清单（最终方案）

目标：把“跨包契约”集中到 atoma-types；实现细节保留在各包内，避免 atoma-types 变成全域依赖中心。

一、必须迁移到 atoma-types（跨包契约/公共 API）
1) 核心实体与公共行为
- Entity 基础类型与通用约束
- StoreSchema / SchemaLike / SchemaDefinition
- Runtime 的公开请求与结果类型（如 PersistRequest / PersistResult 这一类）
- 读写操作协议的公共枚举与字段约定（WriteOpKind / ReadOpKind 等）

2) 插件与扩展协议
- ClientPlugin / PluginContext / PluginLifecycle
- CapabilitiesRegistry 公开契约（注册/读取的 key 与结构）
- Driver / Transport 协议：Ops/Sync/Stream/Observe 的最小接口

3) 观测与调试协议
- ObservabilityContext / DebugConfig / DebugEvent / Explain
- Devtools 协议结构：DevtoolsMeta / DevtoolsRegistry 以及 DEVTOOLS_*_KEY 常量

4) Sync 公开协议
- SyncTransport / SyncDriver / SyncSubscribeDriver 最小能力接口
- Sync 推拉/订阅数据包结构与错误码（如果跨包共享）

5) 客户端公开类型
- CreateClientOptions / AtomaClient / ClientRuntimeApi
- Client 端可注入默认配置结构（默认 plugins / defaults 结构）

二、建议保留在各包内（实现细节/内部中间态）
1) atoma-core 内部
- Store 内部状态结构（StoreState/StoreSnapshot）
- 写入流水线内部中间类型（WriteOperation、WriteEventDetail）
- Optimistic 计算/rollback 过程使用的临时结构
- 索引/查询内部 matcher 与缓存结构

2) atoma-runtime 内部
- StrategyRegistry 内部结构
- Persistence 策略实现细节与执行上下文
- Runtime 内部流程参数（如内部 write/read flow 参数组合）

3) atoma-client 内部
- 插件链路内部 handler 组装类型
- createClient 内部构建过程的临时结构
- 默认 plugins 的私有配置类型（如果不暴露给用户）

4) atoma-sync 内部
- SyncEngine、Lane、Scheduler 内部状态
- 本地队列、重试、批处理等实现结构

5) atoma-devtools 内部
- 协议适配器内部状态与具体实现类型

三、边界判断原则（用于新增类型）
1) 是否跨包直接导入？是 → 放 atoma-types；否 → 留在包内。
2) 是否属于公共 API 合约（会影响用户/第三方插件实现）？是 → 放 atoma-types。
3) 是否实现细节或可能频繁变化？是 → 留在包内。
4) 是否仅用于单一包内部流程/中间态？是 → 留在包内。

四、命名空间建议（atoma-types 内部组织）
- Core.*：核心实体、Schema、Store 行为契约
- Runtime.*：runtime 对外请求/结果、策略与运行期接口
- Client.*：client 公开 API、插件契约、扩展位
- Protocol.*：读写/同步/调试等跨包协议
- Observability.*：观测与调试事件

五、落地检查清单（迁移时自检）
- 类型是否在两个以上包被直接引用？
- 删除原包导出后是否仍有跨包引用？
- atoma-types 是否只包含“稳定契约”，不含实现细节？
- 每次迁移是否同步更新入口与文档？
