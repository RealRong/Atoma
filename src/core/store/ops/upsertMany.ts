import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreOperationOptions, UpsertWriteOptions, WriteManyResult } from '../../types'
import { dispatch } from '../internals/dispatch'
import { ensureActionId } from '../internals/ensureActionId'
import { runAfterSave, runBeforeSave } from '../internals/hooks'
import { validateWithSchema } from '../internals/validation'
import { prepareForAdd, prepareForUpdate } from '../internals/writePipeline'

function toError(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) return reason
    if (typeof reason === 'string' && reason) return new Error(reason)
    try {
        return new Error(`${fallbackMessage}: ${JSON.stringify(reason)}`)
    } catch {
        return new Error(fallbackMessage)
    }
}

export function createUpsertMany<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, services, hooks } = handle

    return async (
        items: Array<PartialWithId<T>>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ): Promise<WriteManyResult<T>> => {
        const opContext = ensureActionId(options?.opContext)
        const results: WriteManyResult<T> = new Array(items.length)

        const firstIndexById = new Map<StoreKey, number>()
        for (let i = 0; i < items.length; i++) {
            const id = items[i]?.id
            if (firstIndexById.has(id)) {
                results[i] = {
                    index: i,
                    ok: false,
                    error: new Error(`Duplicate id in upsertMany: ${String(id)}`)
                }
                continue
            }
            firstIndexById.set(id, i)
        }

        const baseMap = jotaiStore.get(atom)
        const merge = options?.merge !== false

        const tasks: Array<Promise<void>> = []

        for (let index = 0; index < items.length; index++) {
            if (results[index]) continue

            const item = items[index]
            const id: StoreKey = item.id
            const base = baseMap.get(id) as PartialWithId<T> | undefined

            let validObj: PartialWithId<T>
            let action: 'add' | 'update'
            try {
                if (!base) {
                    action = 'add'
                    validObj = await prepareForAdd<T>(handle, item as any)
                } else if (merge) {
                    action = 'update'
                    validObj = await prepareForUpdate<T>(handle, base, item)
                } else {
                    action = 'update'
                    const createdAt = (base as any).createdAt ?? Date.now()
                    const candidate: any = {
                        ...(item as any),
                        id,
                        createdAt,
                        updatedAt: Date.now()
                    }

                    if (candidate.version === undefined && typeof (base as any).version === 'number') {
                        candidate.version = (base as any).version
                    }
                    if (candidate._etag === undefined && typeof (base as any)._etag === 'string') {
                        candidate._etag = (base as any)._etag
                    }

                    let next = await runBeforeSave(handle.hooks, candidate as any, 'update')
                    next = handle.transform(next as any) as any
                    next = await validateWithSchema(next as any, handle.schema as any)
                    validObj = next as PartialWithId<T>
                }
            } catch (error) {
                results[index] = { index, ok: false, error: toError(error, `Failed to prepare upsert for id ${String(id)}`) }
                continue
            }

            const { ticket } = services.mutation.runtime.beginWrite()

            const resultPromise = new Promise<T>((resolve, reject) => {
                dispatch<T>({
                    type: 'upsert',
                    data: validObj,
                    upsert: {
                        mode: options?.mode,
                        merge: options?.merge
                    },
                    handle,
                    opContext,
                    ticket,
                    onSuccess: async (o) => {
                        await runAfterSave(hooks, validObj, action)
                        resolve(o)
                    },
                    onFail: (error) => {
                        reject(error || new Error(`Failed to upsert item with id ${String(id)}`))
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
                    results[index] = { index, ok: false, error: toError(error, `Failed to upsert item with id ${String(id)}`) }
                })
            )
        }

        await Promise.all(tasks)
        return results
    }
}
