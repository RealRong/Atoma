import type { Entity, WriteStrategy } from '../core'
import type {
    PersistRequest,
    PersistResult,
    StrategyDescriptor,
    WritePolicy,
} from './persistence'

export type StrategyRegistry = Readonly<{
    register: (key: WriteStrategy, descriptor: StrategyDescriptor) => () => void
    setDefaultStrategy: (key: WriteStrategy) => () => void
    resolveWritePolicy: (key?: WriteStrategy) => WritePolicy
    persist: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
}>
