import { Protocol, type Meta, type OpsResponseData } from 'atoma-protocol'
import { OpsClient, type ExecuteOpsInput, type ExecuteOpsOutput } from '../types'
import { Batch, type BatchEngine } from './internal/batch'
import { createOpsHttpTransport } from './internal/transport/opsTransport'
import { fetchWithRetry, type RetryOptions } from './internal/transport/retryPolicy'
import type { HttpInterceptors } from './internal/transport/jsonClient'

export type HttpOpsClientConfig = {
    baseURL: string
    opsPath?: string
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    retry?: RetryOptions
    fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    interceptors?: HttpInterceptors<OpsResponseData>
    /** 
     * Batch configuration. Default: enabled with zero delay.
     * Set to { enabled: false } to disable batching.
     */
    batch?: {
        enabled?: boolean
        maxBatchSize?: number
        flushIntervalMs?: number
        maxQueueLength?: number | { query?: number; write?: number }
        queryOverflowStrategy?: 'reject_new' | 'drop_old_queries'
        queryMaxInFlight?: number
        writeMaxInFlight?: number
        maxOpsPerRequest?: number
    }
}

export class HttpOpsClient extends OpsClient {
    private readonly baseURL: string
    private readonly opsPath: string
    private readonly fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    private readonly retry?: RetryOptions
    private readonly getHeaders: () => Promise<Record<string, string>>
    private readonly transport: ReturnType<typeof createOpsHttpTransport>
    private readonly batchEngine?: BatchEngine

    constructor(config: HttpOpsClientConfig) {
        super()

        this.baseURL = config.baseURL
        this.opsPath = config.opsPath ?? Protocol.http.paths.OPS
        this.fetchFn = config.fetchFn ?? fetch.bind(globalThis)
        this.retry = config.retry

        this.getHeaders = async () => {
            const headers = config.headers
            if (!headers) return {}
            if (typeof headers === 'function') {
                const resolved = headers()
                return resolved instanceof Promise ? await resolved : resolved
            }
            return headers
        }

        this.transport = createOpsHttpTransport({
            fetchFn: async (input, init) => fetchWithRetry(this.fetchFn, input, init, this.retry),
            getHeaders: this.getHeaders,
            interceptors: config.interceptors
        })

        // Initialize BatchEngine (default: enabled with zero delay)
        const batchEnabled = config.batch?.enabled ?? true
        if (batchEnabled) {
            this.batchEngine = Batch.create({
                endpoint: this.opsPath,
                executeFn: (input) => this._executeOpsDirectly(input),
                flushIntervalMs: config.batch?.flushIntervalMs ?? 0,
                maxBatchSize: config.batch?.maxBatchSize,
                maxQueueLength: config.batch?.maxQueueLength,
                queryOverflowStrategy: config.batch?.queryOverflowStrategy,
                queryMaxInFlight: config.batch?.queryMaxInFlight,
                writeMaxInFlight: config.batch?.writeMaxInFlight,
                maxOpsPerRequest: config.batch?.maxOpsPerRequest
            })
        }
    }

    private normalizeRequestMeta(meta: Meta): Meta {
        const clientTimeMs = (typeof meta.clientTimeMs === 'number' && Number.isFinite(meta.clientTimeMs))
            ? meta.clientTimeMs
            : Date.now()
        return {
            ...meta,
            clientTimeMs
        }
    }

    /**
     * Execute operations. Automatically uses BatchEngine if enabled.
     */
    async executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput> {
        if (this.batchEngine) {
            const results = await this.batchEngine.enqueueOps(input.ops, input.context)
            return {
                results,
                status: 200
            }
        }
        return this._executeOpsDirectly(input)
    }

    /**
     * Direct HTTP execution (bypasses BatchEngine).
     * Used internally by BatchEngine.
     */
    private async _executeOpsDirectly({ ops, meta, context, signal }: ExecuteOpsInput): Promise<ExecuteOpsOutput> {
        const requestMeta = this.normalizeRequestMeta(meta)
        Protocol.ops.validate.assertOutgoingOps({ ops, meta: requestMeta })
        const res = await this.transport.executeOps({
            baseURL: this.baseURL,
            opsPath: this.opsPath,
            ops,
            meta: requestMeta,
            context,
            signal
        })

        return {
            results: res.results as any,
            status: res.response.status
        }
    }
}
