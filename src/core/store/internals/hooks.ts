import type { LifecycleHooks, PartialWithId } from '../../types'

export async function runBeforeSave<T>(
    hooks: LifecycleHooks<T> | undefined,
    item: PartialWithId<T>,
    action: 'add' | 'update'
): Promise<PartialWithId<T>> {
    if (hooks?.beforeSave) {
        return await hooks.beforeSave({ action, item })
    }
    return item
}

export async function runAfterSave<T>(
    hooks: LifecycleHooks<T> | undefined,
    item: PartialWithId<T>,
    action: 'add' | 'update'
): Promise<void> {
    if (hooks?.afterSave) {
        await hooks.afterSave({ action, item })
    }
}
