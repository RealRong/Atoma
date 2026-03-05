## 1. Packages and Entry Points

- `@atoma-js/atoma` is the recommended entry. It exports `createClient` and common types.
- `@atoma-js/client` contains the core client implementation.
- `@atoma-js/react` provides Store-based React hooks.
- `@atoma-js/types/*` exposes fine-grained type definitions.
- Do not import from `@atoma-js/types` root. Use subpaths only (for example `@atoma-js/types/client`).

## 2. Installation

```bash
npm i @atoma-js/atoma
```

For React hooks:

```bash
npm i @atoma-js/react
```

## 3. Quick Start

### 3.1 Define entities and schema

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

### 3.2 Create client and write/read

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

### 3.3 React hooks (short snippet)

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

## 4. @atoma-js/atoma Exports

### 4.1 Functions

- `createClient(options)`

### 4.2 Types

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

`CreateClientStoresOptions` shape:

- `schema?: StoresSchema`
- `createId?: () => EntityId`
- `processor?: StoreProcessor<Entity>`

Tip: If you want strong relation projection typing, pass an explicit `AtomaSchema` and bind generics on `createClient`.

### 5.2 AtomaClient

- `stores(name)` returns a Store instance
- `dispose()` tears down plugins and runtime resources

Example:

```ts
const userStore = client.stores('users')
```

## 6. Store API

`Store<T, Relations>` exposes:

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

`createMany / updateMany / deleteMany / upsertMany` return:

```ts
type WriteManyResult<T> = Array<
    | { index: number; ok: true; value: T }
    | { index: number; ok: false; error: unknown; current?: { value?: unknown } }
>
```

## 7. Query

### 7.1 Query shape

```ts
type Query<T> = {
    filter?: FilterExpr<T>
    sort?: Array<{ field: keyof T & string | string; dir: 'asc' | 'desc' }>
    page?:
        | { mode: 'offset'; limit?: number; offset?: number; includeTotal?: boolean }
        | { mode: 'cursor'; limit?: number; after?: CursorToken; before?: CursorToken }
}
```

### 7.2 Common FilterExpr ops

- `and` / `or` / `not`
- `eq` / `in`
- `gt` / `gte` / `lt` / `lte`
- `startsWith` / `endsWith` / `contains`
- `isNull` / `exists`
- `text` (supports `match`/`fuzzy` and `distance`)

### 7.3 Example

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

## 8. Schema and Relations

### 8.1 AtomaSchema

`AtomaSchema` is a per-store configuration map:

- `indexes`
- `relations`
- `createId` / `processor`

### 8.2 Relation definitions

Supported: `belongsTo` / `hasMany` / `hasOne`.

```ts
relations: {
    author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' },
    comments: { type: 'hasMany', to: 'comments', foreignKey: 'postId' }
}
```

### 8.3 Relation projection

React hooks accept `include`:

```ts
useAll(postsStore, { include: { author: true, comments: true } })
```

## 9. Plugins (@atoma-js/client)

### 9.1 ClientPlugin

```ts
type ClientPlugin = {
    id: string
    provides?: ReadonlyArray<ServiceToken<unknown>>
    requires?: ReadonlyArray<ServiceToken<unknown>>
    setup?: (ctx: PluginContext) => void | { extension?: Record<string, unknown>; dispose?: () => void }
}
```

### 9.2 ServiceToken

```ts
import { createServiceToken } from '@atoma-js/types/client'
const TOKEN = createServiceToken<MyService>('my.service')
```

### 9.3 Minimal plugin example

```ts
const myPlugin: ClientPlugin = {
    id: 'my-plugin',
    setup: () => {
        return {
            extension: {
                hello: () => 'world'
            },
            dispose: () => {
                // cleanup
            }
        }
    }
}
```

`extension` is merged into `client`, and `dispose()` runs when `client.dispose()` is called.

## 10. React Hooks (@atoma-js/react)

### 10.1 useOne

```ts
useOne(store, id?, { include? })
```

- Subscribes to a single entity
- Triggers `store.get(id)` if the item is missing locally

### 10.2 useAll

```ts
useAll(store, { include? })
```

- Subscribes to the full collection

### 10.3 useMany

```ts
useMany(store, ids, { limit?, unique?, include? })
```

- Picks by id list
- `unique` defaults to `true`

### 10.4 useQuery

```ts
useQuery(store, query?, { include?, fetchPolicy? })
```

`fetchPolicy`:

- `cache-only`
- `network-only`
- `cache-and-network` (default)

Return fields:

- `data`
- `loading` / `isFetching` / `isStale`
- `error`
- `pageInfo`
- `refetch()` / `fetchMore()`

## 11. Best Practices

- Keep a singleton `client` and call `dispose()` when appropriate.
- `client.stores('name')` is a function, not an object property.
- Reuse stable query objects to reduce re-computation.
- Enable relation projection only when needed.
- Add indexes for frequent filters and sorts.

## 12. FAQ

Q: Why doesn’t `client.stores.users` work?

A: `stores` is a function. Use `client.stores('users')`.

Q: Does `useQuery` always hit the network?

A: `useQuery` calls `store.query`. Whether it triggers remote IO depends on installed plugins.

