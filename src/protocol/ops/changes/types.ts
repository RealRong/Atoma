import type { Cursor, EntityId, Version } from '../../shared/scalars'

export type ChangeKind = 'upsert' | 'delete'

export type Change = {
    resource: string
    entityId: EntityId
    kind: ChangeKind
    version: Version
    changedAtMs: number
}

export type ChangeBatch = {
    nextCursor: Cursor
    changes: Change[]
}
