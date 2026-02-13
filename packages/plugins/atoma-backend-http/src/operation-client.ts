import { assertOutgoingRemoteOps, HTTP_PATH_OPS } from 'atoma-types/protocol-tools'
import type { Meta, RemoteOpsResponseData } from 'atoma-types/protocol'
import { OperationClientBase } from './internal/operation-client-base'
import type { ExecuteOperationsInput, ExecuteOperationsOutput } from 'atoma-types/client/ops'
import { BatchEngine } from './internal/batch/batch-engine'
import { createOperationHttpTransport } from './internal/transport/operation-transport'
import type { HttpInterceptors } from './internal/transport/json-client'

export type RetryOptions = {
    maxAttempts?: number
    backoff?: 'exponential' | 'linear'
    initialDelayMs?: number
    maxElapsedMs?: number
    jitter?: boolean
}

export type HttpOperationClientConfig = {
    baseURL: string
    operationsPath?: string
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    retry?: RetryOptions
    fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    interceptors?: HttpInterceptors<RemoteOpsResponseData>
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

export class HttpOperationClient extends OperationClientBase {
    private readonly baseURL: string
    private readonly operationsPath: string
    private readonly fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    private readonly retry?: RetryOptions
    private readonly getHeaders: () => Promise<Record<string, string>>
    private readonly transport: ReturnType<typeof createOperationHttpTransport>
    private readonly batchEngine?: BatchEngine

    constructor(config: HttpOperationClientConfig) {
        super()

        this.baseURL = config.baseURL
        this.operationsPath = config.operationsPath ?? HTTP_PATH_OPS
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

        this.transport = createOperationHttpTransport({
            fetchFn: async (input, init) => fetchWithRetry(this.fetchFn, input, init, this.retry),
            getHeaders: this.getHeaders,
            interceptors: config.interceptors
        })

        // Initialize BatchEngine (default: enabled with zero delay)
        const batchEnabled = config.batch?.enabled ?? true
        if (batchEnabled) {
            this.batchEngine = new BatchEngine({
                endpoint: this.operationsPath,
                executeFn: (input) => this.executeOperationsDirectly(input),
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
    async executeOperations(input: ExecuteOperationsInput): Promise<ExecuteOperationsOutput> {
        if (this.batchEngine) {
            const results = await this.batchEngine.enqueueOperations(input.ops)
            return {
                results,
                status: 200
            }
        }
        return this.executeOperationsDirectly(input)
    }

    /**
     * Direct HTTP execution (bypasses BatchEngine).
     * Used internally by BatchEngine.
     */
    private async executeOperationsDirectly({ ops, meta, signal }: ExecuteOperationsInput): Promise<ExecuteOperationsOutput> {
        const requestMeta = this.normalizeRequestMeta(meta)
        assertOutgoingRemoteOps({ ops, meta: requestMeta })
        const res = await this.transport.executeOperations({
            baseURL: this.baseURL,
            endpointPath: this.operationsPath,
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
