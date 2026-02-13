import { DEBUG_HUB_CAPABILITY } from 'atoma-types/devtools'
import { Runtime } from 'atoma-runtime'
import { createDebugHub } from '../debug/debugHub'
import { registerRuntimeDebugProviders } from '../debug/registerRuntimeDebugProviders'
import { CapabilitiesRegistry } from '../plugins/CapabilitiesRegistry'

function installDebugHub(capabilities: CapabilitiesRegistry): (() => void) | undefined {
    const existing = capabilities.get(DEBUG_HUB_CAPABILITY)
    if (existing) {
        return
    }
    return capabilities.register(DEBUG_HUB_CAPABILITY, createDebugHub())
}

export function installDebugIntegration({
    capabilities,
    runtime
}: {
    capabilities: CapabilitiesRegistry
    runtime: Runtime
}): Array<() => void> {
    const disposers: Array<() => void> = []

    const unregisterDebugHub = installDebugHub(capabilities)
    if (unregisterDebugHub) {
        disposers.push(unregisterDebugHub)
    }

    const debugHub = capabilities.get(DEBUG_HUB_CAPABILITY)
    if (debugHub) {
        disposers.push(registerRuntimeDebugProviders(runtime, debugHub))
    }

    return disposers
}
