import type { AtomaClient } from '../client/types'
import type {
    DevtoolsClientInspector,
    DevtoolsGlobalInspector,
    RegisterClientFromRuntimeArgs
} from './types'
import { enableRegistry, disableRegistry, ensureEntry, getEntryById, isRegistryEnabled, listEntries } from './registry'
import { attachHistoryProvider, attachRuntime, attachSyncProvider } from './runtimeAdapter'
import { inspectorForEntry } from './inspector'

export type {
    DevtoolsStoreSnapshot,
    DevtoolsIndexManagerSnapshot,
    DevtoolsSyncSnapshot,
    DevtoolsHistorySnapshot,
    DevtoolsClientSnapshot,
    DevtoolsEvent,
    DevtoolsClientInspector,
    DevtoolsGlobalInspector
} from './types'

const GLOBAL_HOOK_KEY = '__ATOMA_DEVTOOLS__'

function registerClientFromRuntime(args: RegisterClientFromRuntimeArgs) {
    if (!isRegistryEnabled()) return
    const entry = ensureEntry(args.client, { label: args.label, meta: args.meta })
    if (args.runtime) attachRuntime(entry, args.runtime)
    if (args.syncDevtools) attachSyncProvider(entry, args.syncDevtools)
    if (args.historyDevtools) attachHistoryProvider(entry, args.historyDevtools)
}

function installGlobalHook() {
    ;(globalThis as any)[GLOBAL_HOOK_KEY] = {
        registerClient: registerClientFromRuntime
    }
}

function uninstallGlobalHook() {
    try {
        delete (globalThis as any)[GLOBAL_HOOK_KEY]
    } catch {
        ;(globalThis as any)[GLOBAL_HOOK_KEY] = undefined
    }
}

export const devtools = {
    enableGlobal: () => {
        enableRegistry()
        installGlobalHook()
    },

    global: (): DevtoolsGlobalInspector => {
        return {
            enabled: isRegistryEnabled(),
            clients: {
                list: () => {
                    return listEntries()
                        .map(c => ({
                            id: c.id,
                            label: c.label,
                            createdAt: c.createdAt,
                            lastSeenAt: c.lastSeenAt
                        }))
                },
                get: (id: string) => {
                    const entry = getEntryById(String(id))
                    if (!entry) {
                        throw new Error(`[Atoma Devtools] client not found: ${String(id)}`)
                    }
                    return inspectorForEntry(entry)
                },
                snapshot: () => {
                    const clients = listEntries().map(e => inspectorForEntry(e).snapshot())
                    return { clients }
                }
            }
        }
    },

    inspect: (client: AtomaClient<any, any>, options?: { id?: string; label?: string }): DevtoolsClientInspector => {
        const entry = ensureEntry(client, { id: options?.id, label: options?.label })
        return inspectorForEntry(entry)
    },

    disableGlobal: () => {
        disableRegistry()
        uninstallGlobalHook()
    }
} as const
