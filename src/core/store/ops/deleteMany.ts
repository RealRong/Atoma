import type { Entity, PartialWithId, StoreHandle, StoreOperationOptions, WriteManyResult } from '../../types'
import type { EntityId } from '#protocol'
import { bulkAdd } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { dispatch } from '../internals/dispatch'
import { toError } from '../internals/errors'
import { ensureActionId } from '../internals/ensureActionId'
import { resolveObservabilityContext } from '../internals/runtime'
import { ignoreTicketRejections } from '../internals/tickets'
import { validateWithSchema } from '../internals/validation'
import type { StoreWriteConfig } from '../internals/writeConfig'
import { executeQuery } from '../internals/opsExecutor'

export function createDeleteMany<T extends Entity>(handle: StoreHandle<T>, writeConfig: StoreWriteConfig) {
    const { jotaiStore, atom, services, schema, transform } = handle

    return async (ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        const opContext = ensureActionId(options?.opContext)
        const confirmation = options?.confirmation ?? 'optimistic'
        const observabilityContext = resolveObservabilityContext(handle, options)
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
                const { data } = await executeQuery(handle, { where: { id: { in: missing } } } as any, observabilityContext)
                const toCache: Array<PartialWithId<T>> = []

                for (const fetched of data) {
                    if (!fetched) continue
                    const transformed = transform(fetched as T)
                    const validFetched = await validateWithSchema(transformed, schema)
                    toCache.push(validFetched as any)
                }

                if (toCache.length) {
                    const after = bulkAdd(toCache, beforeMap)
                    if (after !== beforeMap) {
                        const changedIds = new Set<EntityId>()
                        for (const item of toCache) {
                            const id = item.id as any as EntityId
                            if (!beforeMap.has(id) || beforeMap.get(id) !== (item as any)) {
                                changedIds.add(id)
                            }
                        }
                        commitAtomMapUpdateDelta({ handle, before: beforeMap, after, changedIds })
                    }
                }

                for (const id of missing) {
                    const firstIndex = firstIndexById.get(id)
                    if (typeof firstIndex !== 'number') continue
                    const now = jotaiStore.get(atom).get(id)
                    if (now) continue
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
            if (options?.force && !jotaiStore.get(atom).has(id)) {
                results[index] = {
                    index,
                    ok: false,
                    error: new Error(`[Atoma] force delete requires cached item version; please fetch first (id=${String(id)})`)
                }
                continue
            }
            const { ticket } = services.mutation.runtime.beginWrite()

            const resultPromise = new Promise<boolean>((resolve, reject) => {
                dispatch<T>({
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
                        services.mutation.runtime.await(ticket, options),
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
