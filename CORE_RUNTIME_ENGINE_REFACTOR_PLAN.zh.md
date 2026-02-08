# CoreRuntimeEngine 重构方案（命名规范 + 精简 API）

## 1. 目标

1. `CoreRuntimeEngine` 的 API、类型、文件、目录命名统一行业规范。
2. API 语义保持清晰，同时避免过长命名。
3. 通过分区接口让职责边界与流程更清楚。

---

## 2. 命名规范（强约束）

### 2.1 基础风格

- 类型 / 类 / 接口：`PascalCase`
- 函数 / 方法 / 变量：`camelCase`
- 常量：`UPPER_SNAKE_CASE`
- 目录名：`camelCase`（多单词目录名统一小写开头 Pascal 风格）

### 2.2 文件命名（重点）

- **Class 文件：必须 `PascalCase.ts`**
  - 例如：`CoreRuntimeEngine.ts`、`QueryEngine.ts`
- 非 class 文件：`camelCase.ts`
  - 例如：`runtimeEngine.ts`、`queryEngine.ts`

### 2.3 动词语义规范

- `create*`：创建实例
- `compile*`：编译声明结构
- `evaluate*`：纯评估，不落状态
- `collect*`：收集依赖/标识
- `project*`：关系投影
- `prefetch*`：关系预取
- `apply*`：应用到 map/state
- `normalize*`：输入/上下文归一化

### 2.4 禁用命名

- `handle*`、`do*`、`process*`（编排层除外）
- 模糊后缀 `manager`、泛化命名 `util`

---

## 3. 精简后的 RuntimeEngine API

```ts
RuntimeEngine = {
    index: RuntimeIndexEngine
    query: RuntimeQueryEngine
    relation: RuntimeRelationEngine
    mutation: RuntimeMutationEngine
    operation: RuntimeOperationEngine
}
```

### 3.1 `index`

- `create(definitions)`
- `matcherOptions(definitions)`

### 3.2 `query`

- `evaluate({ mapRef, query, indexes, matcher })`
- `cachePolicy(query)`

### 3.3 `relation`

- `compileMap(relationsRaw, storeName)`
- `collectStores(include, relations)`
- `project(items, include, relations, getStoreMap)`
- `prefetch(items, include, relations, resolveStore, options)`

### 3.4 `mutation`

- `init(obj, idGenerator)`
- `merge(base, patch)`
- `addMany(items, data)`
- `removeMany(ids, data)`
- `preserveRef(existing, incoming)`
- `writeback(before, args, options)`

### 3.5 `operation`

- `normalizeContext(ctx, options)`

> 原则：域名保持完整（`relation`/`mutation`），方法名尽量短且不丢语义。

---

## 4. 旧 API -> 新 API 映射

| 旧命名 | 新命名 |
|---|---|
| `createIndexes` | `index.create` |
| `buildQueryMatcherOptions` | `index.matcherOptions` |
| `evaluateWithIndexes` | `query.evaluate` |
| `resolveCachePolicy` | `query.cachePolicy` |
| `compileRelationsMap` | `relation.compileMap` |
| `collectRelationStoreTokens` | `relation.collectStores` |
| `projectRelationsBatch` | `relation.project` |
| `prefetchRelations` | `relation.prefetch` |
| `initBaseObject` | `mutation.init` |
| `mergeForUpdate` | `mutation.merge` |
| `bulkAdd` | `mutation.addMany` |
| `bulkRemove` | `mutation.removeMany` |
| `preserveReferenceShallow` | `mutation.preserveRef` |
| `applyWritebackToMap` | `mutation.writeback` |
| `normalizeOperationContext` | `operation.normalizeContext` |

---

## 5. 文件排布（按职责）

### 5.1 `atoma-types`（契约层）

```txt
packages/atoma-types/src/runtime/
  engine/
    indexEngine.ts
    queryEngine.ts
    relationEngine.ts
    mutationEngine.ts
    operationEngine.ts
    runtimeEngine.ts
  index.ts
```

### 5.2 `atoma-runtime`（实现层）

```txt
packages/atoma-runtime/src/engine/
  core/
    CoreIndexEngine.ts
    CoreQueryEngine.ts
    CoreRelationEngine.ts
    CoreMutationEngine.ts
    CoreOperationEngine.ts
    CoreRuntimeEngine.ts
  index.ts
```

说明：实现层文件是 class 主体，因此统一 PascalCase。

补充：目录命名统一 `camelCase`，单词目录保持小写（如 `core`），多单词目录使用小写开头 Pascal（如 `writeFlow`）。

---

## 6. 职责边界

- Flow 层：只编排（顺序、重试、错误、事件）
- Engine 层：只做领域算法（query/relation/mutation/...）
- State 层：只管 snapshot、订阅、变更传播

禁止：Flow 内直接写关系/索引/写回算法细节。

---

## 7. 标准流程

### 7.1 Read

1. `state.getSnapshot`
2. `query.evaluate`
3. `query.cachePolicy`
4. `io.query`
5. `mutation.writeback`
6. `relation.project` / `relation.prefetch`
7. 返回结果

### 7.2 Write

1. `mutation.init`
2. `mutation.merge`
3. Flow 编排 optimistic/commit
4. `mutation.writeback`
5. `operation.normalizeContext`

---

## 8. 实施步骤

### Phase 1：并存引入

- 新增分区 API 与命名
- `CoreRuntimeEngine` 先保留旧名转发（短期）

### Phase 2：调用迁移

- Runtime/React/Client 全部迁移到新 API

### Phase 3：清理旧名

- 删除旧平铺 API 与兼容层

### Phase 4：收口

- 补文档、补测试、全仓检查

---

## 9. DoD

1. Class 文件全部 PascalCase。
2. Engine API 全部切换为精简命名。
3. Flow 层不再依赖旧平铺 API。
4. 全仓 `typecheck/test` 通过。

