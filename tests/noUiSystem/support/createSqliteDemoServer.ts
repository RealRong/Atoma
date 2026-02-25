import http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { DataSource, EntitySchema } from 'typeorm'
import { createAtomaHandlers } from 'atoma-server'
import { createTypeormServerAdapter } from 'atoma-server/adapters/typeorm'
import {
    HTTP_PATH_OPS,
    HTTP_PATH_SYNC_RXDB_PULL,
    HTTP_PATH_SYNC_RXDB_PUSH,
    HTTP_PATH_SYNC_RXDB_STREAM
} from 'atoma-types/protocol-tools'

export type DemoServerMode = 'in-process' | 'tcp'

export type SqliteDemoServer = Readonly<{
    mode: DemoServerMode
    baseURL: string
    dbPath: string
    request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    close: () => Promise<void>
    dataSource: DataSource
}>

export async function createSqliteDemoServer(options: Readonly<{
    mode?: DemoServerMode
    host?: string
    port?: number
    dirPrefix?: string
}> = {}): Promise<SqliteDemoServer> {
    const mode = options.mode ?? 'in-process'
    const host = options.host ?? '127.0.0.1'
    const port = options.port ?? 0

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), options.dirPrefix ?? 'atoma-demo-sqlite-'))
    const dbPath = path.join(tmpDir, 'atoma-demo.sqlite')

    const dataSource = new DataSource({
        type: 'sqlite',
        database: dbPath,
        entities: [
            USER_ENTITY,
            POST_ENTITY,
            COMMENT_ENTITY,
            CHANGE_ENTITY,
            IDEMPOTENCY_ENTITY
        ],
        synchronize: true,
        logging: false
    })
    await dataSource.initialize()

    const { orm, sync } = createTypeormServerAdapter({ dataSource })
    const handlers = createAtomaHandlers({
        adapter: { orm, sync },
        sync: { enabled: true }
    })

    const dispatch = async (request: Request): Promise<Response> => {
        const pathname = new URL(request.url).pathname
        if (pathname === HTTP_PATH_OPS) return await handlers.ops(request)
        if (pathname === HTTP_PATH_SYNC_RXDB_PULL) return await handlers.syncRxdbPull(request)
        if (pathname === HTTP_PATH_SYNC_RXDB_PUSH) return await handlers.syncRxdbPush(request)
        if (pathname === HTTP_PATH_SYNC_RXDB_STREAM) return await handlers.syncRxdbStream(request)
        return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' }
        })
    }

    if (mode === 'in-process') {
        const baseURL = 'http://atoma-demo.local'

        return {
            mode,
            baseURL,
            dbPath,
            request: async (input, init) => {
                const req = toRequest(input, init, baseURL)
                return await dispatch(req)
            },
            dataSource,
            close: async () => {
                await safeCloseDataSource(dataSource)
                await rm(tmpDir, { recursive: true, force: true })
            }
        }
    }

    const server = http.createServer(async (req, res) => {
        const method = (req.method ?? 'GET').toUpperCase()
        const body = method === 'GET' || method === 'HEAD'
            ? undefined
            : await readBody(req)

        const request = new Request(
            new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`).toString(),
            {
                method,
                headers: toHeaders(req.headers),
                body
            }
        )

        const response = await dispatch(request)
        res.statusCode = response.status
        response.headers.forEach((value, key) => {
            res.setHeader(key, value)
        })
        if (!response.body) {
            res.end()
            return
        }
        Readable.fromWeb(response.body as any).pipe(res)
    })

    await new Promise<void>((resolve, reject) => {
        server.on('error', reject)
        server.listen(port, host, () => resolve())
    })
    const address = server.address() as AddressInfo | null
    if (!address) {
        throw new Error('[DemoTest] failed to resolve server address')
    }
    const baseURL = `http://${address.address}:${address.port}`

    return {
        mode,
        baseURL,
        dbPath,
        request: async (input, init) => {
            const req = toRequest(input, init, baseURL)
            return await fetch(req)
        },
        dataSource,
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await safeCloseDataSource(dataSource)
            await rm(tmpDir, { recursive: true, force: true })
        }
    }
}

async function safeCloseDataSource(dataSource: DataSource): Promise<void> {
    if (!dataSource.isInitialized) return
    try {
        await dataSource.destroy()
    } catch {
        // ignore
    }
}

function toRequest(input: RequestInfo | URL, init: RequestInit | undefined, baseURL: string): Request {
    if (input instanceof Request) {
        return input
    }

    const url = input instanceof URL
        ? new URL(input.toString(), baseURL).toString()
        : new URL(String(input), baseURL).toString()

    return new Request(url, init)
}

function toHeaders(input: http.IncomingHttpHeaders): Headers {
    const headers = new Headers()
    for (const [key, value] of Object.entries(input)) {
        if (Array.isArray(value)) {
            headers.set(key, value.join(','))
        } else if (typeof value === 'string') {
            headers.set(key, value)
        }
    }
    return headers
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = []
    return await new Promise((resolve, reject) => {
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        req.on('error', reject)
        req.on('end', () => {
            resolve(chunks.length ? Buffer.concat(chunks) : undefined)
        })
    })
}

const USER_ENTITY = new EntitySchema({
    name: 'UserEntity',
    tableName: 'users',
    columns: {
        id: { type: String, primary: true },
        name: { type: String },
        age: { type: Number },
        region: { type: String },
        version: { type: Number, default: 1 }
    }
})

const POST_ENTITY = new EntitySchema({
    name: 'PostEntity',
    tableName: 'posts',
    columns: {
        id: { type: String, primary: true },
        title: { type: String },
        authorId: { type: String },
        version: { type: Number, default: 1 }
    }
})

const COMMENT_ENTITY = new EntitySchema({
    name: 'CommentEntity',
    tableName: 'comments',
    columns: {
        id: { type: String, primary: true },
        postId: { type: String },
        content: { type: String },
        version: { type: Number, default: 1 }
    }
})

const CHANGE_ENTITY = new EntitySchema({
    name: 'AtomaChangeEntity',
    tableName: 'atoma_changes',
    columns: {
        cursor: { type: Number, primary: true, generated: 'increment' },
        resource: { type: String },
        id: { type: String },
        kind: { type: String },
        serverVersion: { type: Number },
        changedAt: { type: Number }
    }
})

const IDEMPOTENCY_ENTITY = new EntitySchema({
    name: 'AtomaIdempotencyEntity',
    tableName: 'atoma_idempotency',
    columns: {
        idempotencyKey: { type: String, primary: true },
        status: { type: Number },
        bodyJson: { type: String },
        createdAt: { type: Number },
        expiresAt: { type: Number }
    }
})
