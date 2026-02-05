ATOMA 核心层架构说明

定位
- 核心层负责“状态一致性 + 读写流程 + 持久化 + 变换”的统一编排
- 扩展能力由 plugins 承担，核心层保持稳定

边界与职责

1) atoma-core（纯算法层）
- 提供 Store/Query/Indexes/Relations/Operation 等纯函数或数据结构
- 不依赖 runtime，不包含 IO/持久化/订阅

2) atoma-runtime（运行时编排层）
- 统一入口：read / write / persistence / transform / stores / hooks / io
- 负责流程编排与策略执行
- 依赖 core，但不被 client/react 反向依赖

3) atoma-client（客户端组装层）
- 负责插件注册、IO 链路搭建、runtime 初始化
- 对外暴露 createClient / runtime / store API

4) atoma-react（视图绑定层）
- 通过 StoreBindings 订阅状态与查询
- 不直接依赖 runtime 内部结构

关键内部协议（简述）
- StoreHandle：内部最小句柄（state + storeName + config + relations）
- StoreState：状态快照与提交入口
- StoreBindings：react/hooks 访问内部的唯一桥接
- Runtime：唯一上下文与编排入口

核心链路（读写）

读链路（简化）
- 入口：runtime.read
- 优先使用 StoreState + Indexes 本地查询
- 必要时走 IO 查询，并进行 writeback

写链路（简化）
- 入口：runtime.write
- prepare → persist → writeback → commit
- hooks 在关键节点触发

扩展点（插件）
- IO / Read / Persist 等插件只提供执行能力
- 策略解释与流程控制仍由 runtime 统一处理

稳定性原则
- 核心协议稳定，不随功能扩张频繁变化
- 插件扩展不应侵入核心策略
- 内部依赖保持单向：core → runtime → client → react
