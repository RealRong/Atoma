import type { Entity, IndexSnapshot, StoreToken } from '../core'

export type StoreDebugSnapshot = Readonly<{
    name: string
    count: number
    approxSize: number
    sample: unknown[]
    timestamp: number
}>

export type IndexDebugSnapshot<T extends Entity = Entity> = Readonly<{
    name: string
    indexes: IndexSnapshot<T>[]
    lastQuery?: unknown
    timestamp: number
}>

export type Debug = Readonly<{
    snapshotStore: (storeName: StoreToken) => StoreDebugSnapshot | undefined
    snapshotIndexes: <T extends Entity = Entity>(storeName: StoreToken) => IndexDebugSnapshot<T> | undefined
}>
