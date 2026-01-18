import type { ClientRuntime, Entity, PartialWithId, StoreHandle, StoreOperationOptions, UpsertWriteOptions, WriteManyResult } from '../../types'
import type { EntityId } from '#protocol'
import { dispatch } from '../internals/dispatch'
import { toError } from '../internals/errors'
import { ensureActionId } from '../internals/ensureActionId'
import { runAfterSave, runBeforeSave } from '../internals/hooks'
import { ignoreTicketRejections } from '../internals/tickets'
import { validateWithSchema } from '../internals/validation'
import { prepareForAdd, prepareForUpdate } from '../internals/writePipeline'
import type { StoreWriteConfig } from '../internals/writeConfig'

export function createUpsertMany<T extends Entity>(
    clientRuntime: ClientRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    const { jotaiStore, atom, hooks } = handle

    return async (
        items: Array<PartialWithId<T>>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ): Promise<WriteManyResult<T>> => {
        const opContext = ensureActionId(options?.opContext)
        const confirmation = options?.confirmation ?? 'optimistic'
        const results: WriteManyResult<T> = new Array(items.length)

        const firstIndexById = new Map<EntityId, number>()
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

        const prepared: Array<{ index: number; id: EntityId; value: PartialWithId<T>; action: 'add' | 'update' }> = []

        for (let index = 0; index < items.length; index++) {
            if (results[index]) continue

            const item = items[index]
            const id: EntityId = item.id
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
                    const now = Date.now()
                    const createdAt = (base as any).createdAt ?? now
                    const candidate: any = {
                        ...(item as any),
                        id,
                        createdAt,
                        updatedAt: now
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

            prepared.push({ index, id, value: validObj, action })
        }

        const tasks: Array<Promise<void>> = []

        for (const entry of prepared) {
            const index = entry.index
            const id = entry.id
            const validObj = entry.value
            const action = entry.action

            const { ticket } = clientRuntime.mutation.api.beginWrite()

            const resultPromise = new Promise<T>((resolve, reject) => {
                dispatch<T>(clientRuntime, {
                    type: 'upsert',
                    data: validObj,
                    upsert: {
                        mode: options?.mode,
                        merge: options?.merge
                    },
                    handle,
                    opContext,
                    ticket,
                    persist: writeConfig.persistMode,
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
                    results[index] = { index, ok: false, error: toError(error, `Failed to upsert item with id ${String(id)}`) }
                })
            )
        }

        await Promise.all(tasks)
        return results
    }
}
