import type { ClientRuntime, Entity, PartialWithId, StoreHandle, StoreOperationOptions, WriteManyResult } from '../../types'
import type { EntityId } from '#protocol'
import { dispatch } from '../internals/dispatch'
import { toError } from '../internals/errors'
import { ensureActionId } from '../internals/ensureActionId'
import { resolveObservabilityContext } from '../internals/runtime'
import { ignoreTicketRejections } from '../internals/tickets'
import { validateWithSchema } from '../internals/validation'
import type { StoreWriteConfig } from '../internals/writeConfig'
import { executeQuery } from '../internals/opsExecutor'

export function createDeleteMany<T extends Entity>(
    clientRuntime: ClientRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    const { jotaiStore, atom, schema, transform } = handle

    return async (ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        const opContext = ensureActionId(options?.opContext)
        const confirmation = options?.confirmation ?? 'optimistic'
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, options)
        const results: WriteManyResult<boolean> = new Array(ids.length)

        const firstIndexById = new Map<EntityId, number>()
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            if (firstIndexById.has(id)) {
                results[i] = {
                    index: i,
                    ok: false,
                    error: new Error(`Duplicate id in deleteMany: ${String(id)}`)
                }
                continue
            }
            firstIndexById.set(id, i)
        }

        const before = jotaiStore.get(atom)
        const beforeMap = before as Map<EntityId, T>
        const missing: EntityId[] = []
        const hydratedIds = new Set<EntityId>()

        for (const id of firstIndexById.keys()) {
            const cached = beforeMap.get(id)
            if (cached) continue
            missing.push(id)
        }

        if (missing.length) {
            if (!writeConfig.allowImplicitFetchForWrite) {
                for (const id of missing) {
                    const firstIndex = firstIndexById.get(id)
                    if (typeof firstIndex !== 'number') continue
                    results[firstIndex] = {
                        index: firstIndex,
                        ok: false,
                        error: new Error(`[Atoma] deleteMany: 缓存缺失且当前写入模式禁止补读，请先 fetch 再 delete（id=${String(id)}）`)
                    }
                }
            } else {
                const { data } = await executeQuery(clientRuntime, handle, { where: { id: { in: missing } } } as any, observabilityContext)
                const toHydrate: Array<PartialWithId<T>> = []

                for (const fetched of data) {
                    if (!fetched) continue
                    const transformed = transform(fetched as T)
                    const validFetched = await validateWithSchema(transformed, schema)
                    const id = (validFetched as any).id as EntityId
                    hydratedIds.add(id)
                    toHydrate.push(validFetched as any)
                }

                if (toHydrate.length) {
                    dispatch<T>(clientRuntime, {
                        type: 'hydrateMany',
                        handle,
                        items: toHydrate,
                        opContext,
                        persist: writeConfig.persistMode
                    })
                }

                for (const id of missing) {
                    const firstIndex = firstIndexById.get(id)
                    if (typeof firstIndex !== 'number') continue
                    if (hydratedIds.has(id)) continue
                    results[firstIndex] = {
                        index: firstIndex,
                        ok: false,
                        error: new Error(`Item with id ${String(id)} not found`)
                    }
                }
            }
        }

        const tasks: Array<Promise<void>> = []

        for (let index = 0; index < ids.length; index++) {
            if (results[index]) continue

            const id = ids[index]
            if (options?.force && !(beforeMap.has(id) || hydratedIds.has(id))) {
                results[index] = {
                    index,
                    ok: false,
                    error: new Error(`[Atoma] force delete requires cached item version; please fetch first (id=${String(id)})`)
                }
                continue
            }
            const { ticket } = clientRuntime.mutation.api.beginWrite()

            const resultPromise = new Promise<boolean>((resolve, reject) => {
                dispatch<T>(clientRuntime, {
                    type: options?.force ? 'forceRemove' : 'remove',
                    data: { id } as PartialWithId<T>,
                    handle,
                    opContext,
                    ticket,
                    persist: writeConfig.persistMode,
                    onSuccess: () => resolve(true),
                    onFail: (error) => reject(error || new Error(`Failed to delete item with id ${String(id)}`))
                })
            })

            tasks.push(
                (confirmation === 'optimistic'
                    ? (() => {
                        ignoreTicketRejections(ticket)
                        return resultPromise
                    })()
                    : Promise.all([
                        clientRuntime.mutation.api.awaitTicket(ticket, options),
                        resultPromise
                    ]).then(([_awaited, value]) => value)
                ).then((value) => {
                    results[index] = { index, ok: true, value }
                }).catch((error) => {
                    results[index] = { index, ok: false, error: toError(error, `Failed to delete item with id ${String(id)}`) }
                })
            )
        }

        await Promise.all(tasks)
        return results
    }
}
