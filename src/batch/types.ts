import type { ObservabilityContext } from '#observability'
import type { Operation, OperationResult } from '#protocol'

export type FetchFn = typeof fetch

export type Deferred<T> = {
    resolve: (value: T extends void ? undefined : T) => void
    reject: (reason?: unknown) => void
}

export type InFlightTask = {
    deferred: { reject: (reason?: unknown) => void }
}

export type OpsTask = {
    op: Operation
    ctx?: ObservabilityContext
    deferred: Deferred<OperationResult>
}
