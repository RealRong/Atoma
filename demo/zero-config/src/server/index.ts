import express from 'express'
import * as atomaServer from 'atoma/server'
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

    const createTypeormMiddleware =
        (atomaServer as any).createTypeormMiddleware
        ?? (atomaServer as any).atoma?.typeorm
        ?? (atomaServer as any).default?.createTypeormMiddleware

    if (!createTypeormMiddleware) {
        throw new Error('atoma/server 未导出 createTypeormMiddleware，请检查依赖安装与构建')
    }

    app.use('/api', createTypeormMiddleware(AppDataSource, {
        allowList: ['users', 'posts', 'comments']
    }))

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
