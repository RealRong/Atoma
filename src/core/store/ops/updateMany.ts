import { produce } from 'immer'
import type { Draft } from 'immer'
import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreOperationOptions, WriteManyResult } from '../../types'
import { bulkAdd } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { dispatch } from '../internals/dispatch'
import { toError } from '../internals/errors'
import { ensureActionId } from '../internals/ensureActionId'
import { runAfterSave } from '../internals/hooks'
import { resolveObservabilityContext } from '../internals/runtime'
import { validateWithSchema } from '../internals/validation'
import { prepareForUpdate } from '../internals/writePipeline'

export function createUpdateMany<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, dataSource, services, hooks, schema, transform } = handle

    return async (
        items: Array<{ id: StoreKey; recipe: (draft: Draft<T>) => void }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        const opContext = ensureActionId(options?.opContext)
        const observabilityContext = resolveObservabilityContext(handle, options)

        const results: WriteManyResult<T> = new Array(items.length)

        const firstIndexById = new Map<StoreKey, number>()
        for (let i = 0; i < items.length; i++) {
            const id = items[i]?.id
            if (firstIndexById.has(id)) {
                results[i] = {
                    index: i,
                    ok: false,
                    error: new Error(`Duplicate id in updateMany: ${String(id)}`)
                }
                continue
            }
            firstIndexById.set(id, i)
        }

        const before = jotaiStore.get(atom)
        const beforeMap = before as Map<StoreKey, T>
        const baseById = new Map<StoreKey, PartialWithId<T>>()
        const missing: StoreKey[] = []

        for (const id of firstIndexById.keys()) {
            const cached = beforeMap.get(id)
            if (cached) {
                baseById.set(id, cached as any)
                continue
            }
            missing.push(id)
        }

        if (missing.length) {
            const fetchedList = await dataSource.bulkGet(missing, observabilityContext)
            const toCache: Array<PartialWithId<T>> = []

            for (let i = 0; i < missing.length; i++) {
                const id = missing[i]
                const fetched = fetchedList[i]
                if (!fetched) continue
                const transformed = transform(fetched)
                const validFetched = await validateWithSchema(transformed, schema)
                baseById.set(id, validFetched as any)
                toCache.push(validFetched as any)
            }

            if (toCache.length) {
                const after = bulkAdd(toCache, beforeMap)
                if (after !== beforeMap) {
                    const changedIds = new Set<StoreKey>()
                    for (const item of toCache) {
                        const id = item.id as any as StoreKey
                        if (!beforeMap.has(id) || beforeMap.get(id) !== (item as any)) {
                            changedIds.add(id)
                        }
                    }
                    commitAtomMapUpdateDelta({ handle, before: beforeMap, after, changedIds })
                }
            }
        }

        const tasks: Array<Promise<void>> = []

        for (let index = 0; index < items.length; index++) {
            if (results[index]) continue

            const item = items[index]
            const id = item.id
            const base = baseById.get(id)
            if (!base) {
                results[index] = {
                    index,
                    ok: false,
                    error: new Error(`Item with id ${String(id)} not found`)
                }
                continue
            }

            let validObj: PartialWithId<T>
            try {
                const next = produce(base as any, (draft: Draft<T>) => item.recipe(draft)) as any
                const patched = { ...(next as any), id } as PartialWithId<T>
                validObj = await prepareForUpdate<T>(handle, base, patched)
            } catch (error) {
                results[index] = { index, ok: false, error: toError(error, `Failed to prepare update for id ${String(id)}`) }
                continue
            }

            const { ticket } = services.mutation.runtime.beginWrite()

            const resultPromise = new Promise<T>((resolve, reject) => {
                dispatch<T>({
                    type: 'update',
                    handle,
                    data: validObj,
                    opContext,
                    ticket,
                    onSuccess: async (updated) => {
                        await runAfterSave(hooks, validObj, 'update')
                        resolve(updated)
                    },
                    onFail: (error) => {
                        reject(error || new Error(`Failed to update item with id ${String(id)}`))
                    }
                })
            })

            tasks.push(
                Promise.all([
                    services.mutation.runtime.await(ticket, options),
                    resultPromise
                ]).then(([_awaited, value]) => {
                    results[index] = { index, ok: true, value }
                }).catch((error) => {
                    results[index] = { index, ok: false, error: toError(error, `Failed to update item with id ${String(id)}`) }
                })
            )
        }

        await Promise.all(tasks)
        return results
    }
}
