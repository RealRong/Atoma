import { DEBUG_HUB_TOKEN } from 'atoma-types/devtools'
import type { Runtime } from 'atoma-runtime'
import { createDebugHub } from '../debug/debugHub'
import { registerRuntimeDebugProviders } from '../debug/registerRuntimeDebugProviders'
import type { ServiceRegistry } from '../plugins/ServiceRegistry'

function installDebugHub(services: ServiceRegistry): (() => void) | undefined {
    const existing = services.resolve(DEBUG_HUB_TOKEN)
    if (existing) {
        return
    }
    return services.register(DEBUG_HUB_TOKEN, createDebugHub())
}

export function installDebugIntegration({
    services,
    runtime
}: {
    services: ServiceRegistry
    runtime: Runtime
}): Array<() => void> {
    const disposers: Array<() => void> = []

    const unregisterDebugHub = installDebugHub(services)
    if (unregisterDebugHub) {
        disposers.push(unregisterDebugHub)
    }

    const debugHub = services.resolve(DEBUG_HUB_TOKEN)
    if (debugHub) {
        disposers.push(registerRuntimeDebugProviders(runtime, debugHub))
    }

    return disposers
}
