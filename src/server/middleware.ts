import type { HandlerConfig, IOrmAdapter } from './types'
import { AtomaRequestHandler } from './RequestHandler'
import { AtomaTypeormAdapter } from './typeorm'
import type { DataSource } from 'typeorm'

export interface MiddlewareOptions extends Omit<HandlerConfig, 'adapter'> {
    /** 处理的相对路径，默认 '/batch'（配合 app.use('/api', ...)，此处只需 '/batch'） */
    path?: string
}

/**
 * 创建通用中间件（Express/Koa 风格兼容）：
 * - 仅在 POST 且路径匹配时处理
 * - 其它情况透传 next
 */
export function createAtomaMiddleware(adapter: IOrmAdapter, options: MiddlewareOptions = {}) {
    const handler = new AtomaRequestHandler({ adapter, ...options })
    const targetPath = options.path ?? '/batch'

    return async function atomaMiddleware(req: any, res: any, next?: (err?: any) => void) {
        try {
            const method = (req?.method || '').toUpperCase()
            const pathname = (req?.path || req?.url || '').split('?')[0]
            if (method !== 'POST' || pathname !== targetPath) {
                return next ? next() : undefined
            }

            const body = req?.body !== undefined
                ? req.body
                : (req?.readable === false ? undefined : await tryParseJson(req))
            const context = { user: (req as any)?.user, req }
            const result = await handler.handle(body, context)

            const payload = JSON.stringify(result)

            if (res && typeof res.json === 'function') {
                return res.json(result)
            }

            if (res && typeof res.setHeader === 'function') {
                res.setHeader('Content-Type', 'application/json')
            }
            if (res && 'statusCode' in res && typeof res.statusCode === 'number' && res.statusCode === 200) {
                // keep as is
            } else if (res && typeof res.status === 'function') {
                res.status(200)
            }

            if (res && typeof res.send === 'function') {
                return res.send(payload)
            }

            return res?.end?.(payload)
        } catch (err) {
            if (next) return next(err)
            throw err
        }
    }
}

/**
 * 便捷工厂：直接传入 TypeORM DataSource。
 */
export function createTypeormMiddleware(
    dataSource: DataSource,
    options: MiddlewareOptions = {}
) {
    const adapter = new AtomaTypeormAdapter(dataSource, {})
    return createAtomaMiddleware(adapter, options)
}

async function tryParseJson(req: any) {
    if (!req || typeof req.text !== 'function') return undefined
    try {
        const txt = await req.text()
        return txt ? JSON.parse(txt) : undefined
    } catch {
        return undefined
    }
}
