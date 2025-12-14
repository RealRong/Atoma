import type { DebugEmitter } from '../observability/debug'
import type { AtomaDebugEventMap, DebugEmitMeta } from '../observability/types'

type AdapterEventType = 'adapter:request' | 'adapter:response'

export function emitAdapterEvent<M extends { emitter: DebugEmitter }, TType extends AdapterEventType>(args: {
    emitters: M[]
    type: TType
    payloadFor: (m: M) => AtomaDebugEventMap[TType]
    meta?: DebugEmitMeta
}) {
    const { emitters, type, payloadFor, meta } = args
    if (!emitters.length) return

    emitters.forEach(m => {
        try {
            m.emitter.emit(type, payloadFor(m), meta)
        } catch {
            // ignore
        }
    })
}

