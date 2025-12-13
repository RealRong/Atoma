import express from 'express'
import { AtomaTypeormAdapter, createHandler } from 'atoma/server'
import { AppDataSource } from './datasource.js'
import { ensureSeedData } from './seed.js'

function allowCors(req: any, res: any, next: () => void) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
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

    const app = express()
    app.use(express.json())
    app.use(allowCors)

    const allowList = ['users', 'posts', 'comments']
    const handler = createHandler({
        adapter: new AtomaTypeormAdapter(AppDataSource),
        guardOptions: { allowList },
        parserOptions: { enableRest: true, batchPath: '/batch' }
    })

    // 统一入口（批量 + REST 映射），基于 Fetch 风格 handler 做薄封装
    app.use('/api', async (req, res, next) => {
        try {
            const url = req.originalUrl?.replace(/^\/api/, '') || '/'
            const incoming = {
                method: req.method,
                url,
                headers: req.headers as Record<string, string>,
                body: req.body,
                json: async () => req.body
            }
            const { status, body } = await handler(incoming)
            if (body === undefined || status === 204) {
                return res.status(status).end()
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
