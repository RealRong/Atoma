## 1. 包关系与入口

- `@atoma-js/atoma` 是推荐入口，导出 `createClient` 与常用类型。
- `@atoma-js/client` 是核心运行时客户端实现（`createClient` 在此实现）。
- `@atoma-js/react` 提供基于 Store 的 React Hooks。
- `@atoma-js/types/*` 提供更细的类型定义。
- 不要从 `@atoma-js/types` 根路径导入，只使用子路径（例如 `@atoma-js/types/client`）。

## 2. 安装

```bash
npm i @atoma-js/atoma
```

如需 React Hooks：

```bash
npm i @atoma-js/react
```

## 3. 快速开始

### 3.1 定义实体与 Schema

```ts
import type { Entity } from '@atoma-js/atoma'
import type { AtomaSchema } from '@atoma-js/atoma'

export type User = Entity & {
    id: string
    name: string
    age: number
}

export type Post = Entity & {
    id: string
    authorId: string
    title: string
}

export type Entities = {
    users: User
    posts: Post
}

export type Schema = AtomaSchema<Entities>

export const schema: Schema = {
    users: {
        indexes: [{ field: 'age', type: 'number' }],
        relations: {
            posts: { type: 'hasMany', to: 'posts', foreignKey: 'authorId' }
        }
    },
    posts: {
        indexes: [{ field: 'authorId', type: 'string' }],
        relations: {
            author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' }
        }
    }
}
```

### 3.2 创建客户端并读写

```ts
import { createClient } from '@atoma-js/atoma'

const client = createClient<Entities, Schema>({
    stores: { schema }
})

const users = client.stores('users')
await users.create({ id: 'u1', name: 'Ada', age: 27 })
const result = await users.query({
    filter: { op: 'gte', field: 'age', value: 18 },
    sort: [{ field: 'age', dir: 'desc' }]
})
```

### 3.3 React Hooks（简短片段）

```tsx
import { useQuery } from '@atoma-js/react'

function UsersView({ store }: { store: ReturnType<typeof client.stores> }) {
    const { data, loading, error } = useQuery(store, {
        filter: { op: 'gte', field: 'age', value: 18 }
    })
    if (loading) return null
    if (error) throw error
    return <pre>{JSON.stringify(data, null, 2)}</pre>
}
```

## 4. @atoma-js/atoma 导出

### 4.1 函数

- `createClient(options)`

### 4.2 类型

- `AtomaClient`
- `AtomaSchema`
- `CreateClientOptions`
- `Entity`
- `Store`
- `Query`
- `RelationIncludeInput`
- `WithRelations`

## 5. createClient

```ts
function createClient<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(options: CreateClientOptions<Entities, Schema>): AtomaClient<Entities, Schema>
```

### 5.1 CreateClientOptions

- `stores?: CreateClientStoresOptions`
- `plugins?: ReadonlyArray<ClientPlugin>`

`CreateClientStoresOptions` 结构：

- `schema?: StoresSchema`
- `createId?: () => EntityId`
- `processor?: StoreProcessor<Entity>`

提示：如果需要关系投影类型推导，建议传入 `AtomaSchema` 并在泛型中显式指定。

### 5.2 AtomaClient

- `stores(name)`：获取指定 Store
- `dispose()`：释放插件资源与运行时

示例：

```ts
const userStore = client.stores('users')
```

## 6. Store API

`Store<T, Relations>` 提供以下方法：

- `create(item, options?)`
- `createMany(items, options?)`
- `update(id, updater, options?)`
- `updateMany(items, options?)`
- `delete(id, options?)`
- `deleteMany(ids, options?)`
- `upsert(item, options?)`
- `upsertMany(items, options?)`
- `get(id, options?)`
- `getMany(ids, options?)`
- `list(options?)`
- `query(query, options?)`
- `queryOne(query, options?)`

### 6.1 StoreOperationOptions

- `force?: boolean`
- `signal?: AbortSignal`
- `context?: Partial<ActionContext>`

