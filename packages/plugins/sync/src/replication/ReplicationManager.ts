import type { PluginContext } from 'atoma-types/client/plugins'
import type { SyncTransport } from 'atoma-types/client/sync'
import type { SyncEvent, SyncMode, SyncPhase } from 'atoma-types/sync'
import type { ReadyRuntime, ResourceStateMap } from '../runtime/contracts'
import {
    buildReplications,
    disposeReplications,
    pauseStates,
    startStates,
    waitReplicationsInSync
} from './runtime'

type ReplicationOptions = Readonly<{
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

export class ReplicationManager {
    private mode: SyncMode
    private started = false
    private disposed = false
    private states: ResourceStateMap = new Map()
    private rebuildingPromise: Promise<void> | null = null
    private remoteApplyQueue: Promise<void> = Promise.resolve()

    constructor(private readonly args: {
        ctx: PluginContext
        mode: SyncMode
        options: ReplicationOptions
        ensureReady: () => Promise<ReadyRuntime>
        emitEvent: (event: SyncEvent) => void
        reportError: (error: unknown, phase: SyncPhase) => void
    }) {
        this.mode = args.mode
    }

    getMode(): SyncMode {
        return this.mode
    }

    getStarted(): boolean {
        return this.started
    }

    async start(mode: SyncMode): Promise<void> {
        await this.ensureRunning(mode)
    }

    async stop(): Promise<void> {
        if (!this.started) return
        this.started = false
        await pauseStates(this.states)
        this.args.emitEvent({ type: 'sync.lifecycle.stopped' })
    }

    async pull(): Promise<void> {
        await this.ensureRunning(this.mode)
        const pullStates = Array.from(this.states.values()).filter(state => state.pullEnabled)
        if (!pullStates.length) return

        pullStates.forEach((state) => {
            state.replication.reSync()
        })
        await waitReplicationsInSync(pullStates)
    }

    async push(): Promise<void> {
        await this.ensureRunning(this.mode)
        const pushStates = Array.from(this.states.values()).filter(state => state.pushEnabled)
        if (!pushStates.length) return

        pushStates.forEach((state) => {
            state.replication.reSync()
        })
        await waitReplicationsInSync(pushStates)
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true

        try {
            await this.stop()
        } catch {
            // ignore
        }

        try {
            await disposeReplications(this.states)
            this.states = new Map()
        } catch {
            // ignore
        }
    }

    private async ensureRunning(mode: SyncMode): Promise<void> {
        if (this.disposed) return
        if (this.states.size === 0 || this.mode !== mode) {
            await this.rebuild(mode)
        }
        if (this.started) return

        this.started = true
        this.args.emitEvent({ type: 'sync.lifecycle.started' })

        try {
            await startStates(this.states)
        } catch (error) {
            this.started = false
            this.args.reportError(error, 'lifecycle')
            throw error
        }
    }

    private async rebuild(mode: SyncMode): Promise<void> {
        if (this.rebuildingPromise) {
            await this.rebuildingPromise
            if (this.mode === mode) return
        }

        this.rebuildingPromise = (async () => {
            const runtime = await this.args.ensureReady()
            await disposeReplications(this.states)
            this.states = new Map()
            this.mode = mode

            const nextStates = await buildReplications({
                ctx: this.args.ctx,
                runtime,
                mode,
                options: this.args.options,
                emitEvent: this.args.emitEvent,
                reportError: this.args.reportError,
                queueRemoteApply: (task) => this.queueRemoteApply(task)
            })
            this.states = nextStates

            if (this.started) {
                await startStates(this.states)
            }
        })()

        try {
            await this.rebuildingPromise
        } finally {
            this.rebuildingPromise = null
        }
    }

    private queueRemoteApply(task: () => Promise<void>): Promise<void> {
        this.remoteApplyQueue = this.remoteApplyQueue
            .then(task)
            .catch((error) => {
                this.args.reportError(error, 'bridge')
            })
        return this.remoteApplyQueue
    }
}
