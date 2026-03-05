import type { PluginContext } from '@atoma-js/types/client/plugins'
import { SYNC_TRANSPORT_TOKEN, type SyncTransport } from '@atoma-js/types/client/sync'
import type { SyncEvent, SyncMode, SyncPhase, SyncStatus } from '@atoma-js/types/sync'
import { LocalBridge } from '../bridge/LocalBridge'
import { registerSyncSource } from '../devtools/source'
import { SyncDevtools } from '../devtools/sync-devtools'
import { normalizeResources } from '../mapping/resources'
import { ReplicationManager } from '../replication/ReplicationManager'
import type { ReadyRuntime, SyncResourceRuntime } from '../runtime/contracts'
import { createReadyRuntime } from '../rxdb/database'
import type { SyncExtension, SyncPluginOptions } from '../types'
import { toError } from '../utils/common'

type ParsedOptions = Readonly<{
    resources: ReadonlyArray<SyncResourceRuntime>
    mode: SyncMode
    replication: Readonly<{
        pullBatchSize: number
        pushBatchSize: number
        live: boolean
        waitForLeadership: boolean
        retryTimeMs: number
        streamEnabled: boolean
        streamPollIntervalMs: number
        streamReconnectDelayMs: number
        transport: SyncTransport
    }>
}>

export class SyncController {
    private readonly now = () => Date.now()
    private readonly devtools = new SyncDevtools({ now: this.now })

    private parsed: ParsedOptions | null = null
    private configured = true
    private disposed = false
    private readyPromise: Promise<ReadyRuntime> | null = null
    private replicationManager: ReplicationManager | null = null
    private localBridge: LocalBridge | null = null
    private unregisterSource: (() => void) | undefined
    private sync: SyncExtension['sync'] | null = null

    constructor(private readonly args: {
        ctx: PluginContext
        options: SyncPluginOptions
    }) {}

    parse(): void {
        if (this.parsed) return

        const transport = this.args.ctx.services.resolve(SYNC_TRANSPORT_TOKEN)
        if (!transport) {
            throw new Error('[Sync] sync.transport missing: mount atomaServerBackendPlugin first')
        }

        const options = this.args.options
        this.parsed = {
            resources: normalizeResources(options.resources),
            mode: options.mode ?? 'full',
            replication: {
                pullBatchSize: Math.max(1, Math.floor(options.pull?.batchSize ?? 200)),
                pushBatchSize: Math.max(1, Math.floor(options.push?.batchSize ?? 100)),
                live: options.live !== false,
                waitForLeadership: options.waitForLeadership === true,
                retryTimeMs: Math.max(200, Math.floor(options.retryTimeMs ?? 5000)),
                streamEnabled: options.stream?.enabled !== false,
                streamPollIntervalMs: Math.max(1000, Math.floor(options.stream?.pollIntervalMs ?? 5000)),
                streamReconnectDelayMs: Math.max(200, Math.floor(options.stream?.reconnectDelayMs ?? 1500)),
                transport
            }
        }
    }

    prepare(): void {
        const parsed = this.requireParsed()
        if (this.replicationManager) return

        this.replicationManager = new ReplicationManager({
            ctx: this.args.ctx,
            mode: parsed.mode,
            options: parsed.replication,
            ensureReady: () => this.ensureReady(),
            emitEvent: (event) => this.emitEvent(event),
            reportError: (error, phase) => this.reportError(error, phase)
        })

        this.localBridge = new LocalBridge({
            ctx: this.args.ctx,
            ensureReady: () => this.ensureReady(),
            now: this.now,
            emitEvent: (event) => this.emitEvent(event),
            reportError: (error, phase) => this.reportError(error, phase)
        })
    }

    mount(): SyncExtension {
        this.prepare()
        this.requireLocalBridge().mount()

        const sync = this.getSync()
        this.unregisterSource = registerSyncSource({
            ctx: this.args.ctx,
            now: this.now,
            devtools: this.devtools,
            sync
        })

        return { sync }
    }

    dispose = (): void => {
        void this.disposeInternal()
    }

    private getSync(): SyncExtension['sync'] {
        if (this.sync) return this.sync

        const manager = this.requireManager()
        this.sync = {
            start: (mode?: SyncMode) => {
                const selectedMode = mode ?? manager.getMode()
                void manager.start(selectedMode).catch((error) => {
                    this.reportError(error, 'lifecycle')
                })
            },
            stop: () => {
                void manager.stop().catch((error) => {
                    this.reportError(error, 'lifecycle')
                })
            },
            dispose: () => {
                this.dispose()
            },
            status: (): SyncStatus => {
                const started = manager.getStarted()
                return {
                    started,
                    configured: this.configured,
                    active: started
                }
            },
            pull: async () => {
                await manager.pull()
            },
            push: async () => {
                await manager.push()
            },
            devtools: {
                snapshot: this.devtools.snapshot,
                subscribe: this.devtools.subscribe
            }
        }

        return this.sync
    }

    private emitEvent(event: SyncEvent): void {
        this.devtools.onEvent(event)
        this.args.options.onEvent?.(event)
    }

    private reportError(error: unknown, phase: SyncPhase): void {
        const normalized = toError(error, `[Sync] ${phase} failed`)
        this.devtools.onError(normalized, { phase })
        this.args.options.onError?.(normalized, { phase })
        this.emitEvent({
            type: 'sync.error',
            phase,
            message: normalized.message
        })
    }

    private async ensureReady(): Promise<ReadyRuntime> {
        const parsed = this.requireParsed()
        if (this.readyPromise) return await this.readyPromise

        this.readyPromise = createReadyRuntime({
            clientId: this.args.ctx.clientId,
            resources: parsed.resources
        })

        try {
            return await this.readyPromise
        } catch (error) {
            this.configured = false
            this.reportError(error, 'lifecycle')
            throw error
        }
    }

    private async disposeInternal(): Promise<void> {
        if (this.disposed) return
        this.disposed = true

        try {
            await this.replicationManager?.dispose()
        } catch {
            // ignore
        }

        try {
            const ready = this.readyPromise
                ? await this.readyPromise.catch(() => null)
                : null
            await ready?.database.close()
        } catch {
            // ignore
        }

        try {
            this.unregisterSource?.()
        } catch {
            // ignore
        }

        this.localBridge?.dispose()
    }

    private requireParsed(): ParsedOptions {
        if (!this.parsed) {
            throw new Error('[Sync] parse must be called before prepare')
        }
        return this.parsed
    }

    private requireManager(): ReplicationManager {
        if (!this.replicationManager) {
            throw new Error('[Sync] prepare must be called before mount')
        }
        return this.replicationManager
    }

    private requireLocalBridge(): LocalBridge {
        if (!this.localBridge) {
            throw new Error('[Sync] prepare must be called before mount')
        }
        return this.localBridge
    }
}
