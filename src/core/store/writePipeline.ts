import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId } from '../types'
import { runBeforeSave } from './hooks'
import { validateWithSchema } from './validation'
import type { StoreRuntime } from './runtime'

export async function prepareForAdd<T extends Entity>(
    runtime: StoreRuntime<T>,
    item: Partial<T>
): Promise<PartialWithId<T>> {
    let initedObj = BaseStore.initBaseObject(item, runtime.idGenerator) as unknown as PartialWithId<T>
    initedObj = await runBeforeSave(runtime.hooks, initedObj, 'add')
    initedObj = runtime.transform(initedObj as T) as unknown as PartialWithId<T>
    initedObj = await validateWithSchema(initedObj as T, runtime.schema) as unknown as PartialWithId<T>
    return initedObj
}

export async function prepareForUpdate<T extends Entity>(
    runtime: StoreRuntime<T>,
    base: PartialWithId<T>,
    patch: PartialWithId<T>
): Promise<PartialWithId<T>> {
    let merged = Object.assign({}, base, patch, {
        updatedAt: Date.now(),
        createdAt: (base as any).createdAt ?? Date.now(),
        id: patch.id
    }) as PartialWithId<T>

    merged = await runBeforeSave(runtime.hooks, merged, 'update')
    merged = runtime.transform(merged as T) as unknown as PartialWithId<T>
    merged = await validateWithSchema(merged as T, runtime.schema) as unknown as PartialWithId<T>
    return merged
}
