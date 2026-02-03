# atoma-core / atoma-runtime / atoma-client 目录与入口改造方案（面向新人）

目标：在不改变现有架构关系（core → runtime → client）的前提下，通过**目录归类、入口聚合、命名统一**来降低理解成本，让新人顺着“流程入口 → 子系统 → 细节实现”的路线快速把握全貌。

## 1. 当前链路与结论

- 依赖方向已健康：`core → runtime → client`，无反向耦合。
- runtime 仅依赖 core 的纯逻辑模块（store/query/relations/indexes）。
- client 仅依赖 runtime + core 的本地查询逻辑（合理）。
- **现阶段的杂音主要来自目录散布与入口不集中**，而不是结构性耦合。

因此改造目标聚焦在：
1) 目录重排，让流程逻辑能被“一眼看懂”。
2) 入口文件更像“导航页”，减少多跳。
3) 命名一致化（flow/handler/registry 等），降低概念成本。

## 2. 总体改造原则

- 不改功能与行为，仅移动/归类文件。
- 每个模块必须有**单一入口 index.ts**，入口只做“聚合导出 + 简短注释”。
- 新人视角从“功能入口”进入，优先把 Read/Write 作为流程中心。
- 业务无关的基础逻辑下沉 core；runtime 保持“流程编排”；client 保持“插件编排”。

## 3. atoma-runtime 目录改造（流程视角）

### 3.1 现状问题
- flow 文件分布在 `runtime/read`, `runtime/write`，但相关持久化/transform/策略散落。
- `runtime/StrategyRegistry.ts`、`runtime/persistence/*`、`runtime/transform/*` 没有统一入口。
- 新人不容易从入口理解写入/读取链路。

### 3.2 推荐目录结构
```
packages/atoma-runtime/src/
  runtime/
    flows/
      ReadFlow.ts
      WriteFlow.ts
      write/
        prepare.ts
        finalize.ts
    persistence/
      persist.ts
      ack.ts
      index.ts
    transform/
      DataProcessor.ts
      index.ts
    registry/
      StrategyRegistry.ts
      index.ts
    Runtime.ts
    index.ts
  store/
    Stores.ts
    ConfigResolver.ts
    StoreStateWriter.ts
    index.ts
```

### 3.3 入口与注释策略
- `runtime/index.ts`：只导出 `Runtime`，并加 6~10 行“流程说明”。
- `runtime/flows/index.ts`：导出 ReadFlow/WriteFlow，并给出流程图级别注释。
- `runtime/persistence/index.ts`：导出 `persist`/`ack`，加上“写入持久化入口”说明。
- `runtime/registry/index.ts`：统一策略注册入口，避免 StrategyRegistry 被认为是“杂项”。
- `store/index.ts`：说明 store 与 runtime 的关系（handle、stateWriter）。

### 3.4 Read/Write 的统一命名建议
- 所有内部函数以 `prepare` / `finalize` / `execute` 命名，避免 `ops` / `flow` 混用。
- flow 只处理“流程编排”，不要夹杂数据结构辅助函数。

## 4. atoma-core 目录改造（能力分块）

### 4.1 现状问题
- core 的模块边界较清晰，但缺少“导航式入口”。
- 新人难以知道 `store/` 与 `query/` 的职责界限。

### 4.2 推荐目录结构
```
packages/atoma-core/src/
  store/
    StoreWriteUtils.ts
    idGenerator.ts
    writeOps.ts
    writeback.ts
    optimistic.ts
    writeEvents.ts
    index.ts
  query/
    QueryMatcher.ts
    matcherOptions.ts
    normalize.ts
    localEvaluate.ts
    cursor.ts
    summary.ts
    engine/
      local.ts
    index.ts
  relations/
    RelationResolver.ts
    builders.ts
    compile.ts
    projector.ts
    utils.ts
    index.ts
  indexes/
    IndexManager.ts
    StoreIndexes.ts
    base/
      IIndex.ts
    implementations/
      StringIndex.ts
      TextIndex.ts
      NumberDateIndex.ts
      SubstringIndex.ts
    validators.ts
    tokenizer.ts
    utils.ts
    index.ts
  operationContext.ts
  index.ts
```

### 4.3 入口策略
- `core/index.ts` 保持 namespace 导出（Store/Query/Relations/Indexes/Operation）。
- 每个子目录 `index.ts` 加上 5~10 行概览注释：
  - store：写入/写回/乐观更新
  - query：本地执行/匹配器
  - relations：关系编译器
  - indexes：索引定义/应用

## 5. atoma-client 目录改造（插件编排视角）

### 5.1 现状问题
- plugins / drivers / backend 位置分散，新人不清楚“插件注册流程”。
- defaults 与 plugins 没有形成“默认插件层”的强入口。

### 5.2 推荐目录结构
```
packages/atoma-client/src/
  internal/
    createClient.ts
    runtimeRegistry.ts
    index.ts
  plugins/
    PluginRegistry.ts
    HandlerChain.ts
    CapabilitiesRegistry.ts
    PluginRuntimeIo.ts
    PluginRuntimeObserve.ts
    index.ts
  backend/
    types.ts
    http/
      HttpOpsClient.ts
      internal/
        batch/BatchEngine.ts
        transport/
          jsonClient.ts
          opsTransport.ts
    index.ts
  defaults/
    DefaultObservePlugin.ts
    LocalBackendPlugin.ts
    HttpBackendPlugin.ts
    index.ts
  index.ts
```

### 5.3 入口策略
- `client/index.ts`：只导出 `createClient` + 注册表 + HandlerChain；不再 re-export 任何类型。
- `plugins/index.ts`：聚合所有插件层核心实体，并加一段“插件生命周期”说明。
- `defaults/index.ts`：导出默认插件集合，提示“默认组合与可替换点”。

## 6. 文件命名与入口一致性建议

- 统一入口命名：`index.ts` 只做“聚合导出 + 简短说明”。
- 统一概念命名：
  - flow = 流程编排
  - handler = 插件链条处理
  - registry = 运行时注册器
  - store = 数据结构/持久化层封装

## 7. 新手理解路径（建议文档模板）

建议在 `ARCHITECTURE.md` 或 README 中补一段新人路径：
1) Runtime → ReadFlow / WriteFlow（流程总览）
2) Store（handle + stateWriter + indexes）
3) Core（query / store / relations / indexes）
4) Client（插件注册 + handler 链）

## 8. “已足够”的判断

- 结构链路已经稳定，功能层面无需再抽象。
- 后续优化应聚焦 “更清晰的入口 + 更紧凑的目录结构”。
- 如果不再计划大规模重构，当前方案已足够作为长期基础。

## 9. 可选的小改造（不强制）

- 在 runtime/read、runtime/write 中增加 `README.md` 说明流程顺序。
- 为 `StoreStateWriter` 加一行类注释，强调“仅内部使用”。
- 将 `StoreStateWriter` 与 `Stores` 的关系在 `store/index.ts` 写清楚。

---

如果需要，我可以直接按本方案调整目录结构与入口文件（不改变代码逻辑）。
