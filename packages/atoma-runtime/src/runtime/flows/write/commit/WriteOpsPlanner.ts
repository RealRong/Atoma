import type { Entity, OperationContext, WriteIntent } from 'atoma-types/core'
import type { CoreRuntime, StoreHandle } from 'atoma-types/runtime'
import { buildWriteItem, buildWriteItemMeta, buildWriteOperation, buildWriteOptions } from './opsBuilder'
import type { PersistPlan } from '../types'

export class WriteOpsPlanner {
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

        type Group = {
            action: WriteIntent<T>['action']
            options?: ReturnType<typeof buildWriteOptions>
            intents: Array<WriteIntent<T>>
        }

        const groupsByKey = new Map<string, Group>()
        const groups: Group[] = []

        for (const intent of normalized) {
            const options = intent.options ? buildWriteOptions(intent.options) : undefined
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

        return groups.map(group => {
            const items = group.intents.map(intent => {
                const meta = buildWriteItemMeta({ now: runtime.now })
                return buildWriteItem(intent, meta)
            })

            const op = buildWriteOperation({
                opId: runtime.nextOpId(handle.storeName, 'w'),
                resource: handle.storeName,
                action: group.action,
                items,
                ...(group.options ? { options: group.options } : {})
            })

            return {
                op,
                intents: group.intents
            }
        })
    }

    private buildOptionsKey = (options: ReturnType<typeof buildWriteOptions> | undefined): string => {
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
