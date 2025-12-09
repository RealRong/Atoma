import { createAtomaMiddleware, createTypeormMiddleware } from './middleware'

export { AtomaRequestHandler } from './RequestHandler'
export { createAtomaMiddleware, createTypeormMiddleware } from './middleware'
export type {
    BatchQuery,
    BatchRequest,
    BatchResponse,
    BatchResult,
    HandlerConfig,
    IOrmAdapter,
    OrderByField,
    QueryParams,
    QueryResult
} from './types'

export const atoma = {
    /** 直接传 DataSource，返回 Express/Koa 兼容中间件 */
    typeorm: createTypeormMiddleware,
    /** 传入自定义适配器，返回 Express/Koa 兼容中间件 */
    express: createAtomaMiddleware
}
