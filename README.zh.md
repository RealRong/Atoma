# Atoma

基于 Jotai + Immer 的原子化状态管理与通用持久化方案。

[English README](./README.md) · [端到端架构](./ARCHITECTURE_END_TO_END.zh.md) 

## 解决什么问题

- **原子化 + 类型安全的 Store**（Jotai 驱动）
- **统一的持久化抽象**：HTTP / IndexedDB / memory / hybrid 等 datasource
- **统一的 ops 协议**（`/ops`）：读写都走同一套请求/响应结构，天然适配 batch/sync
- **Offline-first 同步**：outbox + pull + subscribe（SSE）
- **Relations**：belongsTo/hasMany/hasOne/variants，客户端 prefetch + 投影（include）
- **Observability**：从 store → 网络 → server 的 trace/debug/telemetry 链路一致

## 安装

```bash
npm i atoma
```

Peer 依赖：
- `react`, `jotai`, `immer`
- 服务端 adapter：`typeorm` / `@prisma/client`（按需）

## 快速开始（client + React）

```ts
import { createClient } from 'atoma'
import { useFindMany } from 'atoma/react'

type User = { id: string; name: string; version?: number }

const client = createClient<{ users: User }>({
    store: {
        type: 'http',
        url: 'http://localhost:3000/api'
    }
})

export function Users() {
    const usersStore = client.Store('users')
    const { data, loading, error } = useFindMany(usersStore)
    if (loading) return null
    if (error) throw error
    return <pre>{JSON.stringify(data, null, 2)}</pre>
}
```

## 协议（ops + sync）

- Ops：`POST /ops`
- Subscribe（SSE 通知）：`GET /sync/subscribe`（`event: sync.notify`，payload: `{"resources":["todos"]}`；可选 `resources=...`）
- cursor 只由 `changes.pull` 推进（SSE 不写 cursor）
- Trace 传递（禁止 header）：
  - ops：`op.meta.traceId` / `op.meta.requestId`（op-scoped，支持 batch mixed trace）
  - subscribe（SSE）：URL query `traceId` / `requestId`（用于无 body 的 GET/SSE）

以上都由 `#protocol`（`src/protocol/*`）统一定义，client 与 server 共享同一份 parse/compose/type。

## Server

`atoma/server` 的定位是**协议内核**：

- **只认 Web 标准 `Request`/`Response`**
- 默认只暴露两个 handler：`ops(request)` / `subscribe(request)`（SSE）
- **不提供** Express/Node http 等宿主适配（宿主自行适配）
- **不内置** authz/policies（安全边界由宿主/DB/RLS/adapter/插件承担）

### 示例（Next.js route handlers）

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

Express/Koa 的“宿主侧适配”参考：`demo/zero-config/src/server/index.ts`。

## 文档与示例

- 文档站：`docs/`
- Demo：`demo/`
- Zero-config demo：`demo/zero-config/`

## 开发与测试

- `npm run typecheck`
- `npm test`
- `npm run dev`（启动 demo）

## License

MIT
