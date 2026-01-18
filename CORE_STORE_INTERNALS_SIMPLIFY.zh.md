# src/core/store/internals 简化分析与兼容项清单

## 实施前现状分组（按职责归类）
### 1) Handle / Runtime / 访问层
- `handleTypes.ts`：StoreHandle 结构定义（内部运行态载体）
- `runtime.ts`：createStoreHandle + resolveObservabilityContext + buildQueryMatcherOptions
- `handleRegistry.ts`：globalThis + Symbol.for 的 handle/runtime 注册与读取
- `storeAccess.ts`：对外部模块的适配器（通过 handle 读 snapshot/subscribe/indexes/relations）

### 2) Atom Map 与缓存写入
- `atomMapOps.ts`：Map 层的增删改工具
- `cacheWriter.ts`：提交 atom 更新并同步 indexes
- `preserveReference.ts`：浅层引用保留
- `writeback.ts`：服务端回写/冲突回写（依赖 cacheWriter + validation）

### 3) 写入管线辅助
- `writePipeline.ts`：prepareForAdd / prepareForUpdate（hooks + transform + schema）
- `hooks.ts`：beforeSave/afterSave 钩子
- `validation.ts`：schema 校验兼容（zod/yup/函数）
- `ensureActionId.ts`：补全 actionId
- `tickets.ts`：避免未 await ticket 的未处理 rejection
- `writeConfig.ts`：persistMode/allowImplicitFetchForWrite 类型

### 4) Query / 协议适配
- `queryParams.ts`：FindManyOptions -> QueryParams 的协议映射
- `opsExecutor.ts`：对 `src/core/ops/opsExecutor.ts` 的 re-export

### 5) 其他通用工具
- `dispatch.ts`：写入事件分发到 MutationPipeline
- `idGenerator.ts`：默认雪花 ID 生成器
- `errors.ts`：对 `#shared` 的 re-export

---

## 兼容/桥接型文件（“为旧路径/边界适配而存在”）
这些文件不是核心算法，而是“桥接/兼容/边界适配”用途，最容易造成结构混乱：

1) `storeAccess.ts`
   - 作用：给 React hooks / devtools 提供“只读/受控访问”
   - 性质：**桥接层**（不是核心存储逻辑）

2) `handleRegistry.ts`
   - 作用：通过 globalThis + Symbol.for 连接 store <-> handle/runtime
   - 性质：**兼容层**（跨 bundle / 老路径的桥接）

3) `opsExecutor.ts`
   - 作用：仅 re-export
   - 性质：**兼容层**（保留旧 import 路径）

4) `errors.ts`
   - 作用：仅 re-export
   - 性质：**兼容层**（旧路径或局部便捷）

5) `queryParams.ts`
   - 作用：把上层查询参数映射到协议字段
   - 性质：**边界适配**（业务->协议）

> 结论：这些文件更像“边界/兼容层”，不应与核心 atom/mutation 逻辑混放。

---

## 为什么目前看起来“乱”
- 同一目录同时承载 **核心逻辑** 与 **桥接/兼容层**，语义混杂
- 过多的 **re-export 小文件**（`opsExecutor.ts`/`errors.ts`）降低可读性
- handle/runtime/access/registry 被拆散在多个文件中，阅读路径长

---

## 可整合与简化建议（不改代码，仅结构建议）
### 方案 A：按“职责域”重排目录（推荐）
```
internals/
  handle/                # handle + registry + access
    types.ts
    registry.ts
    access.ts
  runtime/               # createStoreHandle + observability + matcher
    storeRuntime.ts
  atom/                  # atom map & cache writer
    mapOps.ts
    cacheWriter.ts
    preserveReference.ts
    writeback.ts
  write/                 # 写入管线工具
    pipeline.ts
    hooks.ts
    validation.ts
    tickets.ts
    ensureActionId.ts
    writeConfig.ts
  protocol/              # 协议/边界适配
    queryParams.ts
    opsExecutor.ts
  utils/
    idGenerator.ts
    errors.ts
    dispatch.ts
```

### 方案 B：减少文件数量（合并小文件）
- 合并 `errors.ts` + `opsExecutor.ts` 到调用方（移除 re-export）
- 合并 `writeConfig.ts` + `tickets.ts` + `ensureActionId.ts` 到 `writePipeline.ts`
- 合并 `atomMapOps.ts` + `cacheWriter.ts` 为 `atomMap.ts`

> 目标：减少“纯转发/微小工具”文件，让目录表达“核心逻辑分区”。

---

## 推荐的“兼容层搬迁”顺序（如果要动手）
1) 先把 `storeAccess.ts` / `handleRegistry.ts` 挪到 `internals/handle/`（或 `internals/bridge/`）
2) 再移除 `opsExecutor.ts` / `errors.ts` 这类 re-export
3) 最后合并细碎工具文件（不影响行为的重排）

---

## 结论
当前 `internals/` 的“乱”主要来自 **核心逻辑与兼容/桥接层混放**。
先把兼容/桥接层从内部算法层分离，再决定是否合并小文件，理解成本会明显下降。

---

## 已实施（方案 B）
当前目录已收敛为以下文件（已去除 re-export 小文件）：
- `atomMap.ts`（原 `atomMapOps.ts` + `cacheWriter.ts`）
- `writePipeline.ts`（合并 `writeConfig.ts` + `tickets.ts` + `ensureActionId.ts`）
- `dispatch.ts` / `handleRegistry.ts` / `handleTypes.ts` / `hooks.ts`
- `idGenerator.ts` / `preserveReference.ts` / `queryParams.ts` / `runtime.ts`
- `storeAccess.ts` / `validation.ts` / `writeback.ts`

说明：`opsExecutor.ts` 与 `errors.ts` 已移除，调用方改为直接引用 `src/core/ops/opsExecutor.ts` 与 `#shared`。
