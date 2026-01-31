import { enableMapSet, enablePatches } from 'immer'

enableMapSet()
enablePatches()

export { MutationPipeline } from './MutationPipeline'
export type {
    PersistResult,
    StoreCommit
} from './pipeline/types'
