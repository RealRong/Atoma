import { produce } from 'immer'
import type { Draft } from 'immer'
import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreOperationOptions } from '../../types'
import { add } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { dispatch } from '../internals/dispatch'
import { runAfterSave } from '../internals/hooks'
import { resolveObservabilityContext } from '../internals/runtime'
import { ignoreTicketRejections } from '../internals/tickets'
import { validateWithSchema } from '../internals/validation'
import { prepareForUpdate } from '../internals/writePipeline'
import type { StoreWriteConfig } from '../internals/writeConfig'

export function createUpdateOne<T extends Entity>(handle: StoreHandle<T>, writeConfig: StoreWriteConfig) {
    const { jotaiStore, atom, dataSource, services, hooks, schema, transform } = handle
    return async (id: StoreKey, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions) => {
        const observabilityContext = resolveObservabilityContext(handle, options)

        const resolveBase = async (): Promise<PartialWithId<T>> => {
            const cached = jotaiStore.get(atom).get(id) as T | undefined
            if (cached) {
                return cached as unknown as PartialWithId<T>
            }

            if (!writeConfig.allowImplicitFetchForWrite) {
                throw new Error(`[Atoma] updateOne: 缓存缺失且当前写入模式禁止补读，请先 fetch 再 update（id=${String(id)}）`)
            }

            const data = await dataSource.get(id, observabilityContext)
            if (!data) {
                throw new Error(`Item with id ${id} not found`)
            }

            const transformed = transform(data)
            const validFetched = await validateWithSchema(transformed, schema)
            const before = jotaiStore.get(atom)
            const after = add(validFetched as PartialWithId<T>, before)
            commitAtomMapUpdateDelta({ handle, before, after, changedIds: [id] })
            return validFetched as unknown as PartialWithId<T>
        }

        const base = await resolveBase()

        const next = produce(base as any, (draft: Draft<T>) => recipe(draft)) as any
        const patched = { ...(next as any), id } as PartialWithId<T>
        const validObj = await prepareForUpdate<T>(handle, base, patched)

        const { ticket } = services.mutation.runtime.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            dispatch<T>({
                type: 'update',
                handle,
                data: validObj,
                opContext: options?.opContext,
                ticket,
                persist: writeConfig.persistMode,
                onSuccess: async updated => {
                    await runAfterSave(hooks, validObj, 'update')
                    resolve(updated)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to update item with id ${id}`))
                }
            })
        })

        const confirmation = options?.confirmation ?? 'optimistic'
        if (confirmation === 'optimistic') {
            ignoreTicketRejections(ticket)
            return resultPromise
        }

        await Promise.all([
            resultPromise,
            services.mutation.runtime.await(ticket, options)
        ])

        return resultPromise
    }
}
