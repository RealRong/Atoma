import lodash from 'lodash'
import type {
    BatchRequest,
    BatchResponse,
    BatchResult,
    HandlerConfig,
    QueryParams,
    QueryResult
} from './types'

const DEFAULT_ACTION = 'query'

export class AtomaRequestHandler {
    constructor(private readonly config: HandlerConfig) {}

    async handle(body: any, context: any = {}): Promise<BatchResponse> {
        const request = this.validateRequest(body)

        if (this.config.maxQueries && request.queries.length > this.config.maxQueries) {
            throw new Error(`Too many queries: max ${this.config.maxQueries}`)
        }

        if (this.config.onRequest) {
            await this.config.onRequest(request, context)
        }

        this.enforceAccess(request)

        if (this.config.adapter.batchFindMany) {
            const results = await this.config.adapter.batchFindMany(
                request.queries.map(q => ({ resource: q.resource, params: q.params }))
            )
            return { results: this.mergeIds(request, results) }
        }

        const settled = await Promise.allSettled(
            request.queries.map(q => this.config.adapter.findMany(q.resource, q.params))
        )

        const results: BatchResult[] = settled.map((res, idx) => {
            const requestId = request.queries[idx].requestId
            if (res.status === 'fulfilled') {
                return { requestId, data: res.value.data, pageInfo: res.value.pageInfo }
            }
            return {
                requestId,
                data: [],
                error: {
                    code: 'QUERY_FAILED',
                    message: res.reason?.message || String(res.reason)
                }
            }
        })

        return { results }
    }

    private mergeIds(request: BatchRequest, results: QueryResult[]): BatchResult[] {
        return results.map((result, idx) => ({
            requestId: request.queries[idx]?.requestId,
            data: result.data,
            pageInfo: result.pageInfo
        }))
    }

    private enforceAccess(request: BatchRequest) {
        for (const q of request.queries) {
            if (this.config.allowList && !this.config.allowList.includes(q.resource)) {
                throw new Error(`Resource access denied: ${q.resource}`)
            }
            if (!this.config.adapter.isResourceAllowed(q.resource)) {
                throw new Error(`Resource not allowed: ${q.resource}`)
            }
            if (this.config.maxLimit && q.params.limit && q.params.limit > this.config.maxLimit) {
                q.params.limit = this.config.maxLimit
            }
        }
    }

    private validateRequest(body: any): BatchRequest {
        if (!body || body.action !== DEFAULT_ACTION || !Array.isArray(body.queries)) {
            throw new Error('Invalid Atoma batch request payload')
        }

        const queries = body.queries.map((q: any) => {
            if (!q || typeof q.resource !== 'string') {
                throw new Error('Invalid query: resource missing')
            }
            const params: QueryParams = lodash.isPlainObject(q.params) ? { ...q.params } : {}
            params.orderBy = this.normalizeOrderBy(params.orderBy)
            return {
                resource: q.resource,
                requestId: q.requestId,
                params
            }
        })

        return { action: DEFAULT_ACTION, queries }
    }

    private normalizeOrderBy(orderBy: QueryParams['orderBy']): QueryParams['orderBy'] {
        if (!orderBy) return undefined
        if (Array.isArray(orderBy)) return orderBy
        return [orderBy]
    }
}
