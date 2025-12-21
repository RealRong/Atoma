import { createId, requestId, createRequestSequencer } from './trace'
import { isSampled } from './sampling'
import { byteLength } from './utf8'
import { ObservabilityRuntime } from './runtime/ObservabilityRuntime'
import type { ObservabilityRuntimeCreateArgs } from './runtime/types'

export const Observability = {
    trace: {
        createId,
        requestId,
        createRequestSequencer
    },
    sampling: {
        isSampled
    },
    utf8: {
        byteLength
    },
    runtime: {
        create: (args: ObservabilityRuntimeCreateArgs) => new ObservabilityRuntime(args)
    }
} as const
