import type { ClientRuntime, Entity, StoreDispatchEvent } from '../../types'

export function dispatch<T extends Entity>(clientRuntime: ClientRuntime, event: StoreDispatchEvent<T>) {
    clientRuntime.mutation.api.dispatch(event)
}
