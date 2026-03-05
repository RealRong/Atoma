import type { Hub } from 'atoma-types/devtools'
import type { ClientInspector } from './types'
import { inspectorForEntry } from './inspector'
import { ensureEntry, removeEntryById } from './registry'

type CreateClientArgs = {
    clientId: string
    hub: Hub
    label?: string
}

export function createClientInspector(args: CreateClientArgs): ClientInspector & { dispose: () => void } {
    const entry = ensureEntry({
        clientId: args.clientId,
        label: args.label,
        hub: args.hub
    })

    const inspector = inspectorForEntry(entry)

    const dispose = () => {
        try {
            removeEntryById(entry.id)
        } catch {
            // ignore
        }
    }

    return {
        ...inspector,
        dispose
    }
}
