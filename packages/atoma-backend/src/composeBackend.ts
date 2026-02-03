import type { Endpoint } from 'atoma-types/client'
import { EndpointRegistry } from 'atoma-client'

export type ComposeBackendOptions = Readonly<{
    endpoints: Endpoint[]
}>

export function composeBackend(options: ComposeBackendOptions): EndpointRegistry {
    const registry = new EndpointRegistry()
    const list = Array.isArray(options.endpoints) ? options.endpoints : []
    for (const endpoint of list) {
        registry.register(endpoint)
    }
    return registry
}
