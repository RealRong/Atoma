import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import { SYNC_TRANSPORT_TOKEN } from 'atoma-types/client/sync'
import type { StoreChange } from 'atoma-types/core'
import type { SyncEvent, SyncMode, SyncPhase, SyncStatus } from 'atoma-types/sync'
import { registerSyncSource } from './devtools/source'
import { SyncDevtools } from '#sync/devtools/sync-devtools'
import { toLocalSyncDocs } from './mapping/document'
import { normalizeResources } from './mapping/resources'
import {
    buildReplications,
    disposeReplications,
    pauseStates,
    startStates,
    waitReplicationsInSync
} from './replication/runtime'
import type { ReadyRuntime, ResourceStateMap } from './runtime/contracts'
import { createReadyRuntime } from './rxdb/database'
import type { SyncExtension, SyncPluginOptions } from './types'
import { toError } from './utils/common'

export function syncPlugin(options: SyncPluginOptions): ClientPlugin<SyncExtension> {
    return {
        id: 'sync',
        requires: [SYNC_TRANSPORT_TOKEN],
        setup: (ctx: PluginContext) => setupSyncPlugin(ctx, options)
    }
}

function setupSyncPlugin(
    ctx: PluginContext,
    options: SyncPluginOptions
): { extension: SyncExtension; dispose: () => void } {
    const now = () => Date.now()
    const devtools = new SyncDevtools({ now })
    const syncTransport = ctx.services.resolve(SYNC_TRANSPORT_TOKEN)
    if (!syncTransport) {
        throw new Error('[Sync] sync.transport missing: mount atomaServerBackendPlugin first')
    }

    const emitEvent = (event: SyncEvent) => {
        devtools.onEvent(event)
        options.onEvent?.(event)
    }

    const reportError = (error: unknown, phase: SyncPhase) => {
        const normalized = toError(error, `[Sync] ${phase} failed`)
        devtools.onError(normalized, { phase })
        options.onError?.(normalized, { phase })
        emitEvent({
            type: 'sync.error',
            phase,
            message: normalized.message
        })
    }

    const resources = normalizeResources(options.resources)
    const pullBatchSize = Math.max(1, Math.floor(options.pull?.batchSize ?? 200))
    const pushBatchSize = Math.max(1, Math.floor(options.push?.batchSize ?? 100))
    const live = options.live !== false
    const waitForLeadership = options.waitForLeadership === true
    const retryTimeMs = Math.max(200, Math.floor(options.retryTimeMs ?? 5000))
    const streamEnabled = options.stream?.enabled !== false
    const streamPollIntervalMs = Math.max(1000, Math.floor(options.stream?.pollIntervalMs ?? 5000))
    const streamReconnectDelayMs = Math.max(200, Math.floor(options.stream?.reconnectDelayMs ?? 1500))

    let mode: SyncMode = options.mode ?? 'full'
    let configured = true
    let started = false
    let readyPromise: Promise<ReadyRuntime> | null = null
    let rebuildingPromise: Promise<void> | null = null
    let states: ResourceStateMap = new Map()
    let disposed = false
    let remoteApplyQueue: Promise<void> = Promise.resolve()

    const ensureReady = async (): Promise<ReadyRuntime> => {
        if (readyPromise) return await readyPromise

        readyPromise = createReadyRuntime({
            clientId: ctx.clientId,
            resources
        })

        try {
            return await readyPromise
        } catch (error) {
            configured = false
            reportError(error, 'lifecycle')
            throw error
        }
    }

    const rebuildReplications = async (targetMode: SyncMode): Promise<void> => {
        if (rebuildingPromise) {
            await rebuildingPromise
            if (mode === targetMode) return
        }

        rebuildingPromise = (async () => {
            const runtime = await ensureReady()
            await disposeReplications(states)
            states = new Map()
            mode = targetMode

            const nextStates = await buildReplications({
                ctx,
                runtime,
                mode,
                options: {
                    pullBatchSize,
                    pushBatchSize,
                    live,
                    waitForLeadership,
                    retryTimeMs,
                    streamEnabled,
                    streamPollIntervalMs,
                    streamReconnectDelayMs,
                    transport: syncTransport
                },
                emitEvent,
                reportError,
                queueRemoteApply: (task) => {
                    remoteApplyQueue = remoteApplyQueue
                        .then(task)
                        .catch((error) => {
                            reportError(error, 'bridge')
                        })
                    return remoteApplyQueue
                }
            })

            states = nextStates

            if (started) {
                await startStates(states)
            }
        })()

        try {
            await rebuildingPromise
        } finally {
            rebuildingPromise = null
        }
    }

    const ensureRunning = async (targetMode: SyncMode): Promise<void> => {
        if (disposed) return
        if (states.size === 0 || mode !== targetMode) {
            await rebuildReplications(targetMode)
        }
        if (started) return

        started = true
        emitEvent({ type: 'sync.lifecycle.started' })

        try {
            await startStates(states)
        } catch (error) {
            started = false
            reportError(error, 'lifecycle')
            throw error
        }
    }

    const stopRunning = async (): Promise<void> => {
        if (!started) return
        started = false
        await pauseStates(states)
        emitEvent({ type: 'sync.lifecycle.stopped' })
    }

    const onWriteCommitted = ctx.events.on('writeCommitted', (event) => {
        if (disposed) return
        if (String(event.context?.origin ?? '') === 'sync') return

        const applyLocal = async () => {
            const runtime = await ensureReady()
            const target = runtime.resourceByStoreName.get(String(event.storeName))
            if (!target) return

            const collection = runtime.collectionByResource.get(target.resource)
            if (!collection) return

            const changes = Array.isArray(event.changes)
                ? event.changes as ReadonlyArray<StoreChange<any>>
                : []
            if (!changes.length) return

            const docs = toLocalSyncDocs({
                changes,
                resource: target.resource,
                clientId: ctx.clientId,
                now
            })
            if (!docs.length) return

            const result = await collection.bulkUpsert(docs)
            if (result.error.length) {
                const first = result.error[0]
                throw first instanceof Error
                    ? first
                    : new Error('[Sync] Failed to persist local write into RxDB collection')
            }

            emitEvent({
                type: 'sync.bridge.localWrite',
                resource: target.resource,
                count: docs.length
            })
        }

        void applyLocal().catch((error) => {
            reportError(error, 'bridge')
        })
    })

    const sync = {
        start: (nextMode?: SyncMode) => {
            const selectedMode = nextMode ?? mode
            void ensureRunning(selectedMode).catch((error) => {
                reportError(error, 'lifecycle')
            })
        },
        stop: () => {
            void stopRunning().catch((error) => {
                reportError(error, 'lifecycle')
            })
        },
        dispose: () => {
            void disposeInternal()
        },
        status: (): SyncStatus => {
            return {
                started,
                configured,
                active: started
            }
        },
        pull: async () => {
            await ensureRunning(mode)
            const pullStates = Array.from(states.values()).filter(state => state.pullEnabled)
            if (!pullStates.length) return

            pullStates.forEach((state) => {
                state.replication.reSync()
            })
            await waitReplicationsInSync(pullStates)
        },
        push: async () => {
            await ensureRunning(mode)
            const pushStates = Array.from(states.values()).filter(state => state.pushEnabled)
            if (!pushStates.length) return

            pushStates.forEach((state) => {
                state.replication.reSync()
            })
            await waitReplicationsInSync(pushStates)
        },
        devtools: {
            snapshot: devtools.snapshot,
            subscribe: devtools.subscribe
        }
    } as const

    const extension: SyncExtension = { sync }

    const unregisterSource = registerSyncSource({
        ctx,
        now,
        devtools,
        sync
    })

    const disposeInternal = async () => {
        if (disposed) return
        disposed = true

        try {
            await stopRunning()
        } catch {
            // ignore
        }

        try {
            await disposeReplications(states)
            states = new Map()
        } catch {
            // ignore
        }

        try {
            const ready = readyPromise
                ? await readyPromise.catch(() => null)
                : null
            await ready?.database.close()
        } catch {
            // ignore
        }

        try {
            unregisterSource?.()
        } catch {
            // ignore
        }

        try {
            onWriteCommitted()
        } catch {
            // ignore
        }
    }

    return {
        extension,
        dispose: () => {
            void disposeInternal()
        }
    }
}
