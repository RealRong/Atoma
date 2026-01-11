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
import { ignoreTicketRejections } from '../internals/tickets'
import { validateWithSchema } from '../internals/validation'
import { prepareForUpdate } from '../internals/writePipeline'
import type { StoreWriteConfig } from '../internals/writeConfig'

export function createUpdateMany<T extends Entity>(handle: StoreHandle<T>, writeConfig: StoreWriteConfig) {
    const { jotaiStore, atom, dataSource, services, hooks, schema, transform } = handle

    return async (
        items: Array<{ id: StoreKey; recipe: (draft: Draft<T>) => void }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        const opContext = ensureActionId(options?.opContext)
        const confirmation = options?.confirmation ?? 'optimistic'
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
            if (!writeConfig.allowImplicitFetchForWrite) {
                for (const id of missing) {
                    const firstIndex = firstIndexById.get(id)
                    if (typeof firstIndex !== 'number') continue
                    results[firstIndex] = {
                        index: firstIndex,
                        ok: false,
                        error: new Error(`[Atoma] updateMany: 缓存缺失且当前写入模式禁止补读，请先 fetch 再 update（id=${String(id)}）`)
                    }
                }
            } else {
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
        }

        const prepared: Array<{ index: number; id: StoreKey; value: PartialWithId<T> }> = []

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

            prepared.push({ index, id, value: validObj })
        }

        const tasks: Array<Promise<void>> = []

        for (const entry of prepared) {
            const index = entry.index
            const id = entry.id
            const validObj = entry.value

            const { ticket } = services.mutation.runtime.beginWrite()

            const resultPromise = new Promise<T>((resolve, reject) => {
                dispatch<T>({
                    type: 'update',
                    handle,
                    data: validObj,
                    opContext,
                    ticket,
                    persist: writeConfig.persistMode,
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
                (confirmation === 'optimistic'
                    ? (() => {
                        ignoreTicketRejections(ticket)
                        return resultPromise
                    })()
                    : Promise.all([
                        resultPromise,
                        services.mutation.runtime.await(ticket, options)
                    ]).then(([value]) => value)
                ).then((value) => {
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
