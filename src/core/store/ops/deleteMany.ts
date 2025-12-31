import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreOperationOptions, WriteManyResult } from '../../types'
import { dispatch } from '../internals/dispatch'
import { ensureActionId } from '../internals/ensureActionId'

function toError(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) return reason
    if (typeof reason === 'string' && reason) return new Error(reason)
    try {
        return new Error(`${fallbackMessage}: ${JSON.stringify(reason)}`)
    } catch {
        return new Error(fallbackMessage)
    }
}

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
                        void ticket.enqueued.catch(() => {
                            // avoid unhandled rejection when optimistic writes never await enqueued
                        })
                        void ticket.confirmed.catch(() => {
                            // avoid unhandled rejection when optimistic writes never await confirmed
                        })
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
