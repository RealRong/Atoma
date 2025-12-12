import lodash from 'lodash'
import type {
    Action,
    BatchRequest,
    BatchResponse,
    BatchResult,
    HandlerConfig,
    QueryParams,
    QueryResult,
    QueryResultMany,
    QueryResultOne
} from './types'

export class AtomaRequestHandler {
    constructor(private readonly config: HandlerConfig) {}

    async handle(body: any, context: any = {}): Promise<BatchResponse> {
        const request = this.validateRequest(body)

        try {
            if (this.config.onRequest) {
                await this.config.onRequest(request, context)
            }
            if (this.config.onAuthorize) {
                await this.config.onAuthorize(request, context)
            }

            this.enforceAccess(request)
            this.enforceLimits(request)

            const response = request.action === 'query'
                ? await this.handleQuery(request)
                : await this.handleWrite(request)

            if (this.config.onSuccess) {
                await this.config.onSuccess(response, request, context)
            }
            return response
        } catch (err) {
            if (this.config.onError) {
                await this.config.onError(err, request, context)
            }
            throw err
        }
    }

    private async handleQuery(request: BatchRequest): Promise<BatchResponse> {
        if (!request.queries) {
            throw new Error('Invalid query payload')
        }

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
            const requestId = request.queries?.[idx]?.requestId
            if (res.status === 'fulfilled') {
                return { requestId, data: res.value.data, pageInfo: res.value.pageInfo }
            }
            return this.toErrorResult(requestId, res.reason, 'QUERY_FAILED')
        })

        return { results }
    }

    private async handleWrite(request: BatchRequest): Promise<BatchResponse> {
        const adapter = this.config.adapter
        const resource = request.resource as string
        const payload = request.payload
        const options = request.options
        const action = request.action

        let result: BatchResult
        switch (action) {
            case 'create': {
                this.ensureAdapter(adapter.create, action)
                const res = await adapter.create!(resource, payload, options)
                result = this.wrapOne(res, request.requestId)
                break
            }
            case 'update': {
                this.ensureAdapter(adapter.update, action)
                const res = await adapter.update!(resource, payload, { ...options, where: request.where })
                result = this.wrapOne(res, request.requestId)
                break
            }
            case 'patch': {
                this.ensureAdapter(adapter.patch, action)
                const res = await adapter.patch!(resource, payload, options)
                result = this.wrapOne(res, request.requestId)
                break
            }
            case 'delete': {
                this.ensureAdapter(adapter.delete, action)
                const res = await adapter.delete!(resource, payload ?? request.where, options)
                result = this.wrapOne(res, request.requestId)
                break
            }
            case 'bulkCreate': {
                this.ensureAdapter(adapter.bulkCreate, action)
                const res = await adapter.bulkCreate!(resource, this.ensureArray(payload, action), options)
                result = this.wrapMany(res, request.requestId)
                break
            }
            case 'bulkUpdate': {
                this.ensureAdapter(adapter.bulkUpdate, action)
                const res = await adapter.bulkUpdate!(resource, this.ensureArray(payload, action), options)
                result = this.wrapMany(res, request.requestId)
                break
            }
            case 'bulkPatch': {
                this.ensureAdapter(adapter.bulkPatch, action)
                const res = await adapter.bulkPatch!(resource, this.ensureArray(payload, action), options)
                result = this.wrapMany(res, request.requestId)
                break
            }
            case 'bulkDelete': {
                this.ensureAdapter(adapter.bulkDelete, action)
                const res = await adapter.bulkDelete!(resource, this.ensureArray(payload, action), options)
                result = this.wrapMany(res, request.requestId)
                break
            }
            default:
                throw new Error(`Unsupported action: ${action}`)
        }

        return { results: [result] }
    }

    private mergeIds(request: BatchRequest, results: QueryResult[]): BatchResult[] {
        return results.map((result, idx) => ({
            requestId: request.queries?.[idx]?.requestId,
            data: result.data,
            pageInfo: result.pageInfo
        }))
    }

    private enforceAccess(request: BatchRequest) {
        if (request.action === 'query' && request.queries) {
            for (const q of request.queries) {
                this.ensureResourceAllowed(q.resource)
            }
            return
        }

        if (request.resource) {
            this.ensureResourceAllowed(request.resource)
        }
    }

    private enforceLimits(request: BatchRequest) {
        if (request.action === 'query' && request.queries) {
            if (this.config.maxQueries && request.queries.length > this.config.maxQueries) {
                throw new Error(`Too many queries: max ${this.config.maxQueries}`)
            }
            for (const q of request.queries) {
                if (this.config.maxLimit && q.params.limit && q.params.limit > this.config.maxLimit) {
                    q.params.limit = this.config.maxLimit
                }
            }
        }

        if (request.action.startsWith('bulk')) {
            const payloadArr = this.ensureArray(request.payload, request.action)
            if (this.config.maxBatchSize && payloadArr.length > this.config.maxBatchSize) {
                throw new Error(`Too many items: max ${this.config.maxBatchSize}`)
            }
        }

        if (this.config.maxPayloadBytes && request.payload !== undefined) {
            const size = Buffer.byteLength(JSON.stringify(request.payload ?? ''), 'utf8')
            if (size > this.config.maxPayloadBytes) {
                throw new Error(`Payload too large: max ${this.config.maxPayloadBytes} bytes`)
            }
        }
    }

    private validateRequest(body: any): BatchRequest {
        if (!body || typeof body.action !== 'string') {
            throw new Error('Invalid Atoma request payload')
        }

        const action = body.action as Action

        if (action === 'query') {
            if (!Array.isArray(body.queries)) {
                throw new Error('Invalid query payload: queries missing')
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
            return { action, queries }
        }

        if (!body.resource || typeof body.resource !== 'string') {
            throw new Error('Invalid write payload: resource missing')
        }

        return {
            action,
            resource: body.resource,
            payload: body.payload,
            where: lodash.isPlainObject(body.where) ? body.where : undefined,
            options: lodash.isPlainObject(body.options) ? body.options : undefined,
            requestId: body.requestId
        }
    }

    private normalizeOrderBy(orderBy: QueryParams['orderBy']): QueryParams['orderBy'] {
        if (!orderBy) return undefined

        const normalizeOne = (rule: any) => {
            if (typeof rule === 'string') {
                const [field, dir] = rule.split(':')
                if (!field) throw new Error('Invalid orderBy')
                const direction = dir?.toLowerCase() === 'asc' ? 'asc' : 'desc'
                return { field, direction }
            }
            if (rule && typeof rule === 'object' && typeof (rule as any).field === 'string') {
                const direction = (rule as any).direction === 'asc' ? 'asc' : 'desc'
                return { field: (rule as any).field, direction }
            }
            throw new Error('Invalid orderBy')
        }

        if (Array.isArray(orderBy)) return orderBy.map(normalizeOne)
        return [normalizeOne(orderBy)]
    }

    private ensureResourceAllowed(resource: string) {
        if (this.config.allowList && !this.config.allowList.includes(resource)) {
            throw new Error(`Resource access denied: ${resource}`)
        }
        if (!this.config.adapter.isResourceAllowed(resource)) {
            throw new Error(`Resource not allowed: ${resource}`)
        }
    }

    private ensureArray(payload: any, action: Action): any[] {
        if (Array.isArray(payload)) return payload
        throw new Error(`Payload for ${action} must be an array`)
    }

    private ensureAdapter(fn: unknown, action: Action) {
        if (typeof fn !== 'function') {
            throw new Error(`Adapter does not implement ${action}`)
        }
    }

    private wrapOne(result: QueryResultOne, requestId?: string): BatchResult {
        if (result.error) {
            return this.toErrorResult(requestId, result.error, result.error.code)
        }
        return {
            requestId,
            data: result.data !== undefined ? [result.data] : [],
            transactionApplied: result.transactionApplied
        }
    }

    private wrapMany(result: QueryResultMany, requestId?: string): BatchResult {
        return {
            requestId,
            data: result.data,
            partialFailures: result.partialFailures,
            transactionApplied: result.transactionApplied,
            error: result.partialFailures && result.partialFailures.length
                ? { code: 'PARTIAL_FAILURE', message: 'Some items failed', details: result.partialFailures }
                : undefined
        }
    }

    private toErrorResult(requestId: string | undefined, reason: any, code = 'INTERNAL'): BatchResult {
        return {
            requestId,
            data: [],
            error: {
                code,
                message: reason?.message || String(reason),
                details: reason
            }
        }
    }
}
