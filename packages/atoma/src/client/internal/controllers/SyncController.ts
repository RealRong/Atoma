import { createSyncEngine, type CursorStore, type OutboxReader, type SyncApplier, type SyncClient } from 'atoma-sync'
import type { AtomaClientSyncConfig, AtomaSyncStartMode, ResolvedBackend, AtomaSync } from '#client/types'
import type { ClientRuntimeInternal } from '#client/internal/types'
import { SyncReplicatorApplier } from '#client/internal/controllers/SyncReplicatorApplier'
import { ClientRuntimeSseTransport } from '#client/internal/sync/ClientRuntimeSseTransport'
import { ClientRuntimeSyncDiagnostics } from '#client/internal/sync/ClientRuntimeSyncDiagnostics'
import { resolveSyncRuntimeConfig } from '#client/internal/sync/resolveSyncRuntimeConfig'
type EngineMode = AtomaSyncStartMode

export class SyncController {
    readonly sync: AtomaSync
    readonly devtools: Readonly<{
        snapshot: () => { queue?: { pending: number; failed: number }; lastEventAt?: number; lastError?: string }
        subscribe: (fn: (e: { type: string; payload?: any }) => void) => () => void
    }>
    readonly dispose: () => void

    private readonly runtime: ClientRuntimeInternal
    private readonly backend?: ResolvedBackend
    private readonly localBackend?: ResolvedBackend
    private readonly syncConfig?: AtomaClientSyncConfig
    private readonly syncConfigured: boolean
    private readonly now: () => number
    private readonly applier: SyncApplier
    private readonly outboxStore?: OutboxReader
    private readonly cursorStore?: CursorStore
    private readonly lockKey?: string

    private readonly diagnostics: ClientRuntimeSyncDiagnostics
    private sseTransport: ClientRuntimeSseTransport | undefined

    private syncStarted = false
    private syncEngine: SyncClient | null = null
    private engineModeKey: string | null = null

    constructor(args: {
        runtime: ClientRuntimeInternal
        backend?: ResolvedBackend
        localBackend?: ResolvedBackend
        syncConfig?: AtomaClientSyncConfig
        outboxStore?: OutboxReader
        cursorStore?: CursorStore
        lockKey?: string
    }) {
        this.runtime = args.runtime
        this.backend = args.backend
        this.localBackend = args.localBackend
        this.syncConfig = args.syncConfig
        this.syncConfigured = Boolean(this.syncConfig)
        this.now = this.syncConfig?.engine.now ?? (() => Date.now())
        this.applier = new SyncReplicatorApplier(this.runtime, this.backend, this.localBackend, this.syncConfig)
        this.outboxStore = args.outboxStore
        this.cursorStore = args.cursorStore
        this.lockKey = args.lockKey
        this.diagnostics = new ClientRuntimeSyncDiagnostics({ enabled: this.syncConfigured, now: this.now })

        this.devtools = {
            snapshot: () => this.diagnostics.snapshot(),
            subscribe: (fn) => this.diagnostics.subscribe(fn)
        } as const
        this.sync = {
            start: (mode) => {
                const resolved = mode ?? this.resolveDefaultStartMode()
                const engine = this.ensureSyncEngine({ mode: resolved })
                this.syncStarted = true
                engine.start()
            },
            stop: () => {
                if (!this.syncStarted) return
                this.syncStarted = false
                this.safe(() => this.syncEngine?.stop())
            },
            dispose: () => {
                this.syncStarted = false
                this.disposeEngine()
                this.sseTransport = undefined
            },
            status: () => ({ started: this.syncStarted, configured: this.syncConfigured }),
            pull: async () => {
                if (!this.syncStarted) {
                    this.sync.start('pull-only')
                }
                const engine = this.ensureSyncEngine({ mode: 'pull-only' })
                await engine.pull()
            },
            push: async () => {
                if (!this.syncStarted) {
                    this.sync.start('push-only')
                }
                const engine = this.ensureSyncEngine({ mode: 'push-only' })
                await engine.flush()
            }
        }

        this.dispose = () => {
            try {
                this.sync.dispose()
            } catch {
                // ignore
            }
        }
    }

    private safe = (fn: () => void) => {
        try {
            fn()
        } catch {
            // ignore
        }
    }

    private disposeEngine = () => {
        if (!this.syncEngine) return
        this.safe(() => this.syncEngine?.stop())
        this.safe(() => this.syncEngine?.dispose())
        this.syncEngine = null
        this.engineModeKey = null
    }

    private resolveDefaultStartMode = (): 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full' => {
        return this.syncConfig?.engine.mode ?? 'full'
    }

    private requireConfigured = (): { syncConfig: AtomaClientSyncConfig; backend: ResolvedBackend } => {
        if (!this.syncConfig) {
            throw new Error('[Atoma] sync: 未配置（请在 createClient 中提供 sync 配置）')
        }
        if (!this.backend) {
            throw new Error('[Atoma] sync: 未配置同步对端（请配置 sync.url 或 sync.endpoint）')
        }
        return { syncConfig: this.syncConfig, backend: this.backend }
    }

    private ensureSyncEngine = (args2?: { mode?: EngineMode }): SyncClient => {
        const mode: EngineMode = args2?.mode ?? 'full'
        const key = String(mode)
        if (this.syncEngine && this.engineModeKey === key) return this.syncEngine

        if (this.syncEngine && this.engineModeKey !== key) {
            this.disposeEngine()
        }

        const configured = this.requireConfigured()
        const syncConfig = configured.syncConfig
        const backend = configured.backend

        if (!this.sseTransport && backend.sse?.buildUrl) {
            this.sseTransport = new ClientRuntimeSseTransport(backend.sse.buildUrl)
        }

        const createArgs = resolveSyncRuntimeConfig({
            mode,
            syncConfig,
            backend,
            applier: this.applier,
            outboxStore: this.outboxStore,
            cursorStore: this.cursorStore,
            lockKey: this.lockKey,
            now: syncConfig.engine.now,
            diagnostics: this.diagnostics,
            sseTransport: this.sseTransport
        })

        this.syncEngine = createSyncEngine(createArgs)
        this.engineModeKey = key
        return this.syncEngine
    }
}
