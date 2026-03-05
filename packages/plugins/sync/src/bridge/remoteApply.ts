import type { PluginContext } from '@atoma-js/types/client/plugins'
import type { SyncEvent } from '@atoma-js/types/sync'
import { documentCodec } from '../mapping/document'
import type { ReadyRuntime, SyncDoc, SyncResourceRuntime } from '../runtime/contracts'
import { readVersion } from '../utils/common'

export async function applyRemoteDocument(args: {
    ctx: PluginContext
    runtime: ReadyRuntime
    resource: SyncResourceRuntime
    document: SyncDoc
    emitEvent: (event: SyncEvent) => void
}): Promise<void> {
    const id = String(args.document.id ?? '')
    if (!id) return

    const incomingVersion = readVersion(args.document.version) ?? 1
    const local = args.ctx.runtime.stores.peek(args.resource.storeName, id) as Record<string, unknown> | undefined
    const localVersion = readVersion(local?.version)

    const session = args.ctx.runtime.stores.use(args.resource.storeName)
    if (args.document._deleted === true) {
        if (localVersion !== undefined && localVersion > incomingVersion) return

        await session.reconcile(
            {
                mode: 'remove',
                ids: [id]
            },
            {
                context: {
                    origin: 'sync',
                    scope: 'sync',
                    label: 'sync.rxdb.writeback'
                }
            }
        )

        args.emitEvent({
            type: 'sync.bridge.remoteWriteback',
            resource: args.resource.resource,
            upserts: 0,
            removes: 1
        })
        return
    }

    if (localVersion !== undefined && localVersion >= incomingVersion) {
        return
    }

    await session.reconcile(
        {
            mode: 'upsert',
            items: [documentCodec.toRuntimeEntity(args.document)]
        },
        {
            context: {
                origin: 'sync',
                scope: 'sync',
                label: 'sync.rxdb.writeback'
            }
        }
    )

    args.emitEvent({
        type: 'sync.bridge.remoteWriteback',
        resource: args.resource.resource,
        upserts: 1,
        removes: 0
    })
}
