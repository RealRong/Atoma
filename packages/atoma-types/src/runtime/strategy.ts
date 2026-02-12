import type { Entity, WriteStrategy } from '../core'
import type {
    QueryInput,
    QueryOutput,
    StrategySpec,
    WriteInput,
    WriteOutput,
    Policy,
} from './persistence'

export type StrategyRegistry = Readonly<{
    register: (key: WriteStrategy, spec: StrategySpec) => () => void
    setDefault: (key: WriteStrategy) => () => void
    resolvePolicy: (key?: WriteStrategy) => Policy
    query: <T extends Entity>(input: QueryInput<T>) => Promise<QueryOutput>
    write: <T extends Entity>(input: WriteInput<T>) => Promise<WriteOutput<T>>
}>
