import type {
    Entity,
    OperationContext,
    WriteIntent,
    WriteIntentOptions
} from 'atoma-types/core'
import type {
    EntityId,
    WriteOptions
} from 'atoma-types/protocol'
import {
    buildWriteOp,
    createIdempotencyKey,
    ensureWriteItemMeta
} from 'atoma-types/protocol-tools'
import type { CoreRuntime, StoreHandle } from 'atoma-types/runtime'
import type { PersistPlan } from '../types'

type Group<T extends Entity> = {
    action: WriteIntent<T>['action']
    options?: WriteOptions
    intents: Array<WriteIntent<T>>
}

export class WriteOpsBuilder {
    buildWriteOps = async <T extends Entity>(args: {
        runtime: CoreRuntime
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

        const groupsByKey = new Map<string, Group<T>>()
        const groups: Array<Group<T>> = []

        for (const intent of normalized) {
            const options = intent.options ? this.buildWriteOptions(intent.options) : undefined
            const optionsKey = this.buildOptionsKey(options)
            const key = `${intent.action}::${optionsKey}`

            let group = groupsByKey.get(key)
            if (!group) {
                group = { action: intent.action, options, intents: [] }
                groupsByKey.set(key, group)
                groups.push(group)
            }
            group.intents.push(intent)
        }

        return groups.map(group => this.buildGroupPlan({ runtime, handle, group }))
    }

    private buildGroupPlan = <T extends Entity>(args: {
        runtime: CoreRuntime
        handle: StoreHandle<T>
        group: Group<T>
    }): PersistPlan<T>[number] => {
        const { runtime, handle, group } = args

        const items = group.intents.map(intent => {
            const now = runtime.now
            const meta = ensureWriteItemMeta({
                meta: {
                    idempotencyKey: createIdempotencyKey({ now }),
                    clientTimeMs: now()
                },
                now
            })

            if (intent.action === 'delete') {
                return {
                    entityId: intent.entityId as EntityId,
                    baseVersion: intent.baseVersion as number,
                    meta
                }
            }

            if (intent.action === 'update') {
                return {
                    entityId: intent.entityId as EntityId,
                    baseVersion: intent.baseVersion as number,
                    value: intent.value,
                    meta
                }
            }

            if (intent.action === 'upsert') {
                return {
                    entityId: intent.entityId as EntityId,
                    ...(typeof intent.baseVersion === 'number' ? { baseVersion: intent.baseVersion } : {}),
                    value: intent.value,
                    meta
                }
            }

            return {
                ...(intent.entityId ? { entityId: intent.entityId } : {}),
                value: intent.value,
                meta
            }
        })

        const op = buildWriteOp({
            opId: runtime.nextOpId(handle.storeName, 'w'),
            write: {
                resource: handle.storeName,
                action: group.action,
                items,
                ...(group.options ? { options: group.options } : {})
            }
        })

        return {
            op,
            intents: group.intents
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

    private buildOptionsKey = (options: WriteOptions | undefined): string => {
        if (!options) return ''
        const parts: string[] = []

        if (typeof options.returning === 'boolean') {
            parts.push(`r:${options.returning ? 1 : 0}`)
        }
        if (typeof options.merge === 'boolean') {
            parts.push(`m:${options.merge ? 1 : 0}`)
        }
        if (options.upsert?.mode === 'strict' || options.upsert?.mode === 'loose') {
            parts.push(`u:${options.upsert.mode}`)
        }

        const select = options.select
        if (select && typeof select === 'object') {
            const keys = Object.keys(select).sort()
            if (keys.length) {
                const encoded = keys.map(key => `${key}:${select[key] ? 1 : 0}`).join(',')
                parts.push(`s:${encoded}`)
            }
        }

        return parts.join('|')
    }
}
