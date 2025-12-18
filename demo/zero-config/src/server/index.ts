import express from 'express'
import { createAtomaServer } from 'atoma/server'
import { createTypeormServerAdapter } from 'atoma/server/typeorm'
import { AppDataSource } from './datasource.js'
import { ensureSeedData } from './seed.js'

function allowCors(req: any, res: any, next: () => void) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-atoma-trace-id,x-atoma-request-id')
    if (req.method === 'OPTIONS') {
        res.statusCode = 204
        return res.end()
    }
    next()
}

export async function startServer(port = 3000) {
    if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize()
    }
    await ensureSeedData()

    // sync 内部表（SQLite demo 直接用 IF NOT EXISTS，生产环境建议迁移）
    await AppDataSource.query(`
        CREATE TABLE IF NOT EXISTS atoma_changes (
            cursor INTEGER PRIMARY KEY AUTOINCREMENT,
            resource TEXT NOT NULL,
            id TEXT NOT NULL,
            kind TEXT NOT NULL,
            serverVersion INTEGER NOT NULL,
            changedAt INTEGER NOT NULL
        )
    `)
    await AppDataSource.query(`
        CREATE TABLE IF NOT EXISTS atoma_idempotency (
            idempotencyKey TEXT PRIMARY KEY,
            status INTEGER NOT NULL,
            bodyJson TEXT,
            createdAt INTEGER NOT NULL,
            expiresAt INTEGER NOT NULL
        )
    `)

    const app = express()
    app.use(express.json())
    app.use(allowCors)

    const allowList = ['users', 'posts', 'comments']
    const adapter = createTypeormServerAdapter({ dataSource: AppDataSource })
    const handler = createAtomaServer({
        adapter,
        routing: { rest: { enabled: true }, batch: { path: '/batch' } },
        authz: { resources: { allow: allowList } }
    })

    // 统一入口（批量 + REST 映射），基于 Fetch 风格 handler 做薄封装
    app.use('/api', async (req, res, next) => {
        try {
            const url = req.originalUrl?.replace(/^\/api/, '') || '/'
            const controller = new AbortController()
            req.on('close', () => controller.abort())
            const incoming = {
                method: req.method,
                url,
                headers: req.headers as Record<string, string>,
                body: req.body,
                json: async () => req.body,
                signal: controller.signal
            }
            const { status, body, headers } = await handler(incoming)
            if (headers && typeof headers === 'object') {
                Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v))
            }

            if (body === undefined || status === 204) {
                return res.status(status).end()
            }

            // SSE / streaming
            if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
                res.status(status)
                // @ts-ignore
                for await (const chunk of body as AsyncIterable<string>) {
                    res.write(chunk)
                }
                return res.end()
            }

            return res.status(status).json(body)
        } catch (err) {
            return next(err)
        }
    })

    app.get('/health', (_req, res) => res.json({ ok: true }))

    return new Promise<express.Express>(resolve => {
        app.listen(port, () => {
            console.log(`[atoma demo] backend ready at http://localhost:${port}`)
            resolve(app)
        })
    })
}

if (import.meta.url === `file://${process.argv[1]}`) {
    startServer()
}
