import { HTTP_PATH_OPS } from 'atoma-types/protocol-tools'
import type { RemoteOpsResponseData } from 'atoma-types/protocol'
import type { ExecuteOperationsInput, ExecuteOperationsOutput } from 'atoma-types/client/ops'
import { BatchEngine } from './batch'
import { createTransport } from './transport'
import type { HttpInterceptors } from './transport'
import type { RetryOptions as SharedRetryOptions } from 'atoma-shared'

export type RetryOptions = SharedRetryOptions

export type OperationClientConfig = {
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

    constructor(config: OperationClientConfig) {
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
            fetchFn: this.fetchFn,
            retry: this.retry,
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

    /**
     * Execute operations. Automatically uses BatchEngine if enabled.
     */
    async executeOperations(input: ExecuteOperationsInput): Promise<ExecuteOperationsOutput> {
        if (this.batchEngine) {
            const results = await this.batchEngine.enqueueOperations(input)
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
        const res = await this.transport.executeOperations({
            baseURL: this.baseURL,
            endpointPath: this.operationsPath,
            ops,
            meta,
            signal
        })

        return {
            results: res.results as any,
            status: res.response.status
        }
    }
}
