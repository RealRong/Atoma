import type { Entity } from 'atoma-types/core'
import type { Runtime } from 'atoma-types/runtime'
import type {
    IntentCommand,
    PreparedWrite,
    PreparedWrites,
    WriteScope
} from '../contracts'
import { prepareCreate } from './create'
import { prepareUpdate } from './update'
import { prepareUpsert } from './upsert'
import { prepareDelete } from './delete'

function ensureUniqueIds<T extends Entity>(prepared: PreparedWrites<T>) {
    const seen = new Set<string>()
    prepared.forEach((item, index) => {
        const id = String(item.entry.item.id ?? '').trim()
        if (!id) return
        if (seen.has(id)) {
            throw new Error(`[Atoma] writeMany: duplicate item id in batch (id=${id}, index=${index})`)
        }
        seen.add(id)
    })
}

export async function prepare<T extends Entity>(
    runtime: Runtime,
    scope: WriteScope<T>,
    intents: ReadonlyArray<IntentCommand<T>>
): Promise<PreparedWrites<T>> {
    const prepared = await Promise.all(intents.map(async (intent): Promise<PreparedWrite<T>> => {
        switch (intent.action) {
            case 'create':
                return prepareCreate(runtime, scope, intent)
            case 'update':
                return prepareUpdate(runtime, scope, intent)
            case 'upsert':
                return prepareUpsert(runtime, scope, intent)
            case 'delete':
                return prepareDelete(runtime, scope, intent)
        }
    }))
    ensureUniqueIds(prepared)
    return prepared
}
