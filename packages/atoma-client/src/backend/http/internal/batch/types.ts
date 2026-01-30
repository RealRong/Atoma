import type { ObservabilityContext } from 'atoma-observability'
import type { Operation, OperationResult } from 'atoma-protocol'

export type Deferred<T> = {
    resolve: (value: T extends void ? undefined : T) => void
    reject: (reason?: unknown) => void
}

export type OpsTask = {
    op: Operation
    ctx?: ObservabilityContext
    deferred: Deferred<OperationResult>
}
