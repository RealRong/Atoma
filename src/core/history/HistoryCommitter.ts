import type { Entity, OperationContext } from '../types'
import type { Committer, CommitterCommitArgs, CommitterPrepareArgs, CommitterRollbackArgs } from '../mutation/types'
import type { HistoryManager } from './HistoryManager'

export class HistoryCommitter implements Committer {
    constructor(
        private readonly args: {
            inner: Committer
            history: HistoryManager
            storeName: string
            opContext: OperationContext
        }
    ) { }

    prepare<T extends Entity>(args: CommitterPrepareArgs<T>) {
        this.args.inner.prepare(args)
    }

    commit<T extends Entity>(args: CommitterCommitArgs<T>) {
        this.args.inner.commit(args)
        this.args.history.record({
            storeName: this.args.storeName,
            patches: args.plan.patches,
            inversePatches: args.plan.inversePatches,
            opContext: this.args.opContext
        })
    }

    rollback<T extends Entity>(args: CommitterRollbackArgs<T>) {
        this.args.inner.rollback(args)
    }
}

