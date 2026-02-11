import type {
    Entity,
    OperationContext,
    WriteIntent,
    WriteIntentOptions
} from 'atoma-types/core'
import type {
    EntityId,
    WriteEntry,
    WriteOptions
} from 'atoma-types/protocol'
import {
    createIdempotencyKey,
    ensureWriteItemMeta
} from 'atoma-types/protocol-tools'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'
import type { PersistPlan } from '../types'

export class WriteOpsBuilder {
    buildWriteEntries = async <T extends Entity>(args: {
        runtime: Runtime
        handle: StoreHandle<T>
        intents: Array<WriteIntent<T>>
        opContext: OperationContext
    }): Promise<PersistPlan<T>> => {
        const { runtime, handle, intents, opContext } = args
        if (!intents.length) return []

        const normalized = await Promise.all(intents.map(async intent => {
            if (intent.action === 'delete') return intent
            if (intent.value === undefined) {
                throw new Error(`[Atoma] write intent missing value for ${intent.action}`)
            }

            const outbound = await runtime.transform.outbound(handle, intent.value as T, opContext)
            if (outbound === undefined) {
                throw new Error('[Atoma] transform returned empty for outbound write')
            }

            return {
                ...intent,
                value: outbound
            } as WriteIntent<T>
        }))

        return normalized.map(intent => this.buildPlanEntry({ runtime, handle, intent }))
    }

    private buildPlanEntry = <T extends Entity>(args: {
        runtime: Runtime
        handle: StoreHandle<T>
        intent: WriteIntent<T>
    }): PersistPlan<T>[number] => {
        const { runtime, handle, intent } = args
        const now = runtime.now
        const meta = ensureWriteItemMeta({
            meta: {
                idempotencyKey: createIdempotencyKey({ now }),
                clientTimeMs: now()
            },
            now
        })

        const entry: WriteEntry = intent.action === 'delete'
            ? {
                entryId: runtime.nextOpId(handle.storeName, 'w'),
                action: 'delete',
                item: {
                    entityId: intent.entityId as EntityId,
                    baseVersion: intent.baseVersion as number,
                    meta
                }
            }
            : intent.action === 'update'
                ? {
                    entryId: runtime.nextOpId(handle.storeName, 'w'),
                    action: 'update',
                    item: {
                        entityId: intent.entityId as EntityId,
                        baseVersion: intent.baseVersion as number,
                        value: intent.value,
                        meta
                    }
                }
                : intent.action === 'upsert'
                    ? {
                        entryId: runtime.nextOpId(handle.storeName, 'w'),
                        action: 'upsert',
                        item: {
                            entityId: intent.entityId as EntityId,
                            ...(typeof intent.baseVersion === 'number' ? { baseVersion: intent.baseVersion } : {}),
                            value: intent.value,
                            meta
                        }
                    }
                    : {
                        entryId: runtime.nextOpId(handle.storeName, 'w'),
                        action: 'create',
                        item: {
                            ...(intent.entityId ? { entityId: intent.entityId } : {}),
                            value: intent.value,
                            meta
                        }
                    }

        const options = intent.options ? this.buildWriteOptions(intent.options) : undefined
        if (options) {
            ;(entry as any).options = options
        }

        return {
            entry,
            intent
        }
    }

    private buildWriteOptions(options?: WriteIntentOptions): WriteOptions | undefined {
        if (!options) return undefined

        const out: WriteOptions = {}
        if (typeof options.merge === 'boolean') out.merge = options.merge
        if (options.upsert?.mode === 'strict' || options.upsert?.mode === 'loose') {
            out.upsert = { mode: options.upsert.mode }
        }

        return Object.keys(out).length ? out : undefined
    }
}
