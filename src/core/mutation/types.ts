import type { Entity } from '../types'
import type {
    CommitAfterPersistArgs,
    CommitOptimisticBeforePersistArgs,
    RollbackOptimisticArgs
} from './pipeline/types'

export type CommitterPrepareArgs<T extends Entity> = CommitOptimisticBeforePersistArgs<T>
export type CommitterCommitArgs<T extends Entity> = CommitAfterPersistArgs<T>
export type CommitterRollbackArgs<T extends Entity> = RollbackOptimisticArgs<T>

export interface Committer {
    prepare: <T extends Entity>(args: CommitterPrepareArgs<T>) => void
    commit: <T extends Entity>(args: CommitterCommitArgs<T>) => void
    rollback: <T extends Entity>(args: CommitterRollbackArgs<T>) => void
}
