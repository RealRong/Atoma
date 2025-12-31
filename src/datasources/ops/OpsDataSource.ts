import type { IDataSource, StoreKey, Entity } from '#core'
import { BatchEngine, Batch } from '#batch'
import type { ObservabilityContext } from '#observability'
import { Protocol, type Meta, type Operation, type OperationResult } from '#protocol'
import type { BatchQueryConfig, OpsDataSourceConfig } from './config/types'
import { OperationRouter } from './OperationRouter'

const ROUTER_METHODS = [
    'put',
    'bulkPut',
    'bulkCreate',
    'upsert',
    'bulkUpsert',
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

/**
 * Protocol DataSource for ops-based APIs
 */
export class OpsDataSource<T extends Entity> implements IDataSource<T> {
    public readonly name: string
    private batchEngine?: BatchEngine
    private ownsBatchEngine: boolean
    private router: OperationRouter<T>
    private resourceNameForBatch: string
    private readonly opsClient: OpsDataSourceConfig<T>['opsClient']

    constructor(private config: OpsDataSourceConfig<T>) {
        if (!config.resourceName) {
            throw new Error('[OpsDataSource] "resourceName" is required for ops routing')
        }

        if (!config.opsClient) {
            throw new Error('[OpsDataSource] "opsClient" is required')
        }

        this.ownsBatchEngine = false
        this.resourceNameForBatch = this.normalizeResourceName(config.resourceName)

        this.opsClient = config.opsClient
        this.name = config.name ?? `ops:${this.resourceNameForBatch}`

        if (config.batchEngine) {
            this.batchEngine = config.batchEngine
        } else {
            const batchConfig = this.parseBatchConfig(config.batch)
            if (batchConfig.enabled) {
                const endpointPath = batchConfig.endpoint ?? Protocol.http.paths.OPS
                this.batchEngine = Batch.create({
                    endpoint: endpointPath,
                    maxBatchSize: batchConfig.maxBatchSize,
                    flushIntervalMs: batchConfig.flushIntervalMs,
                    opsClient: this.opsClient,
                    onError: (error, payload) => {
                        this.onError(error, 'batch')
                        if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                            console.debug?.('[OpsDataSource:batch] payload failed', payload)
                        }
                    }
                })
                this.ownsBatchEngine = true

                if (batchConfig.devWarnings && typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                    console.info(
                        `[Atoma] BatchQuery enabled for "${this.resourceNameForBatch}" → ${endpointPath}\n` +
                        'Ensure backend exposes the ops endpoint. Set `batch:false` to disable.'
                    )
                }
            }
        }

        this.router = new OperationRouter<T>({
            resource: this.resourceNameForBatch,
            batch: this.batchEngine,
            opsExecute: this.executeOps.bind(this),
            resolveBaseVersion: this.resolveLocalBaseVersion.bind(this),
            onError: this.onError.bind(this),
            now: () => Date.now(),
            queryCustomFn: this.config.query?.customFn
        })
        this.bindRouterMethods()
    }

    dispose(): void {
        if (this.ownsBatchEngine) {
            this.batchEngine?.dispose()
        }
    }

    private async executeOps(
        ops: Operation[],
        context?: ObservabilityContext
    ): Promise<OperationResult[]> {
        const opsWithTrace = this.applyOpTraceMeta(ops as any, context) as Operation[]
        const meta: Meta = { v: 1, clientTimeMs: Date.now() }
        const result = await this.opsClient.executeOps({
            ops: opsWithTrace,
            meta,
            context
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
        console.error(`[OpsDataSource:${this.name}] Error in ${operation}:`, error)
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

export interface OpsDataSource<T extends Entity> extends IDataSource<T> {}