### 6.2 UpsertWriteOptions

- `conflict?: 'cas' | 'lww'`
- `apply?: 'merge' | 'replace'`

### 6.3 WriteManyResult

`createMany / updateMany / deleteMany / upsertMany` 返回：

```ts
type WriteManyResult<T> = Array<
    | { index: number; ok: true; value: T }
    | { index: number; ok: false; error: unknown; current?: { value?: unknown } }
>
```

## 7. Query

### 7.1 Query 结构

```ts
type Query<T> = {
    filter?: FilterExpr<T>
    sort?: Array<{ field: keyof T & string | string; dir: 'asc' | 'desc' }>
    page?:
        | { mode: 'offset'; limit?: number; offset?: number; includeTotal?: boolean }
        | { mode: 'cursor'; limit?: number; after?: CursorToken; before?: CursorToken }
}
```

### 7.2 FilterExpr 常用操作

- `and` / `or` / `not`
- `eq` / `in`
- `gt` / `gte` / `lt` / `lte`
- `startsWith` / `endsWith` / `contains`
- `isNull` / `exists`
- `text`（支持 `match`/`fuzzy` 与 `distance`）

### 7.3 示例

```ts
const query: Query<User> = {
    filter: {
        op: 'and',
        args: [
            { op: 'eq', field: 'region', value: 'APAC' },
            { op: 'gte', field: 'age', value: 18 }
        ]
    },
    sort: [{ field: 'age', dir: 'desc' }],
    page: { mode: 'offset', limit: 20, includeTotal: true }
}
```

## 8. Schema 与关系

### 8.1 AtomaSchema

`AtomaSchema` 是面向 Store 的配置集合：

- `indexes`：索引定义
- `relations`：关系定义
- `createId` / `processor`：覆盖 Store 级配置

### 8.2 关系定义

支持：`belongsTo` / `hasMany` / `hasOne`。

```ts
relations: {
    author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' },
    comments: { type: 'hasMany', to: 'comments', foreignKey: 'postId' }
}
```

### 8.3 关系投影

React Hooks 支持 `include`：

```ts
useAll(postsStore, { include: { author: true, comments: true } })
```

## 9. 插件系统（@atoma-js/client）

### 9.1 在 `createClient` 中使用插件

```ts
const client = createClient<Entities, Schema>({
    stores: { schema },
    plugins: [
        /* ClientPlugin[] */
    ]
})
```

### 9.2 ClientPlugin API

```ts
type ClientPlugin = {
    id: string
    provides?: ReadonlyArray<ServiceToken<unknown>>
    requires?: ReadonlyArray<ServiceToken<unknown>>
    setup?: (ctx: PluginContext) => void | { extension?: Record<string, unknown>; dispose?: () => void }
}
```

### 9.3 PluginContext API

`PluginContext` 字段：

- `clientId`
- `services`：`register(token, value, opts?)` 与 `resolve(token)`
- `runtime`：
- `id` / `now`
- `stores.list()` / `stores.use(storeName)` / `stores.peek(storeName, id)` / `stores.snapshot(...)`
- `action.createContext(...)`
- `execution.register(...)` / `execution.hasExecutor(...)`
- `events`：`on` / `off` / `once`（Store 事件）

常见 `StoreEventName`：

- `readStart` / `readFinish`
- `writeStart` / `writeCommitted` / `writeFailed`
- `changeStart` / `changeCommitted` / `changeFailed`
- `storeCreated`

### 9.4 ServiceToken 与服务注册

```ts
import { createServiceToken } from '@atoma-js/types/client'

const TOKEN = createServiceToken<MyService>('my.service')
```

服务注册 API：

- `register(token, value, { override?: boolean })` 返回注销函数
- `resolve(token)` 返回当前值或 `undefined`

注意：

- `provides` 只是声明。实际必须在 `setup` 里调用 `services.register`。
- `setup` 后若发现声明的 `provides` 未注册，会直接抛错。

