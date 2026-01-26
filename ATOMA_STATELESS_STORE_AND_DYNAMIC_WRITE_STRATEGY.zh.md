# Atoma 终局设计：无状态 stores API + 动态 writeStrategy（最少概念版）

状态：终局目标（不考虑兼容性；允许破坏性改动，一步到位）。  
范围：`packages/atoma`（core/client）+ `packages/atoma-react`（hooks）。

## 背景与现状（基于当前代码）

当前实现里（已按本文方向推进），“Store 对象”只作为无状态 API 门面；真正的状态只存在于 runtime/handle：

- `runtime.handles: Map<storeKey, handle>`：
  - storeKey = `clientId:storeName`（string）
  - 这是唯一权威的 handle 注册表（不再依赖 store 对象 identity / WeakMap）。
- `client.stores.*`：
  - 返回稳定缓存的无状态 store facade（只包含 CRUD 方法 + name）
  - hooks/devtools 通过 store 上的内部 Symbol 通道拿到 handle/订阅能力（用户不可见）
- `ClientRuntimeStores`：
  - `client.stores` 是唯一用户态入口；按 storeName 缓存 facade（保证 React 依赖稳定）与 engine/handle（惰性创建）
  - 不再因为同名 store 的不同 writeStrategy 抛错；writeStrategy 来自每次写入 options（可动态覆盖）
- mutation pipeline：
  - `packages/atoma/src/core/mutation/pipeline/Scheduler.ts` 会把 `writeStrategy` 纳入 segment key；
  - `packages/atoma/src/core/mutation/pipeline/Persist.ts` 会从一个 segment 内的 operations 推导唯一 `writeStrategy`（混合直接 throw）。

你提出的核心痛点非常准确：
1) 真正有状态/需要持久化的是 `client/runtime` 与 `handle`；  
2) Store 作为“纯 API”理应无状态；  
3) 围绕 store 对象做缓存/映射，会把系统设计拖回“对象 identity 驱动”，很别扭；  
4) `writeStrategy` 本质是写入执行参数，应该可以动态配置，不应绑定在 store identity 上。

## 终局目标

1) **彻底移除 `store -> handle` 的对象映射依赖**：不再需要 store 对象稳定引用。  
2) **Store API 无状态**：store 只是“命名空间/方法集合”，可随用随建，无需缓存。  
3) **内部集成通道**：hooks/devtools 通过内部 Symbol 通道拿到 storeName/handle，并由 runtime 用 `storeKey` 查表。  
4) **writeStrategy 动态化**：作为每次写入的 options 参数（`options.writeStrategy`），而不是 store 级配置。  
5) **生命周期可控**：store facade/handle 都只按 storeName 有界增长；并提供 `client.dispose()` 释放整套 client/runtime（包括插件/后端/devtools）。  

## 用户态 API（唯一入口：`client.stores`）

### 1) stores：属性访问 + 函数调用（懒创建，且类型提示最好）

把“Store 不能承载状态”与“开发体验要好”同时满足的关键做法是：

- 只提供一个入口：`client.stores`；
- `client.stores` 同时支持：
  - 静态：`client.stores.Todo`（最佳 IDE 自动补全）
  - 动态：`client.stores('Todo')`（覆盖所有场景，适合运行时变量）
- 两种形式都返回一个“无状态 store 对象”（薄门面）：只包含方法与一个内部 `storeKey`；每次调用内部通过 `storeKey -> handle` resolve；
- `client.stores` 可以是“懒创建”的：初始只有类型；运行时第一次访问某个 storeName 才生成/缓存对应对象（不保存 handle，因此缓存与否不影响正确性）。

使用方式：

```ts
client.stores.Todo.addOne(...)
client.stores.Post.findMany(...)

const name: keyof Entities & string = pick()
client.stores(name).addOne(...)
```

类型提示（概念）：`client.stores` 是“可调用对象 + 属性映射”的交叉类型：

```ts
type StoresAccessor<Entities> =
  & (<Name extends keyof Entities & string>(name: Name) => IStore<Entities[Name], any>)
  & { [K in keyof Entities & string]: IStore<Entities[K], any> }
```

实现上（概念）：
- `client.stores` 是一个函数（用于 `client.stores(name)`），外面再包一层 `Proxy` 来拦截属性访问（用于 `client.stores.Todo`）；
- 每个属性/调用都 resolve 为同一个“无状态 store 对象”（可按 storeName 做缓存）；
- 状态只存在于 runtime 的 handle 表里（见“内部实现要点”）。

### 2) 动态写入选项：`options.writeStrategy`

把 `writeStrategy` 明确为“本次写入参数”，而不是 store 配置（写 API 的 `options` 入参之一）：

```ts
options?: {
  writeStrategy?: WriteStrategy
  // ... 其他 StoreOperationOptions 字段（confirmation/opContext 等）
}
```

策略解析（单次写入）：
- `options.writeStrategy` 未提供时，默认使用该 store 的 schema 默认策略（若也未配置，则视为 `direct`）。

说明：
- core 仍然只“透传”策略给 `runtime.persistence.persist`，不解释策略语义（保持现有 pipeline 设计优点）。
- 这样同名 store 的不同调用可以自由选择策略，不需要 facade，也不需要 throw。

补充：
- 现有的 `confirmation/timeout/opContext` 等写入选项不属于本设计重点，可原样保留在各写 API 的 options 里。

### 3) 不提供 batch/事务（保持最少概念）

本轮“最少概念版”不引入 `client.batch(...)`；跨多 store 的事务/原子语义应由后端事务或业务编排解决。

### 4) 生命周期：避免 Map 泄漏

