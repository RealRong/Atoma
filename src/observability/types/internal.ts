import type { AtomaDebugEventMap, DebugEmitMeta, EmitFn } from './events'

export type ObservabilityContext<EventMap extends Record<string, any> = AtomaDebugEventMap> = {
    active: boolean
    traceId?: string
    emit: EmitFn<EventMap>
    with: (meta: DebugEmitMeta) => ObservabilityContext<EventMap>
}
