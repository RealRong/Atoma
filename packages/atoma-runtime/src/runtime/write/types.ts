import type { Types } from 'atoma-core'
import type { Patch } from 'immer'

export type WriteEvent<T extends Types.Entity> =
    | { type: 'add'; data: Types.PartialWithId<T> }
    | { type: 'update'; data: Types.PartialWithId<T>; base: Types.PartialWithId<T> }
    | { type: 'upsert'; data: Types.PartialWithId<T>; base?: Types.PartialWithId<T>; upsert?: { mode?: 'strict' | 'loose'; merge?: boolean } }
    | { type: 'remove'; data: Types.PartialWithId<T>; base: Types.PartialWithId<T> }
    | { type: 'forceRemove'; data: Types.PartialWithId<T>; base: Types.PartialWithId<T> }
    | { type: 'patches'; patches: Patch[]; inversePatches: Patch[] }
