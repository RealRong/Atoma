import type { Cursor, EntityId, ResourceToken, Version } from './scalars'

export type ChangeKind = 'upsert' | 'delete'

export type Change = {
    resource: ResourceToken
    id: EntityId
    kind: ChangeKind
    version: Version
    changedAtMs: number
}

export type ChangeBatch = {
    nextCursor: Cursor
    changes: Change[]
}
