import { createStores } from 'atoma-sync'
import type { AtomaClientSyncConfig } from '#client/types'
import type { CursorStore, OutboxEvents, OutboxReader } from 'atoma-sync'
import type { OutboxWriter } from '#core'
import { Shared } from '#shared'

const { parseOrThrow, z } = Shared.zod

const resolvedSyncWiringSchema = z.object({
    queue: z.union([z.literal('queue'), z.literal('local-first')]).optional(),
    outboxStore: z.any().optional(),
    cursorStore: z.any().optional(),
    lockKey: z.string().trim().min(1).optional()
})
    .loose()
    .superRefine((value, ctx) => {
        if (!value.cursorStore) {
            ctx.addIssue({ code: 'custom', message: 'sync cursor store 未配置' })
        }
        if (value.queue && !value.outboxStore) {
            ctx.addIssue({ code: 'custom', message: 'sync outbox store 未配置' })
        }
    })

export type ResolvedSyncWiring = Readonly<{
    queue?: 'queue' | 'local-first'
    outboxStore?: OutboxWriter & OutboxReader & OutboxEvents
    cursorStore?: CursorStore
    lockKey?: string
}>

export function resolveSyncWiring(args: {
    syncConfig?: AtomaClientSyncConfig
}): ResolvedSyncWiring {
    const syncConfig = args.syncConfig
    if (!syncConfig) return {}

    const outboxEnabled = syncConfig.outbox !== false
    const queue = outboxEnabled
        ? (syncConfig.outbox.mode === 'local-first' ? 'local-first' : 'queue')
        : undefined

    const stores = createStores({
        outboxKey: syncConfig.state.keys.outbox,
        cursorKey: syncConfig.state.keys.cursor,
        queueEnabled: outboxEnabled,
        queueMode: queue,
        maxQueueSize: outboxEnabled ? syncConfig.outbox.storage.maxSize : undefined,
        outboxEvents: outboxEnabled ? syncConfig.outbox.events : undefined,
        now: syncConfig.engine.now,
        inFlightTimeoutMs: outboxEnabled ? syncConfig.outbox.storage.inFlightTimeoutMs : undefined
    })

    const outboxStore = queue ? stores.outbox : undefined
    const cursorStore = stores.cursor

    return parseOrThrow(resolvedSyncWiringSchema, {
        queue,
        outboxStore,
        cursorStore,
        lockKey: syncConfig.state.keys.lock
    }, { prefix: '[Atoma] createClient: ' }) as any
}