### 9.5 排序与生命周期

- 会校验插件定义（`id` 非空、`provides/requires` 类型正确）。
- 顺序由 `provides` / `requires` 推导。
- 依赖缺失或存在环会在初始化阶段抛错。
- `setup` 按顺序执行，返回的 `extension` 会合并到 `client`。
- `dispose` 在 `client.dispose()` 时按逆序执行。
- `ctx.events.on/once` 与 `ctx.services.register` 会在销毁时自动清理。

### 9.6 自定义插件示例（提供者 + 使用者）

```ts
import type { ClientPlugin } from '@atoma-js/types/client/plugins'
import { createServiceToken } from '@atoma-js/types/client'

const CLOCK = createServiceToken<{ now: () => number }>('clock')

const clockPlugin: ClientPlugin = {
    id: 'clock',
    provides: [CLOCK],
    setup: (ctx) => {
        ctx.services.register(CLOCK, { now: () => ctx.runtime.now() })
    }
}

const logPlugin: ClientPlugin = {
    id: 'log',
    requires: [CLOCK],
    setup: (ctx) => {
        const clock = ctx.services.resolve(CLOCK)
        if (!clock) return
        const stop = ctx.events.on('writeCommitted', (event) => {
            console.log(clock.now(), event.storeName)
        })
        return { dispose: stop }
    }
}
```

### 9.7 官方插件（快速使用）

HTTP 后端：

```ts
import { backendPlugin } from '@atoma-js/backend-http'

createClient({
    stores: { schema },
    plugins: [backendPlugin({ baseURL: 'https://api.example.com' })]
})
```

Atoma Server 后端 + 同步：

```ts
import { atomaServerBackendPlugin } from '@atoma-js/backend-atoma-server'
import { syncPlugin, type SyncExtension } from '@atoma-js/sync'

const client = createClient<Entities, Schema>({
    stores: { schema },
    plugins: [
        atomaServerBackendPlugin({ baseURL: 'https://api.example.com' }),
        syncPlugin({ resources: ['users', 'posts'], mode: 'full' })
    ]
})

const sync = (client as AtomaClient<Entities, Schema> & SyncExtension).sync
sync.start()
```

History / Observability / Devtools 同样以插件形式提供：

- `historyPlugin()` 来自 `@atoma-js/history`
- `observabilityPlugin()` 来自 `@atoma-js/observability`
- `devtoolsPlugin()` 来自 `@atoma-js/devtools`

## 10. React Hooks（@atoma-js/react）

### 10.1 useOne

```ts
useOne(store, id?, { include? })
```

- 订阅单个实体
- 当本地没有时会触发 `store.get(id)`

### 10.2 useAll

```ts
useAll(store, { include? })
```

- 订阅完整集合（全量快照）

### 10.3 useMany

```ts
useMany(store, ids, { limit?, unique?, include? })
```

- 按 id 列表挑选
- `unique` 默认为 `true`

### 10.4 useQuery

```ts
useQuery(store, query?, { include?, fetchPolicy? })
```

`fetchPolicy`：

- `cache-only`
- `network-only`
- `cache-and-network`（默认）

返回值包含：

- `data`
- `loading` / `isFetching` / `isStale`
- `error`
- `pageInfo`
- `refetch()` / `fetchMore()`

## 11. 最佳实践

- `client` 建议单例化，页面卸载时调用 `dispose()`。
- `client.stores('name')` 是函数形式，不是对象属性。
- Query/Filter 请复用对象或用稳定化手段，减少重复计算。
- 关系投影只在需要时打开，避免不必要的联查成本。
- 复杂读写建议提前建立索引（`indexes`）。

## 12. FAQ

Q: 为什么 `client.stores.users` 不可用？

A: `stores` 是函数，正确写法是 `client.stores('users')`。

Q: `useQuery` 会不会访问远端？

A: `useQuery` 调用 `store.query`，是否触发远端取决于你是否安装了对应插件。
