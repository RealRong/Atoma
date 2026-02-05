# Atoma Store Bindings 重构方案（不做兼容，直接最优架构）

## 背景与问题
当前同一个 store 需要同时服务两类受众：
- 用户：只关心 CRUD（StoreApi）
- 内部包（atoma-react）：需要订阅、快照、索引、关系、匹配器等运行时能力

现状通过 `atoma/internal` + `requireClientRuntime` + `resolveHandle` 绕到 runtime/StoreHandle，导致：
- atoma-react 与 atoma-client/atoma-runtime 内部结构强耦合（含 Jotai 细节）
- store 对外 API 干净，但内部能力依赖隐式“桥接”
- 维护成本高，改动 runtime 很容易联动 react

目标是：不引入 Provider、不扩大公开 API、且把“内部能力”变成稳定契约。

## 目标
- 同一个 store 仍保持纯 CRUD API（对用户干净）
- atoma-react 只依赖稳定的内部契约，不再依赖 runtime/handle 结构
- 无需 Provider
- 无兼容包袱，直接切到最优架构

## 非目标
- 不做向后兼容层
- 不保留 `atoma/internal`/`requireClientRuntime` 旧路径

## 核心思路：Store Bindings 契约
把“内部能力”定义成一个稳定契约，并挂在 store facade 上的 Symbol 属性里：
- 对用户 API 不暴露（非枚举、Symbol key）
- 对内部包是稳定入口
- 避免 atoma-react 直接触碰 runtime / StoreHandle

### 关键点
- 使用 `Symbol.for('atoma.store.bindings')` 作为跨包共享 key
- 在 `atoma-types` 定义类型与读取函数（可标记 @internal）
- runtime 在创建 facade 时挂载 bindings

## API/类型设计（建议）
建议在 `atoma-types` 新增 `internal` 子路径：

```ts
// packages/atoma-types/src/internal/storeBindings.ts
import type * as Types from '../core'
import type { EntityId } from '../protocol'

export const STORE_BINDINGS = Symbol.for('atoma.store.bindings')

export type StoreSource<T extends Types.Entity> = Readonly<{
  getSnapshot: () => ReadonlyMap<EntityId, T>
  subscribe: (listener: () => void) => () => void
}>

export type StoreBindings<T extends Types.Entity = any> = Readonly<{
  name: string
  source: StoreSource<T>
  indexes?: Types.StoreIndexesLike<T> | null
  matcher?: Types.QueryMatcherOptions
  relations?: () => any | undefined
  resolveStore: (name: Types.StoreToken) => Types.IStore<any, any> | undefined
  hydrate?: (items: T[]) => Promise<void>
}>

export function getStoreBindings<T extends Types.Entity>(store: Types.StoreApi<T, any>, tag: string): StoreBindings<T> {
  const bindings = (store as any)?.[STORE_BINDINGS] as StoreBindings<T> | undefined
  if (!bindings) throw new Error(`[Atoma] ${tag}: store 缺少内部绑定（StoreBindings）`)
  return bindings
}
```

说明：
- `resolveStore` 建议语义上是“非创建”解析（返回 undefined）
- 若关系解析必须懒创建，可新增 `ensureStore`，避免语义混淆
- `hydrate` 放在 bindings 内，避免额外入口

## 运行时挂载（atoma-runtime）
在 `StoreFactory.createFacade` 里把 bindings 绑到 facade：
- 使用 `Object.defineProperty` 设置不可枚举
- 由 runtime/handle 直接提供 source/indexes/matcher/relations/hydrate

示意：
```ts
const bindings: StoreBindings<any> = {
  name,
  source: {
    getSnapshot: () => handle.jotaiStore.get(handle.atom),
    subscribe: (listener) => {
      const s: any = handle.jotaiStore
      return typeof s?.sub === 'function' ? s.sub(handle.atom, () => listener()) : () => {}
    }
  },
  indexes: handle.indexes,
  matcher: handle.matcher,
  relations: () => handle.relations?.(),
  resolveStore: (token) => runtime.stores.resolve(token),
  // 如需懒创建，可增加 ensureStore: (token) => runtime.stores.ensure(token)
  hydrate: async (items) => { /* 迁移当前 hydrateStore 逻辑 */ }
}

Object.defineProperty(facade, STORE_BINDINGS, {
  value: bindings,
  enumerable: false,
  configurable: false
})
```

## atoma-react 改造（完全切换）
- 移除 `atoma/internal` 依赖
- 使用 `getStoreBindings(store, tag)` 获取能力

替换点举例：
- `useStoreSnapshot/useStoreSelector` → bindings.source
- `useStoreQuery` → bindings.indexes/matcher
- `useRelations` → bindings.resolveStore + source/indexes
- `useLocalQuery` → bindings.matcher
- `useQuery/useAll/useOne/useMany` → 用 bindings.relations

这样 atoma-react 不需要知道 client/runtime/handle。

## 清理与删改范围
- 移除 `packages/atoma/src/internal/*`
- 移除 `atoma-client` 的 runtimeRegistry（无其它用途）
- 移除 `atoma/internal` 出口
- atoma-react 直接依赖 `atoma-types/internal`

## 影响范围（文件级）
- `packages/atoma-types`：新增 internal 子路径 + StoreBindings 定义
- `packages/atoma-runtime`：StoreFactory 挂载 bindings
- `packages/atoma-react`：hooks 全部改为读取 bindings
- `packages/atoma`：删除 internal exports
- `packages/atoma-client`：删除 runtimeRegistry

## 风险与对策
- 风险：bindings 契约一旦变化会影响 react
  - 对策：把 bindings 当作稳定 ABI，版本化（可选字段、避免破坏性修改）
- 风险：resolveStore 语义不清
  - 对策：显式区分 resolve/ensure，避免误用

## 执行步骤（建议顺序）
1) 在 atoma-types 增加 `internal/storeBindings.ts` 与导出
2) atoma-runtime 在 StoreFactory 挂载 bindings（含 hydrate 逻辑迁移）
3) atoma-react 全部改用 getStoreBindings
4) 删除 `atoma/internal` 与 `runtimeRegistry`
5) 全仓库 typecheck

## 预期收益
- 内部依赖从“runtime 结构”降级为“稳定契约”
- store 对用户仍是纯 CRUD
- 无 Provider，依然保持轻量使用
- 未来 runtime 重构不再影响 react（只要 bindings 不破）
