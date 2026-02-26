import { assertOutgoingRemoteOps, HTTP_PATH_OPS } from 'atoma-types/protocol-tools'
import type { Meta, RemoteOpsResponseData } from 'atoma-types/protocol'
import type { ExecuteOperationsInput, ExecuteOperationsOutput } from 'atoma-types/client/ops'
import { BatchEngine } from './batch'
import { createTransport } from './transport'
import type { HttpInterceptors } from './transport'
import pRetry from 'p-retry'

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

export class HttpOperationClient {
    private readonly baseURL: string
    private readonly operationsPath: string
    private readonly fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    private readonly retry?: RetryOptions
    private readonly getHeaders: () => Promise<Record<string, string>>
    private readonly transport: ReturnType<typeof createTransport>
    private readonly batchEngine?: BatchEngine

    constructor(config: HttpOperationClientConfig) {
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

        this.transport = createTransport({
            fetchFn: async (input, init) => fetchWithRetry(this.fetchFn, input, init, this.retry),
            getHeaders: this.getHeaders,
            interceptors: config.interceptors
        })

        // Initialize BatchEngine (default: enabled with zero delay)
        const batchEnabled = config.batch?.enabled ?? true
        if (batchEnabled) {
            this.batchEngine = new BatchEngine({
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

    dispose(): void {
        this.batchEngine?.dispose()
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

function isAbortError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError')
}

function normalizePositiveInt(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
    return Math.floor(value)
}

async function fetchWithRetry(
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    retry: RetryOptions | undefined,
): Promise<Response> {
    const maxAttempts = normalizePositiveInt(retry?.maxAttempts, 3)
    const maxRetryTime = normalizePositiveInt(retry?.maxElapsedMs, 30_000)
    const backoff = retry?.backoff ?? 'exponential'
    const initialDelayMs = normalizePositiveInt(retry?.initialDelayMs, 1000)
    const jitter = retry?.jitter === true

    return pRetry(
        async () => {
            if (init?.signal?.aborted) {
                throw new Error('Request aborted')
            }

            const response = await fetchFn(input, init)
            if (response.status >= 500) {
                throw new Error(`Server error: ${response.status}`)
            }
            return response
        },
        {
            retries: Math.max(0, maxAttempts - 1),
            minTimeout: 0,
            factor: 1,
            randomize: false,
            maxRetryTime,
            shouldRetry: ({ error }) => {
                if (init?.signal?.aborted) return false
                if (isAbortError(error)) return false
                return true
            },
            onFailedAttempt: async ({ attemptNumber, retriesLeft }) => {
                if (retriesLeft <= 0) return
                await sleep(calculateBackoff(backoff, initialDelayMs, attemptNumber, jitter))
            }
        }
    )
}
