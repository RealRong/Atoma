# Atoma

Atomic state management with universal persistence — built on Jotai and Immer.

[中文 README](./README.zh.md) · [End-to-end architecture](./ARCHITECTURE_END_TO_END.zh.md) 

## Why Atoma

- **Atomic + type-safe stores** powered by Jotai
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
- `jotai`, `immer`
- Server-side adapters: `typeorm` and/or `@prisma/client` (optional)

## Quick start (client + React)

```ts
import { createClient } from 'atoma'
import { useFindMany } from 'atoma-react'

type User = { id: string; name: string; version?: number }

const client = createClient<{ users: User }>({
    store: {
        type: 'http',
        url: 'http://localhost:3000/api'
    }
})

export function Users() {
    const usersStore = client.stores.users
    const { data, loading, error } = useFindMany(usersStore)
    if (loading) return null
    if (error) throw error
    return <pre>{JSON.stringify(data, null, 2)}</pre>
}
```

## Remote protocol (ops + sync)

- Ops endpoint: `POST /ops`
- Subscribe endpoint (SSE notify): `GET /sync/subscribe` (`event: sync.notify`, payload: `{"resources":["todos"]}`; optional `resources=...`)
- Cursor is advanced only by `changes.pull` (SSE never writes cursor).
- Trace propagation (no headers):
  - ops: `op.meta.traceId` / `op.meta.requestId` (op-scoped; supports mixed-trace batches)
  - subscribe (SSE): URL query `traceId` / `requestId` (for GET/SSE without JSON body)

All of the above are defined by the shared `#protocol` module (`src/protocol/*`), used by both client and server.

## Server (protocol core)

`atoma/server` is a **protocol core**:

- Accepts **Web standard** `Request`/`Response` only
- Exposes two handlers: `ops(request)` and `subscribe(request)` (SSE)
- Does **not** ship Express/Node http adapters (host framework should adapt)
- Does **not** ship authz/policies (security boundaries belong to the host / DB / RLS / adapter / plugins)

### Example (Next.js route handlers)

```ts
import { createAtomaHandlers } from 'atoma/server'
import { createPrismaServerAdapter } from 'atoma/server/adapters/prisma'

const handlers = createAtomaHandlers({
    adapter: createPrismaServerAdapter({ prisma: /* PrismaClient */ } as any)
})

export async function POST(req: Request) {
    return handlers.ops(req)
}
```

For Express/Koa, see the demo adapter pattern in `demo/zero-config/src/server/index.ts`.

## Docs & demos

- Docs site: `docs/`
- Demo app: `demo/`
- Zero-config demo: `demo/zero-config/`

## Contributing

- `npm run typecheck`
- `npm test`
- `npm run dev` (demo)

## License

MIT