关于 “Map<string, handle> 会不会严重泄漏？”：
- 只要 storeName 集合是有限的（绝大多数业务），泄漏风险接近 0。
- 如果 storeName 是动态无限（例如 per-room/per-user 临时 store），建议从产品设计层面避免这种“无限创建 storeName”的用法；否则需要额外的回收机制（引用计数/TTL 等），会显著增加复杂度。

提供最小的释放能力：

```ts
client.dispose() // 释放整个 client/runtime（包括插件/后端/devtools）
```

## 内部实现要点（不暴露给用户）

为了减少概念，用户不需要知道任何“反查/registry”的内部术语；只要记住一句话：
`client.stores.Todo` 是无状态对象，真正的状态只在 runtime 内部的 `Map<storeKey, handle>`。

内部需要的唯一标识符：
- `storeKey = clientId + ':' + storeName`（string）
- storeKey 只在内部使用；用户态 facade 不暴露它。hooks/devtools 通过 facade 上的内部 Symbol 通道拿到 `storeName` 与 `handle`，再由 runtime 推导/查找 storeKey。

内部需要的唯一状态表：
- `handles: Map<storeKey, StoreHandle>`

为了 hooks/devtools/插件的需要，内部只保留一个“集成通道”：
- store facade 上挂一个内部 Symbol（`Symbol.for('atoma.storeInternal')`）
- 通过它拿到 `storeName / getHandle() / resolveStore() / writeback()` 等最小能力（不作为用户态 API）

### 1) 收敛 store handle 的内部工具（去掉“manager”概念）

把原先名为 `storeHandleManager` 的职责收敛为两类纯工具函数：

1) **对象映射/挂载（应删除）**
   - `attachStoreHandle/attachStoreRuntime`
   - `getStoreHandle/requireStoreHandle`（基于 store object）

2) **纯工具（保留）**
   - `createStoreHandle(...)`：构建 handle（atom/jotaiStore/indexes/matcher/nextOpId 等）
   - `resolveObservabilityContext(runtime, handle, options)`：从 runtime 派生 observability context

### 2) 彻底移除 `Core.store.createStore` 用户态入口

当前实现已不再对外暴露 `Core.store.createStore`。
store 的创建/注册统一收敛到 runtime 内部（惰性创建 handle + 注册到 `runtime.handles`）。

### 3) dispatch event 继续携带 writeStrategy（但来源改为 `options.writeStrategy`）

保持现有 pipeline 的强项：
- `StoreDispatchEvent` 继续包含 `writeStrategy?: WriteStrategy`；
- Scheduler 用 `(opContext + writeStrategy)` 分段；
- Persist 从 segment 内推导策略（理论上永不混合）。

区别在于：`writeStrategy` 来源变为写 API 的 `options.writeStrategy`，而非 `config.write.strategy`。

### 4) React hooks 的参数建议

终局建议 hooks 入参只接受一种形态：`client.stores` 返回的无状态 store 对象：

- `useAll(client.stores.Todo, options?)`
- `useAll(client.stores(name), options?)`

说明与约束：
- hooks 内部应当只用 store 的内部 `storeKey` 作为订阅/缓存 key（不要依赖对象 identity）。
- 为了避免 React 每次 render 触发重复订阅：要么 `client.stores.Todo` 本身是稳定引用（对象缓存），要么 hooks 内部不把对象本身放进依赖数组，而是只依赖 `storeKey`。

## 不兼容点（明确说明）

不需要兼容层（因为没有用户），因此可以直接做这些破坏性改动：
- 移除所有 “store 对象 identity 反查” 的公共路径（包括 `storeHandleManager` 对外可见依赖）。
- 对外唯一入口为 `client.stores.Todo` / `client.stores(name)`（store facade 无状态）。
- 反查能力不作为用户态 API 暴露（仅 hooks/devtools/插件内部使用）。

## 分阶段实施方案（建议的提交顺序）

即便不需要兼容层，也建议分阶段做，保证每一步都可测试/可回滚到上一步（注意：这里的“回滚”是指按阶段推进的工程可控性，不是让你去回滚 git 改动）。

### 阶段 1：引入内部 storeKey + handles Map（不改外部 API 或少改）
- runtime 增加 `clientId`
- 引入内部 `storeKey = clientId:storeName`
- 引入内部 `handles: Map<storeKey, handle>`，并用它替代 “store -> handle” 查找

### 阶段 2：引入内部集成通道（Symbol）
- store facade 上挂内部 Symbol 通道（供 hooks/devtools/插件使用）
- React hooks 改为通过 Symbol 通道获取 handle/relations（不再依赖 store identity）

### 阶段 3：CRUD API 无状态化
- 引入 `client.stores`（可调用 + Proxy）的薄 wrapper（无状态）
- 逐步让上层不再依赖“缓存 store 实例”

### 阶段 4：writeStrategy 动态化（`options.writeStrategy`）
- 写操作从 `config.write.strategy` 迁移到 `options.writeStrategy`
- 明确 batch 单策略规则，并在 batch 内禁止覆盖

### 阶段 5：删除 “store 对象 identity 反查”
- 移除 attach/WeakMap registry 等对象映射
- 清理所有依赖 store identity 的逻辑
- 保留必要的纯 helper（createStoreHandle / resolveObservabilityContext / matcher/index 构建）

## 结论（最简答案）

- “store 是无状态纯 API” 要成立，必须把系统的稳定 identity 从 “store 对象引用” 迁移到内部的 `storeKey`（string）。  
- `Map<storeKey, handle>` 是最简单且正确的 registry 形态；只要 storeName 集合有界，并且在不再使用 client 时调用 `client.dispose()`，就不会出现不可控泄漏。  
- `writeStrategy` 应当是每次写入的参数（`options.writeStrategy`），并通过 pipeline 透传给 persistence router；不要绑定在 store/handle identity 上，也就不需要 facade 和“切换策略就 throw”。  
