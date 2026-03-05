import type { GlobalInspector } from './types'
import { createClientInspector } from './create-client-inspector'
import { getEntryById, listEntries, subscribeEntries } from './registry'
import { inspectorForEntry } from './inspector'

export type {
    InspectorPanel,
    PanelSnapshot,
    ClientSnapshot,
    InspectorEvent,
    ClientInspector,
    GlobalInspector
} from './types'

export const Devtools = {
    createClientInspector,

    global: (): GlobalInspector => {
        return {
            clients: {
                list: () => {
                    return listEntries()
                        .map((client) => ({
                            id: client.id,
                            label: client.label,
                            createdAt: client.createdAt,
                            lastSeenAt: client.lastSeenAt
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
                    const clients = listEntries().map(entry => inspectorForEntry(entry).snapshot())
                    return { clients }
                },
                subscribe: (fn) => {
                    return subscribeEntries(fn)
                }
            }
        }
    }
} as const
