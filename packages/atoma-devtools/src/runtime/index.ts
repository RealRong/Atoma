import type {
    DevtoolsGlobalInspector,
} from './types'
import { getEntryById, listEntries } from './registry'
import { inspectorForEntry } from './inspector'
import { createClientInspector } from './createClientInspector'

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

export const Devtools = {
    createClientInspector,

    global: (): DevtoolsGlobalInspector => {
        return {
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
    }
} as const
