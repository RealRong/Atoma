import { Protocol } from 'atoma-protocol'
import type { Meta, OpsResponseData } from 'atoma-types/protocol'
import { OpsClient } from './internal/ops-client-base'
import type { ExecuteOpsInput, ExecuteOpsOutput } from 'atoma-types/client'
import { BatchEngine } from './internal/batch/batch-engine'
import { createOpsHttpTransport } from './internal/transport/ops-transport'
import type { HttpInterceptors } from './internal/transport/json-client'

export type RetryOptions = {
    maxAttempts?: number
    backoff?: 'exponential' | 'linear'
    initialDelayMs?: number
    maxElapsedMs?: number
    jitter?: boolean
}

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
            this.batchEngine = new BatchEngine({
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
            const results = await this.batchEngine.enqueueOps(input.ops)
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
    private async _executeOpsDirectly({ ops, meta, signal }: ExecuteOpsInput): Promise<ExecuteOpsOutput> {
        const requestMeta = this.normalizeRequestMeta(meta)
        Protocol.ops.validate.assertOutgoingOps({ ops, meta: requestMeta })
        const res = await this.transport.executeOps({
            baseURL: this.baseURL,
            opsPath: this.opsPath,
            ops,
            meta: requestMeta,
            signal
        })

        return {
            results: res.results as any,
            status: res.response.status
        }
    }
}

function addJitter(base: number): number {
    const jitter = Math.random() * 0.3 * base
    return base + jitter
}

function calculateBackoff(
    backoff: 'exponential' | 'linear',
    initialDelayMs: number,
    attempt: number,
    jitter: boolean
): number {
    const base = backoff === 'exponential'
        ? initialDelayMs * Math.pow(2, attempt - 1)
        : initialDelayMs * attempt
    return jitter ? addJitter(base) : base
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function fetchWithRetry(
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    retry: RetryOptions | undefined,
    startedAt = Date.now(),
    attemptNumber = 1
): Promise<Response> {
    try {
        const response = await fetchFn(input, init)

        // Don't retry client errors (4xx except 409)
        if (response.status >= 400 && response.status < 500 && response.status !== 409) {
            return response
        }

        // Retry server errors (5xx)
        if (response.status >= 500) {
            throw new Error(`Server error: ${response.status}`)
        }

        return response
    } catch (error) {
        const maxAttempts = retry?.maxAttempts ?? 3
        if (attemptNumber >= maxAttempts) throw error

        const maxElapsedMs = retry?.maxElapsedMs ?? 30_000
        const elapsed = Date.now() - startedAt
        if (elapsed >= maxElapsedMs) throw error

        const backoff = retry?.backoff ?? 'exponential'
        const initialDelayMs = retry?.initialDelayMs ?? 1000
        const delay = calculateBackoff(backoff, initialDelayMs, attemptNumber, retry?.jitter === true)

        await sleep(delay)
        return fetchWithRetry(fetchFn, input, init, retry, startedAt, attemptNumber + 1)
    }
}
