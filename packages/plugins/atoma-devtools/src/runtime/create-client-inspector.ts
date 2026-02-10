import type { DebugHub } from 'atoma-types/devtools'
import type { DevtoolsClientInspector } from './types'
import { inspectorForEntry } from './inspector'
import { ensureEntry, removeEntryById } from './registry'

type CreateClientDevtoolsArgs = {
    clientId: string
    hub: DebugHub
    label?: string
}

export function createClientInspector(args: CreateClientDevtoolsArgs): DevtoolsClientInspector & { dispose: () => void } {
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
