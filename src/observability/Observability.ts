import { createTraceId, deriveRequestId, createRequestIdSequencer } from './trace'
import { shouldSampleTrace } from './sampling'
import { utf8ByteLength } from './utf8'
import { ObservabilityRuntime } from './runtime/ObservabilityRuntime'
import type { ObservabilityRuntimeCreateArgs } from './runtime/types'

export const Observability = {
    trace: {
        createId: createTraceId,
        requestId: deriveRequestId,
        createRequestSequencer: createRequestIdSequencer
    },
    sampling: {
        isSampled: shouldSampleTrace
    },
    utf8: {
        byteLength: utf8ByteLength
    },
    runtime: {
        create: (args: ObservabilityRuntimeCreateArgs) => new ObservabilityRuntime(args)
    }
} as const
