import { enableMapSet, enablePatches } from 'immer'

enableMapSet()
enablePatches()

export { MutationPipeline } from './MutationPipeline'
export type { MutationControl, MutationRuntime } from './MutationPipeline'
export type {
    PersistResult
} from './pipeline/types'
