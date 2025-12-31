import { enableMapSet, enablePatches } from 'immer'

enableMapSet()
enablePatches()

export { AtomCommitter } from './AtomCommitter'
export type {
    Committer,
    CommitterCommitArgs,
    CommitterPrepareArgs,
    CommitterRollbackArgs
} from './types'
export { MutationPipeline } from './MutationPipeline'
export type { MutationControl, MutationRuntime } from './MutationPipeline'
export { createMutationHooks, HookEvent, HookMiddlewareChain } from './hooks'
export type {
    AfterPersistEvent,
    BeforeDispatchContext,
    BeforePersistContext,
    CommittedEvent,
    DispatchDecision,
    Extensions,
    Middleware,
    MutationHooks,
    Observer,
    PersistErrorEvent,
    PlannedEvent,
    RolledBackEvent,
    RemoteAckEvent,
    RemotePullEvent,
    RemoteRejectEvent,
    PersistResult
} from './hooks'
