# Atoma

Atomic state management with universal persistence.

[中文 README](./README.zh.md) · [Layered architecture redesign](./ARCHITECTURE_LAYERED_REDESIGN.zh.md) 

## Why Atoma

- **Atomic + type-safe stores** with pluggable runtime
- **Unified persistence** via pluggable data sources (HTTP, IndexedDB, memory, hybrid)
- **Ops protocol** (`/ops`) for reads/writes, designed for batching and sync
- **Offline-first sync** (outbox + pull/subscribe SSE)
- **Relations** (belongsTo/hasMany/hasOne/variants) with client-side prefetch + projection
- **Observability** (trace/debug events) across store → network → server

## Installation

```bash
npm i atoma
```

Peer deps:
- `immer`
- Server-side adapters: `typeorm` and/or `@prisma/client` (optional)

## Quick start (client + React)

```ts
import { createClient } from 'atoma-client'
import { useFindMany } from 'atoma-react'
import { httpBackendPlugin } from 'atoma-backend-http'

type User = { id: string; name: string; version?: number }

const client = createClient<{ users: User }>({
    plugins: [
        httpBackendPlugin({ baseURL: 'http://localhost:3000/api' })
    ]
})

export function Users() {
    const usersStore = client.stores.users
    const { data, loading, error } = useFindMany(usersStore)
    if (loading) return null
    if (error) throw error
    return <pre>{JSON.stringify(data, null, 2)}</pre>
}
```

## Client config (new)

- `plugins: ClientPlugin[]` is the primary extension surface (io/persist/read/observe handler chains).
- Plugins are assembled **at initialization**; `client.use` is intentionally removed.

### Atoma Server plugin setup

```ts
import { createClient } from 'atoma-client'
import { atomaServerBackendPlugin } from 'atoma-backend-atoma-server'

const client = createClient({
    schema,
    plugins: [
        atomaServerBackendPlugin({
            baseURL: 'http://localhost:3000/api',
            operationsPath: '/ops'
        })
    ]
})
```

## Remote protocol (ops + sync)

- Ops endpoint: `POST /ops`
- Subscribe endpoint (SSE notify): `GET /sync/subscribe` (`event: sync.notify`, payload: `{"resources":["todos"]}`; optional `resources=...`)
- Cursor is advanced only by `changes.pull` (SSE never writes cursor).
- Trace propagation (no headers):
  - ops: `op.meta.traceId` / `op.meta.requestId` (op-scoped; supports mixed-trace batches)
  - subscribe (SSE): URL query `traceId` / `requestId` (for GET/SSE without JSON body)

All of the above are defined by shared `atoma-types/protocol` types and `atoma-types/protocol-tools` utilities, used by both client and server.

## Server (protocol core)

`atoma-server` is a **protocol core**:

- Accepts **Web standard** `Request`/`Response` only
- Exposes two handlers: `ops(request)` and `subscribe(request)` (SSE)
- Does **not** ship Express/Node http adapters (host framework should adapt)
- Does **not** ship authz/policies (security boundaries belong to the host / DB / RLS / adapter / plugins)

### Example (Next.js route handlers)

```ts
import { createAtomaHandlers } from 'atoma-server'
import { createPrismaServerAdapter } from 'atoma-server/adapters/prisma'

const handlers = createAtomaHandlers({
    adapter: createPrismaServerAdapter({ prisma: /* PrismaClient */ } as any)
})

export async function POST(req: Request) {
    return handlers.ops(req)
}
```

For Express/Koa, see the demo adapter pattern in `demo/zero-config/src/server/index.ts`.

## Docs

- Architecture: `ARCHITECTURE_LAYERED_REDESIGN.zh.md`

## Contributing

- `npm run typecheck`
- `npm test`
- `npm run dev` (demo)

## License

MIT
