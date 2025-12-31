import type { Entity, StoreDispatchEvent } from '../../types'

export function dispatch<T extends Entity>(event: StoreDispatchEvent<T>) {
    event.handle.services.mutation.runtime.dispatch(event)
}
