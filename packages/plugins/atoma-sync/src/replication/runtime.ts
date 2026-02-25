import type { PluginContext } from 'atoma-types/client/plugins'
import type { SyncTransport } from 'atoma-types/client/sync'
import type { SyncCheckpoint, SyncEvent, SyncMode, SyncPhase } from 'atoma-types/sync'
import { replicateRxCollection } from 'rxdb/plugins/replication'
import { applyRemoteDocument } from '../bridge/remoteApply'
import {
    sanitizeIncomingDocument,
    sanitizeOutgoingDocument,
    toReplicationDocument
} from '../mapping/document'
import type { ReadyRuntime, ResourceReplication, ResourceStateMap, SyncDoc } from '../runtime/contracts'
import { wait } from '../utils/common'

type ReplicationRuntimeOptions = Readonly<{
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

export async function buildReplications(args: {
    ctx: PluginContext
    runtime: ReadyRuntime
    mode: SyncMode
    options: ReplicationRuntimeOptions
    emitEvent: (event: SyncEvent) => void
    reportError: (error: unknown, phase: SyncPhase) => void
    queueRemoteApply: (task: () => Promise<void>) => Promise<void>
}): Promise<ResourceStateMap> {
    const states: ResourceStateMap = new Map()

    for (const resource of args.runtime.resources) {
        const collection = args.runtime.collectionByResource.get(resource.resource)
        if (!collection) continue

        const pullEnabled = args.mode !== 'push-only'
        const pushEnabled = args.mode !== 'pull-only'

        const replication = replicateRxCollection<SyncDoc, SyncCheckpoint>({
            replicationIdentifier: `atoma:${args.ctx.clientId}:${resource.resource}`,
            collection,
            live: args.options.live,
            retryTime: args.options.retryTimeMs,
            waitForLeadership: args.options.waitForLeadership,
            autoStart: false,
            ...(pullEnabled
                ? {
                    pull: {
                        batchSize: args.options.pullBatchSize,
                        handler: async (checkpoint: SyncCheckpoint | undefined, batchSize: number) => {
                            const response = await args.options.transport.pull({
                                resource: resource.resource,
                                checkpoint,
                                batchSize
                            })

                            args.emitEvent({
                                type: 'sync.pull.batch',
                                resource: resource.resource,
                                size: response.documents.length,
                                cursor: response.checkpoint.cursor
                            })

                            return {
                                documents: response.documents.map((item) => toReplicationDocument(item)),
                                checkpoint: response.checkpoint
                            }
                        }
                    }
                }
                : {}),
            ...(pushEnabled
                ? {
                    push: {
                        batchSize: args.options.pushBatchSize,
                        handler: async (rows) => {
                            const response = await args.options.transport.push({
                                resource: resource.resource,
                                rows: rows.map((row) => ({
                                    newDocumentState: sanitizeOutgoingDocument(row.newDocumentState),
                                    assumedMasterState: row.assumedMasterState
                                        ? sanitizeOutgoingDocument(row.assumedMasterState)
                                        : null
                                }))
                            })

                            args.emitEvent({
                                type: 'sync.push.batch',
                                resource: resource.resource,
                                size: rows.length
                            })

                            if (response.conflicts.length > 0) {
                                args.emitEvent({
                                    type: 'sync.conflict.detected',
                                    resource: resource.resource,
                                    count: response.conflicts.length
                                })
                            }

                            return response.conflicts.map((item) => toReplicationDocument(item))
                        }
                    }
                }
                : {})
        })

        const subscriptions: Array<{ unsubscribe: () => void }> = []
        subscriptions.push(
            replication.error$.subscribe((error) => {
                args.reportError(error, 'lifecycle')
            })
        )
        subscriptions.push(
            replication.received$.subscribe((doc) => {
                void args.queueRemoteApply(async () => {
                    const incoming = sanitizeIncomingDocument(doc)
                    await applyRemoteDocument({
                        ctx: args.ctx,
                        runtime: args.runtime,
                        resource,
                        document: incoming,
                        emitEvent: args.emitEvent
                    })
                })
            })
        )

        const stream = args.options.streamEnabled && pullEnabled && typeof args.options.transport.subscribe === 'function'
            ? args.options.transport.subscribe({
                resource: resource.resource,
                reconnectDelayMs: args.options.streamReconnectDelayMs,
                pollIntervalMs: args.options.streamPollIntervalMs,
                onNotify: (notify) => {
                    args.emitEvent({
                        type: 'sync.stream.notify',
                        ...(notify.resource ? { resource: notify.resource } : {}),
                        ...(notify.cursor !== undefined ? { cursor: notify.cursor } : {})
                    })
                    replication.reSync()
                },
                onError: (error) => {
                    args.reportError(error, 'stream')
                }
            }) ?? null
            : null

        states.set(resource.resource, {
            resource,
            replication,
            pullEnabled,
            pushEnabled,
            stream,
            subscriptions
        })
    }

    return states
}

export async function startStates(states: ResourceStateMap): Promise<void> {
    for (const state of states.values()) {
        await state.replication.start()
        state.stream?.start()
    }
}

export async function pauseStates(states: ResourceStateMap): Promise<void> {
    for (const state of states.values()) {
        state.stream?.stop()
        await state.replication.pause()
    }
}

export async function disposeReplications(states: ResourceStateMap): Promise<void> {
    for (const state of states.values()) {
        state.stream?.dispose()
        while (state.subscriptions.length > 0) {
            try {
                state.subscriptions.pop()?.unsubscribe()
            } catch {
                // ignore
            }
        }

        try {
            await state.replication.cancel()
        } catch {
            // ignore
        }
    }
}

export async function waitReplicationsInSync(states: ReadonlyArray<ResourceReplication>): Promise<void> {
    await Promise.all(states.map(async (state) => {
        await Promise.race([
            state.replication.awaitInSync(),
            wait(15_000)
        ])
    }))
}
