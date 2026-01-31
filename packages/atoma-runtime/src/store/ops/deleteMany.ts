import type { CoreRuntime, Entity, PartialWithId, StoreOperationOptions, WriteManyResult } from 'atoma-core/internal'
import type { EntityId } from 'atoma-protocol'
import { toErrorWithFallback as toError } from 'atoma-shared'
import { resolveObservabilityContext } from '../internals/storeHandleManager'
import type { StoreHandle } from 'atoma-core/internal'

export function createDeleteMany<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    const { jotaiStore, atom } = handle
    const write = clientRuntime.write

    return async (ids: EntityId[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        const opContext = write.ensureActionId(options?.opContext)
        const writeStrategy = write.resolveWriteStrategy(handle, options)
        const allowImplicitFetchForWrite = write.allowImplicitFetchForWrite(writeStrategy)
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
            if (!allowImplicitFetchForWrite) {
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
                const { data } = await clientRuntime.io.query(handle, {
                    filter: { op: 'in', field: 'id', values: missing }
                }, observabilityContext)
                const toHydrate: Array<PartialWithId<T>> = []

                for (const fetched of data) {
                    if (!fetched) continue
                    const processed = await clientRuntime.transform.writeback(handle, fetched as T, opContext)
                    if (!processed) continue
                    const id = (processed as any).id as EntityId
                    hydratedIds.add(id)
                    toHydrate.push(processed as any)
                }

                if (toHydrate.length) {
                    write.dispatch<T>({
                        type: 'hydrateMany',
                        handle,
                        items: toHydrate,
                        opContext,
                        writeStrategy
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
            const { ticket } = clientRuntime.mutation.begin()

            const resultPromise = new Promise<boolean>((resolve, reject) => {
                write.dispatch<T>({
                    type: options?.force ? 'forceRemove' : 'remove',
                    data: { id } as PartialWithId<T>,
                    handle,
                    opContext,
                    ticket,
                    writeStrategy,
                    onSuccess: () => resolve(true),
                    onFail: (error) => reject(error || new Error(`Failed to delete item with id ${String(id)}`))
                })
            })

            tasks.push(
                (confirmation === 'optimistic'
                    ? (() => {
                        write.ignoreTicketRejections(ticket)
                        return resultPromise
                    })()
                    : Promise.all([
                        clientRuntime.mutation.await(ticket, options),
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
