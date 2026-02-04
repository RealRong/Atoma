import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { WriteOp } from 'atoma-types/protocol'
import type { StoreHandle } from 'atoma-types/runtime'
import type { CoreRuntime } from 'atoma-types/runtime'
import { entityId as entityIdUtils, immer as immerUtils, version } from 'atoma-shared'
import { applyPatches, type Patch } from 'immer'
import { buildWriteItem, buildWriteItemMeta, buildWriteOperation, buildWriteOptions } from './opsBuilder'

export async function buildWriteOps<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    intents: Array<Types.WriteIntent<T>>
    opContext: Types.OperationContext
}): Promise<Array<{ op: WriteOp; intents: Array<Types.WriteIntent<T>> }>> {
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
        } as Types.WriteIntent<T>
    }))

    type Group<T> = {
        action: Types.WriteIntent<T>['action']
        options?: ReturnType<typeof buildWriteOptions>
        intents: Array<Types.WriteIntent<T>>
    }

    const groupsByKey = new Map<string, Group<T>>()
    const groups: Group<T>[] = []

    for (const intent of normalized) {
        const options = intent.options ? buildWriteOptions(intent.options) : undefined
        const optionsKey = buildOptionsKey(options)
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
        const entries = group.intents.map(intent => {
            const meta = buildWriteItemMeta({ now: runtime.now })
            return {
                item: buildWriteItem(intent, meta)
            }
        })

        const op = buildWriteOperation({
            opId: handle.nextOpId('w'),
            resource: handle.storeName,
            action: group.action,
            items: entries.map(e => e.item),
            ...(group.options ? { options: group.options } : {})
        })

        return {
            op,
            intents: group.intents
        }
    })
}

function buildOptionsKey(options: ReturnType<typeof buildWriteOptions> | undefined): string {
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

export function buildWriteIntentsFromPatches<T extends Types.Entity>(args: {
    baseState: Map<EntityId, T>
    patches: Patch[]
    inversePatches: Patch[]
}): Types.WriteIntent<T>[] {
    const optimisticState = applyPatches(args.baseState, args.patches) as Map<EntityId, T>
    const touchedIds = new Set<EntityId>()
    args.patches.forEach(p => {
        const root = p.path?.[0]
        if (entityIdUtils.isEntityId(root)) touchedIds.add(root as EntityId)
    })

    const inverseRootAdds = immerUtils.collectInverseRootAddsByEntityId(args.inversePatches)
    const baseVersionByDeletedId = new Map<EntityId, number>()
    inverseRootAdds.forEach((value, id) => {
        baseVersionByDeletedId.set(id, version.requireBaseVersion(id, value))
    })

    const intents: Types.WriteIntent<T>[] = []
    for (const id of touchedIds.values()) {
        const next = optimisticState.get(id)
        if (next) {
            const baseVersion = version.resolvePositiveVersion(next)
            intents.push({
                action: 'upsert',
                entityId: id,
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: next,
                options: { merge: false, upsert: { mode: 'loose' } }
            })
            continue
        }

        const baseVersion = baseVersionByDeletedId.get(id)
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
            throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
        }
        intents.push({ action: 'delete', entityId: id, baseVersion })
    }

    return intents
}
