import type { ObservabilityContext } from '../observability/types'
import type { AtomaDebugEventMap, DebugEmitMeta } from '../observability/types'

type AdapterEventType = 'adapter:request' | 'adapter:response'

export function emitAdapterEvent<M extends { ctx?: ObservabilityContext }, TType extends AdapterEventType>(args: {
    targets: M[]
    type: TType
    payloadFor: (m: M) => AtomaDebugEventMap[TType]
    meta?: DebugEmitMeta
}) {
    const { targets, type, payloadFor, meta } = args
    if (!targets.length) return

    targets.forEach(m => {
        try {
            m.ctx?.emit(type as any, payloadFor(m), meta)
        } catch {
            // ignore
        }
    })
}
