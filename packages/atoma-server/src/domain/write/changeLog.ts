import type { ChangeKind } from 'atoma-types/protocol'
import type { AtomaChange, ISyncAdapter } from '../../adapters/ports'

export type ChangeLogEntry = {
    resource: string
    id: string
    kind: ChangeKind
    serverVersion: number
    changedAt: number
}

export async function appendChangeIfEnabled(args: {
    syncEnabled: boolean
    sync?: ISyncAdapter
    tx?: unknown
    entry: ChangeLogEntry
}): Promise<AtomaChange | undefined> {
    if (!args.syncEnabled) return undefined

    return args.sync!.appendChange({
        resource: args.entry.resource,
        id: args.entry.id,
        kind: args.entry.kind,
        serverVersion: args.entry.serverVersion,
        changedAt: args.entry.changedAt
    }, args.tx)
}
