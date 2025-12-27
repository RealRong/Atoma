import type { IAdapter, StoreKey, Entity } from '#core'
import { BatchEngine, Batch } from '#batch'
import type { ObservabilityContext } from '#observability'
import { fetchWithRetry } from '../transport/retry'
import type { BatchQueryConfig, HTTPAdapterConfig } from '../config/types'
import { createOpsTransport } from '../transport/ops'
import { OperationRouter } from './OperationRouter'

const ROUTER_METHODS = [
    'put',
    'bulkPut',
    'bulkCreate',
    'delete',
    'bulkDelete',
    'get',
    'bulkGet',
    'getAll',
    'findMany',
    'applyPatches'
] as const


type ParsedBatchConfig = {
    enabled: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings: boolean
}

function makeUrl(base: string, path: string): string {
    return `${base}${path}`
}

/**
 * HTTP Adapter for ops-based APIs
 */
export class HTTPAdapter<T extends Entity> {
    public readonly name: string
    private readonly queueStorageKey: string
    private batchEngine?: BatchEngine
    private router: OperationRouter<T>
    private resourceNameForBatch: string
    private usePatchForUpdate: boolean
    private opsTransport: ReturnType<typeof createOpsTransport>

    constructor(private config: HTTPAdapterConfig<T>) {
        if (!config.resourceName) {
            throw new Error('[HTTPAdapter] "resourceName" is required for ops routing')
        }

        const batchConfig = this.parseBatchConfig(config.batch)
        this.resourceNameForBatch = this.normalizeResourceName(config.resourceName)
        this.usePatchForUpdate = config.usePatchForUpdate ?? false

        this.name = config.baseURL
        this.queueStorageKey = `atoma:httpQueue:${this.name}`

        this.opsTransport = createOpsTransport({
            fetchFn: this.fetchWithRetry.bind(this),
            getHeaders: this.getHeaders.bind(this),
            interceptors: {
                onRequest: this.config.onRequest,
                onResponse: this.config.onResponse as any
            }
        })

        if (batchConfig.enabled) {
            const endpointPath = batchConfig.endpoint ?? '/ops'
            const batchEndpoint = makeUrl(this.config.baseURL, endpointPath)
            this.batchEngine = Batch.create({
                endpoint: batchEndpoint,
                maxBatchSize: batchConfig.maxBatchSize,
                flushIntervalMs: batchConfig.flushIntervalMs,
                executeOps: async ({ ops, meta, signal }) => {
                    const res = await this.opsTransport.executeOps({
                        url: this.config.baseURL,
                        endpoint: endpointPath,
                        ops,
                        v: meta?.v,
                        deviceId: meta?.deviceId,
                        clientTimeMs: meta?.clientTimeMs,
                        signal
                    })
                    return { results: res.results as any, status: res.response.status }
                },
                onError: (error, payload) => {
                    this.onError(error, 'batch')
                    if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                        console.debug?.('[HTTPAdapter:batch] payload failed', payload)
                    }
                }
            })

            if (batchConfig.devWarnings && typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                console.info(
                    `[Atoma] BatchQuery enabled for "${this.resourceNameForBatch}" → ${batchEndpoint}\n` +
                    'Ensure backend exposes the ops endpoint. Set `batch:false` to disable.'
                )
            }
        }

        this.router = new OperationRouter<T>({
            resource: this.resourceNameForBatch,
            batch: this.batchEngine,
            opsExecute: this.executeOps.bind(this),
            usePatchForUpdate: this.usePatchForUpdate,
            resolveBaseVersion: this.resolveLocalBaseVersion.bind(this),
            onError: this.onError.bind(this),
            now: () => Date.now(),
            queryCustomFn: this.config.query?.customFn
        })
        this.bindRouterMethods()
    }

    dispose(): void {
        this.batchEngine?.dispose()
    }

    private async executeOps(
        ops: any[],
        context?: ObservabilityContext,
        meta?: { v?: number; deviceId?: string; clientTimeMs?: number },
        override?: { baseURL?: string; opsEndpoint?: string }
    ) {
        const resolvedOpsEndpoint = this.config.opsEndpoint ?? '/ops'
        const opsWithTrace = this.applyOpTraceMeta(ops, context)
        const result = await this.opsTransport.executeOps({
            url: override?.baseURL ?? this.config.baseURL,
            endpoint: override?.opsEndpoint ?? resolvedOpsEndpoint,
            ops: opsWithTrace,
            context,
            v: meta?.v,
            deviceId: meta?.deviceId,
            clientTimeMs: meta?.clientTimeMs
        })
        return result.results as any
    }

    private applyOpTraceMeta(ops: any[], context?: ObservabilityContext): any[] {
        if (!context || !Array.isArray(ops) || !ops.length) return ops
        const traceId = (typeof context.traceId === 'string' && context.traceId) ? context.traceId : undefined
        if (!traceId) return ops

        return ops.map((op) => {
            if (!op || typeof op !== 'object') return op
            const requestId = context.requestId()
            const baseMeta = (op as any).meta
            const meta = (baseMeta && typeof baseMeta === 'object' && !Array.isArray(baseMeta))
                ? baseMeta
                : undefined
            return {
                ...(op as any),
                meta: {
                    v: 1,
                    ...(meta ? meta : {}),
                    traceId,
                    ...(requestId ? { requestId } : {})
                }
            }
        })
    }

    private resolveLocalBaseVersion(id: StoreKey, value?: any): number {
        const versionFromValue = value && typeof value === 'object' ? (value as any).version : undefined
        if (typeof versionFromValue === 'number' && Number.isFinite(versionFromValue)) return versionFromValue
        return 0
    }



    async onConnect(): Promise<void> {
        // HTTP connects on-demand, nothing to do
    }

    onDisconnect(): void {
        // HTTP disconnects automatically
    }

    onError(error: Error, operation: string): void {
        console.error(`[HTTPAdapter:${this.name}] Error in ${operation}:`, error)
    }

    /**
     * Fetch with retry logic
     */
    private async fetchWithRetry(
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> {
        return fetchWithRetry(fetch, input, init, this.config.retry)
    }

    /**
     * Get headers (supports async for auth tokens)
     */
    private async getHeaders(): Promise<Record<string, string>> {
        if (!this.config.headers) {
            return {}
        }

        const headers = this.config.headers()
        return headers instanceof Promise ? await headers : headers
    }

    private bindRouterMethods() {
        const router = this.router
        ROUTER_METHODS.forEach(method => {
            ;(this as any)[method] = (router as any)[method].bind(router)
        })
    }

    private parseBatchConfig(batch?: boolean | BatchQueryConfig): ParsedBatchConfig {
        if (batch === true) {
            return { enabled: true, devWarnings: true }
        }
        if (batch === false) {
            return { enabled: false, devWarnings: true }
        }
        const cfg = batch || {}
        return {
            enabled: cfg.enabled !== false,
            endpoint: cfg.endpoint,
            maxBatchSize: cfg.maxBatchSize,
            flushIntervalMs: cfg.flushIntervalMs,
            devWarnings: cfg.devWarnings !== false
        }
    }

    private normalizeResourceName(name?: string): string {
        if (!name) return 'unknown'
        const normalized = name.replace(/^\//, '')
        const parts = normalized.split('/')
        return parts[parts.length - 1] || 'unknown'
    }
}

export interface HTTPAdapter<T extends Entity> extends IAdapter<T> {}
