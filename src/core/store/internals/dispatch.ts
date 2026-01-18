import type { CoreRuntime, Entity, StoreDispatchEvent } from '../../types'

export function dispatch<T extends Entity>(clientRuntime: CoreRuntime, event: StoreDispatchEvent<T>) {
    clientRuntime.mutation.api.dispatch(event)
}
