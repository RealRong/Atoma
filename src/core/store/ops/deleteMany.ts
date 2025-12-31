import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreOperationOptions, WriteManyResult } from '../../types'
import { dispatch } from '../internals/dispatch'
import { toError } from '../internals/errors'
import { ensureActionId } from '../internals/ensureActionId'
import { ignoreTicketRejections } from '../internals/tickets'

export function createDeleteMany<T extends Entity>(handle: StoreHandle<T>) {
    const { services } = handle

    return async (ids: StoreKey[], options?: StoreOperationOptions): Promise<WriteManyResult<boolean>> => {
        const opContext = ensureActionId(options?.opContext)
        const confirmation = options?.confirmation ?? 'optimistic'
        const results: WriteManyResult<boolean> = new Array(ids.length)

        const firstIndexById = new Map<StoreKey, number>()
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

        const tasks: Array<Promise<void>> = []

        for (let index = 0; index < ids.length; index++) {
            if (results[index]) continue

            const id = ids[index]
            const { ticket } = services.mutation.runtime.beginWrite()

            const resultPromise = new Promise<boolean>((resolve, reject) => {
                dispatch<T>({
                    type: options?.force ? 'forceRemove' : 'remove',
                    data: { id } as PartialWithId<T>,
                    handle,
                    opContext,
                    ticket,
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
