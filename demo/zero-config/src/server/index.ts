import express from 'express'
import { createAtomaHandlers } from 'atoma/server'
import { createTypeormServerAdapter } from 'atoma/server/adapters/typeorm'
import { Readable } from 'node:stream'
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

function toWebRequest(req: any, baseUrl: string) {
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const url = new URL(req.originalUrl || req.url || '/', baseUrl).toString()
    return toWebRequestWithUrl(req, url, controller.signal)
}

function toWebRequestWithUrl(req: any, url: string, signal: AbortSignal) {
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers ?? {})) {
        if (v === undefined) continue
        if (Array.isArray(v)) {
            for (const item of v) {
                if (typeof item === 'string') headers.append(k, item)
            }
            continue
        }
        if (typeof v === 'string') headers.set(k, v)
    }

    const method = String(req.method || 'GET').toUpperCase()

    const init: RequestInit = {
        method,
        headers,
        signal
    }

    if (method !== 'GET' && method !== 'HEAD') {
        if (req.body !== undefined) {
            const bodyText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
            init.body = bodyText
            if (!headers.has('content-type')) {
                headers.set('content-type', 'application/json; charset=utf-8')
            }
        }
    }

    return new Request(url, init)
}

function sendWebResponse(res: any, response: Response) {
    res.statusCode = response.status
    response.headers.forEach((value, key) => {
        res.setHeader(key, value)
    })

    if (!response.body) {
        return response.text()
            .then(text => {
                if (text) res.write(text)
                res.end()
            })
            .catch(() => {
                res.end()
            })
    }

    const nodeStream = Readable.fromWeb(response.body as any)
    nodeStream.on('error', () => {
        try {
            res.end()
        } catch {}
    })
    nodeStream.pipe(res)
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

    const adapter = createTypeormServerAdapter({ dataSource: AppDataSource })
    // authz / resources control 由宿主框架自己做；atoma/server 只做协议解析 + adapter 调用
    const handlers = createAtomaHandlers({
        adapter,
        sync: { enabled: true }
    })

    // Web Request/Response：demo 在宿主侧做适配（atoma/server 本身不做 Express 适配）
    const baseUrlFromReq = (req: any) => `${req.protocol ?? 'http'}://${req.get?.('host') ?? 'localhost'}`

    app.post('/api/ops', async (req, res, next) => {
        try {
            const baseUrl = baseUrlFromReq(req)
            const request = toWebRequest(req, baseUrl)

            const response = await handlers.ops(request)
            return await sendWebResponse(res, response)
        } catch (err) {
            return next(err)
        }
    })

    // 兼容 demo 旧的 /api/batch（映射到同一个 ops handler）
    app.post('/api/batch', async (req, res, next) => {
        try {
            const baseUrl = baseUrlFromReq(req)
            const controller = new AbortController()
            req.on('close', () => controller.abort())
            const url = new URL('/api/ops', baseUrl).toString()
            const request = toWebRequestWithUrl(req, url, controller.signal)
            const response = await handlers.ops(request)
            return await sendWebResponse(res, response)
        } catch (err) {
            return next(err)
        }
    })

    app.get('/api/subscribe', async (req, res, next) => {
        try {
            const baseUrl = baseUrlFromReq(req)
            const request = toWebRequest(req, baseUrl)
            const response = await handlers.subscribe(request)
            return await sendWebResponse(res, response)
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
