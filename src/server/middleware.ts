import type { HandlerConfig, IOrmAdapter } from './types'
import { AtomaRequestHandler } from './RequestHandler'
import { AtomaTypeormAdapter } from './typeorm'
import { AtomaPrismaAdapter } from './prisma'
import type { PrismaAdapterOptions } from './prisma/PrismaAdapter'
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

            const body = req?.body !== undefined
                ? req.body
                : (req?.readable === false ? undefined : await tryParseJson(req))
            const context = { user: (req as any)?.user, req }

            // 1) 批量入口：POST /batch
            if (method === 'POST' && pathname === targetPath) {
                const result = await handler.handle(body, context)
                return sendJson(res, result, 200)
            }

            // 2) 单条 REST 入口：/resource 或 /resource/:id
            const pathParts = pathname.replace(/^\/+/, '').split('/')
            const resource = pathParts[0]
            const id = pathParts[1]

            if (!resource) {
                return next ? next() : undefined
            }

            const toNumberIfInt = (v: any) => {
                const n = Number(v)
                return Number.isFinite(n) ? n : v
            }

            // Map REST -> BatchRequest
            if (method === 'GET') {
                const queries = [{
                    resource,
                    params: id ? { where: { id: toNumberIfInt(id) }, limit: 1 } : { ...(req.query || {}) }
                }]
                const result = await handler.handle({ action: 'query', queries }, context)
                const first = result.results?.[0]
                if (id) {
                    const item = first?.data?.[0]
                    return item
                        ? sendJson(res, item, 200)
                        : sendJson(res, { message: 'Not found' }, 404)
                }
                return sendJson(res, first ?? result, 200)
            }

            if (method === 'POST' && !id) {
                const result = await handler.handle({ action: 'create', resource, payload: body }, context)
                const item = result.results?.[0]?.data?.[0]
                return sendJson(res, item ?? result, 201)
            }

            if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && id) {
                const payload = typeof body === 'object' && body ? { ...body, id: toNumberIfInt(id) } : body
                const action = Array.isArray((payload as any)?.patches) ? 'patch' : 'update'
                const result = await handler.handle({
                    action,
                    resource,
                    payload,
                    where: { id: toNumberIfInt(id) }
                }, context)
                const item = result.results?.[0]?.data?.[0]
                return item
                    ? sendJson(res, item, 200)
                    : sendJson(res, { message: 'Not found' }, 404)
            }

            if (method === 'DELETE' && id) {
                await handler.handle({ action: 'delete', resource, where: { id: toNumberIfInt(id) } }, context)
                return sendJson(res, null, 204)
            }

            return next ? next() : undefined
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

/**
 * 便捷工厂：直接传入 Prisma Client。
 */
export function createPrismaMiddleware(
    client: any,
    options: MiddlewareOptions = {},
    adapterOptions: PrismaAdapterOptions = {}
) {
    const adapter = new AtomaPrismaAdapter(client, adapterOptions)
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

function sendJson(res: any, payload: any, status = 200) {
    if (res && typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json')
    }
    if (res && typeof res.status === 'function') {
        res.status(status)
    } else if ('statusCode' in res) {
        res.statusCode = status
    }
    if (status === 204) return res?.end?.()
    if (res && typeof res.json === 'function') return res.json(payload)
    if (res && typeof res.send === 'function') return res.send(JSON.stringify(payload))
    return res?.end?.(JSON.stringify(payload))
}
