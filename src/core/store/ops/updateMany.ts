import { produce } from 'immer'
import type { Draft } from 'immer'
import type { CoreRuntime, Entity, PartialWithId, StoreOperationOptions, WriteManyResult } from '../../types'
import type { EntityId } from '#protocol'
import { dispatch } from '../internals/dispatch'
import { toErrorWithFallback as toError } from '#shared'
import { runAfterSave } from '../internals/hooks'
import { resolveObservabilityContext } from '../internals/runtime'
import { validateWithSchema } from '../internals/validation'
import { ensureActionId, ignoreTicketRejections, prepareForUpdate, type StoreWriteConfig } from '../internals/writePipeline'
import { executeQuery } from '../../ops/opsExecutor'
import type { StoreHandle } from '../internals/handleTypes'

export function createUpdateMany<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    const { jotaiStore, atom, hooks, schema, transform } = handle

    return async (
        items: Array<{ id: EntityId; recipe: (draft: Draft<T>) => void }>,
        options?: StoreOperationOptions
    ): Promise<WriteManyResult<T>> => {
        const opContext = ensureActionId(options?.opContext)
        const confirmation = options?.confirmation ?? 'optimistic'
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, options)

        const results: WriteManyResult<T> = new Array(items.length)

        const firstIndexById = new Map<EntityId, number>()
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
        const beforeMap = before as Map<EntityId, T>
        const baseById = new Map<EntityId, PartialWithId<T>>()
        const missing: EntityId[] = []

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
                const { data } = await executeQuery(clientRuntime, handle, { where: { id: { in: missing } } } as any, observabilityContext)
                const toHydrate: Array<PartialWithId<T>> = []

                for (const fetched of data) {
                    if (!fetched) continue
                    const transformed = transform(fetched as T)
                    const validFetched = await validateWithSchema(transformed, schema)
                    const id = (validFetched as any).id as EntityId
                    baseById.set(id, validFetched as any)
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
            }
        }

        const prepared: Array<{ index: number; id: EntityId; value: PartialWithId<T> }> = []

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

            const { ticket } = clientRuntime.mutation.api.beginWrite()

            const resultPromise = new Promise<T>((resolve, reject) => {
                dispatch<T>(clientRuntime, {
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
                        clientRuntime.mutation.api.awaitTicket(ticket, options)
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
