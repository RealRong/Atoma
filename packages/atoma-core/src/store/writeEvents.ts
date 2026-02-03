import type { Entity, PartialWithId } from '../types'
import type { Patch } from 'immer'

export type WriteEvent<T extends Entity> =
    | { type: 'add'; data: PartialWithId<T> }
    | { type: 'update'; data: PartialWithId<T>; base: PartialWithId<T> }
    | { type: 'upsert'; data: PartialWithId<T>; base?: PartialWithId<T>; upsert?: { mode?: 'strict' | 'loose'; merge?: boolean } }
    | { type: 'remove'; data: PartialWithId<T>; base: PartialWithId<T> }
    | { type: 'forceRemove'; data: PartialWithId<T>; base: PartialWithId<T> }
    | { type: 'patches'; patches: Patch[]; inversePatches: Patch[] }
