import type { CoreRuntime, Entity, PartialWithId, StoreOperationOptions, UpsertWriteOptions } from '../../types'
import type { StoreHandle } from '../internals/handleTypes'

export function createUpsertOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    const { jotaiStore, atom, hooks } = handle
    const write = clientRuntime.write

    return async (
        item: PartialWithId<T>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ): Promise<T> => {
        const id = item.id
        const base = jotaiStore.get(atom).get(id) as PartialWithId<T> | undefined
        const merge = options?.merge !== false

        const validObj = await (async () => {
            if (!base) {
                return await write.prepareForAdd<T>(handle, item as any, options?.opContext)
            }

            if (merge) {
                return await write.prepareForUpdate<T>(handle, base, item, options?.opContext)
            }

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

            let next = await write.runBeforeSave(handle.hooks, candidate as any, 'update')
            const processed = await clientRuntime.transform.inbound(handle, next as any, options?.opContext)
            if (!processed) {
                throw new Error('[Atoma] upsertOne: transform returned empty')
            }
            return processed as PartialWithId<T>
        })()

        const { ticket } = clientRuntime.mutation.begin()
        const writeStrategy = write.resolveWriteStrategy(handle, options)

        const resultPromise = new Promise<T>((resolve, reject) => {
            write.dispatch<T>({
                type: 'upsert',
                data: validObj,
                upsert: {
                    mode: options?.mode,
                    merge: options?.merge
                },
                handle,
                opContext: options?.opContext,
                ticket,
                writeStrategy,
                onSuccess: async (o) => {
                    await write.runAfterSave(hooks, validObj, base ? 'update' : 'add')
                    resolve(o)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to upsert item with id ${String(id)}`))
                }
            })
        })

        const confirmation = options?.confirmation ?? 'optimistic'
        if (confirmation === 'optimistic') {
            write.ignoreTicketRejections(ticket)
            return resultPromise
        }

        await Promise.all([
            resultPromise,
            clientRuntime.mutation.await(ticket, options)
        ])

        return resultPromise
    }
}
