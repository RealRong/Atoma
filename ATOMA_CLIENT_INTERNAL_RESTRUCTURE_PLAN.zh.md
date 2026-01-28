# client/internal 结构简化与职责拆分结论

> 目标：文件名首字母大写、以 class 为核心承载复杂职责；逻辑分块清晰、复用优先、结构尽量简单。

## 现状概览
client/internal 当前主要由两类组成：
- **Runtime 相关（已有 class）**：`ClientRuntime*` 系列
- **Factory/Build 相关（函数式文件较多）**：`build*` 族（已拆分）

已完成的拆分（上一阶段）：
- `buildClient.ts` 变为组装器
- IO、Channel、DevtoolsRegistry、PluginContext、PluginSystem 分离

## 结构优化方向（保持简单）
### A) “类为核心，函数为 glue” 的目录组织
建议把复杂能力固化成 class，并统一首字母大写文件名：
- `ClientRuntime.ts`（合并 createClientRuntime.ts + ClientRuntime class，文件名大写）
- `ClientRuntimeInternalEngine.ts`（保持）
- `ClientRuntimeStores.ts`（保持）
- `ClientRuntimeObservability.ts`（保持）
- `StoreConfigResolver.ts`（替代 storeConfig.ts 中的逻辑）

可把 build* 体系整理到 `Builder` 类：
- `ClientBuilder.ts`：聚合 IO/Channel/Plugin/Context/Devtools 注册
- `IoPipeline.ts`：class（替代 buildIoPipeline.ts）
- `ChannelApis.ts`：class（替代 buildChannelApis.ts）
- `DevtoolsRegistry.ts`：class（替代 buildDevtoolsRegistry.ts）
- `PluginSystem.ts`：class（替代 buildPluginSystem.ts）
- `PluginContext.ts`：class/或静态构造（替代 buildPluginContext.ts）

### B) 文件命名统一（首字母大写）
建议统一替换：
- `buildClient.ts` -> `ClientBuilder.ts`
- `buildIoPipeline.ts` -> `IoPipeline.ts`
- `buildChannelApis.ts` -> `ChannelApis.ts`
- `buildDevtoolsRegistry.ts` -> `DevtoolsRegistry.ts`
- `buildPluginContext.ts` -> `PluginContext.ts`
- `buildPluginSystem.ts` -> `PluginSystem.ts`
- `storeConfig.ts` -> `StoreConfigResolver.ts`
- `createClientRuntime.ts` -> `ClientRuntime.ts`（内部保留 class）
- `createClient.ts` -> `ClientFactory.ts` 或 `CreateClient.ts`

## 可复用/可收敛点
### 1) ClientRuntime 组装
现在 `createClientRuntime.ts` 中有多处内聚逻辑：
- runtime 构造、local IO、persistence router
建议收敛为 class 内部私有方法：
- `ClientRuntime.createIo()`
- `ClientRuntime.createPersistence()`
- `ClientRuntime.createStores()`

### 2) Channel API 与 Protocol 复用
`buildChannelApis.ts` 里对 ops 构建与验证逻辑重复度高，可抽为 class：
- `ChannelApis.executeOps()`
- `ChannelApis.query()` / `ChannelApis.write()`
- `ChannelApis.remoteChangesPull()`

### 3) DevtoolsRegistry 统一能力
当前 registry 仅存在于 build 文件中，建议提升为 class 并独立测试（后续）。

### 4) PluginSystem + Context
`PluginSystem` 可变成 class，持有 `client` 与 `ctx`，让 `use/installAll/dispose` 更标准化。
`PluginContext` 可作为 class 或静态构建器，仅负责拼装 ctx。

## 目录结构建议（简版）
```
client/internal/
  ClientFactory.ts           // createClient 入口
  ClientBuilder.ts           // buildAtomaClient
  runtime/
    ClientRuntime.ts
    ClientRuntimeStores.ts
    ClientRuntimeInternalEngine.ts
    ClientRuntimeObservability.ts
    StoreConfigResolver.ts
  infra/
    IoPipeline.ts
    ChannelApis.ts
    DevtoolsRegistry.ts
    PluginContext.ts
    PluginSystem.ts
```

## 是否值得做
**结论：值得，且不会增加层级复杂度**。
- 通过“class 封装 + 文件名大写”统一风格，减少认知分裂。
- 逻辑聚合到 class 后，build 文件会非常薄，便于测试与替换。

## 推荐实施顺序（最小风险）
1) 文件重命名为大写（不改逻辑）
2) `build*` 迁移为 class，保持 API 不变
3) `createClientRuntime.ts` 内部方法类化
4) `storeConfig.ts` 类化为 `StoreConfigResolver`
5) 最后统一入口：`ClientFactory` + `ClientBuilder`

## 保持的约束
- 不增加超过两层嵌套目录
- class 文件名首字母大写
- build 层只负责“拼装与注入”
