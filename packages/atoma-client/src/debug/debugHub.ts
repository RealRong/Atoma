import type {
    Command,
    CommandResult,
    Hub,
    ListArgs,
    Snapshot,
    SnapshotArgs,
    SnapshotQuery,
    Source,
    SourceId,
    SourceSpec,
    StreamEvent,
    StreamEventType,
    SubscribeArgs
} from 'atoma-types/devtools'

type Subscriber = {
    args: SubscribeArgs
    fn: (event: StreamEvent) => void
}

type SourceEntry = {
    source: Source
    stopSource?: () => void
}

const EVENT_TYPES = new Set<StreamEventType>([
    'source:registered',
    'source:unregistered',
    'data:changed',
    'timeline:event',
    'command:result',
    'error'
])
const MAX_EVENTS = 10_000
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024
const encoder = new TextEncoder()

const now = (): number => Date.now()

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const toStringValue = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized || undefined
}

const toNumberValue = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined
    return value
}

const toEventType = (value: unknown): StreamEventType | undefined => {
    if (typeof value !== 'string') return undefined
    if (!EVENT_TYPES.has(value as StreamEventType)) return undefined
    return value as StreamEventType
}

const bytes = (value: string): number => encoder.encode(value).byteLength

const truncateByBytes = (value: string, maxBytes: number): string => {
    if (bytes(value) <= maxBytes) return value
    let end = Math.max(1, Math.floor(value.length * (maxBytes / Math.max(1, bytes(value)))))
    while (end > 1 && bytes(value.slice(0, end)) > maxBytes) {
        end -= 1
    }
    return value.slice(0, end)
}

const normalizePayload = (payload: unknown): unknown => {
    if (payload === undefined) return undefined
    try {
        const json = JSON.stringify(payload)
        if (typeof json !== 'string') return payload
        const size = bytes(json)
        if (size <= MAX_EVENT_PAYLOAD_BYTES) return payload
        return {
            truncated: true,
            size,
            preview: truncateByBytes(json, MAX_EVENT_PAYLOAD_BYTES)
        }
    } catch {
        return {
            truncated: true,
            reason: 'unserializable'
        }
    }
}

const normalizeHubEvent = (event: StreamEvent): StreamEvent => {
    const payload = normalizePayload(event.payload)
    return {
        ...event,
        ...(payload === undefined ? {} : { payload })
    }
}

const normalizeSnapshot = ({
    spec,
    query,
    value
}: {
    spec: SourceSpec
    query?: SnapshotQuery
    value: Snapshot
}): Snapshot => {
    const base = isObject(value) ? value : undefined
    const meta = isObject(base?.meta) ? {
        ...(typeof base?.meta?.title === 'string' ? { title: base.meta.title } : {}),
        ...(Array.isArray(base?.meta?.tags) ? { tags: base.meta.tags.filter(tag => typeof tag === 'string') as string[] } : {}),
        ...(Array.isArray(base?.meta?.warnings)
            ? { warnings: base.meta.warnings.filter(warning => typeof warning === 'string') as string[] }
            : {})
    } : undefined
    const page = isObject(base?.page) ? {
        ...(typeof base?.page?.cursor === 'string' ? { cursor: base.page.cursor } : {}),
        ...(typeof base?.page?.nextCursor === 'string' ? { nextCursor: base.page.nextCursor } : {}),
        ...(typeof base?.page?.totalApprox === 'number' ? { totalApprox: base.page.totalApprox } : {})
    } : undefined

    return {
        version: 1,
        sourceId: spec.id,
        clientId: spec.clientId,
        ...(toStringValue(base?.panelId) ?? toStringValue(query?.panelId) ? { panelId: toStringValue(base?.panelId) ?? toStringValue(query?.panelId) } : {}),
        revision: toNumberValue(base?.revision) ?? 0,
        timestamp: toNumberValue(base?.timestamp) ?? now(),
        data: base?.data,
        ...(page && (page.cursor || page.nextCursor || typeof page.totalApprox === 'number') ? { page } : {}),
        ...(meta && (meta.title || meta.tags?.length || meta.warnings?.length) ? { meta } : {})
    }
}

const buildSnapshotError = ({
    spec,
    error
}: {
    spec: SourceSpec
    error: unknown
}): Snapshot => {
    const message = error instanceof Error
        ? (error.message || 'Unknown error')
        : String(error ?? 'Unknown error')

    return {
        version: 1,
        sourceId: spec.id,
        clientId: spec.clientId,
        revision: 0,
        timestamp: now(),
        data: { error: message },
        meta: { warnings: ['snapshot:error'] }
    }
}

const sortSourceSpecs = (left: SourceSpec, right: SourceSpec): number => {
    const leftPriority = typeof left.priority === 'number' ? left.priority : 0
    const rightPriority = typeof right.priority === 'number' ? right.priority : 0
    if (leftPriority !== rightPriority) return leftPriority - rightPriority
    return left.id.localeCompare(right.id)
}

const matchesListArgs = (spec: SourceSpec, args?: ListArgs): boolean => {
    if (!args) return true
    if (args.clientId && spec.clientId !== args.clientId) return false
    if (args.namespace && spec.namespace !== args.namespace) return false
    if (args.panelId && !spec.panels.some(panel => panel.id === args.panelId)) return false
    return true
}

const matchesSubscribeArgs = (event: StreamEvent, args: SubscribeArgs): boolean => {
    if (args.clientId && event.clientId !== args.clientId) return false
    if (args.panelId && event.panelId !== args.panelId) return false
    if (Array.isArray(args.sourceIds) && args.sourceIds.length > 0 && !args.sourceIds.includes(event.sourceId)) {
        return false
    }
    return true
}

const emitEvent = (subscribers: Set<Subscriber>, event: StreamEvent): void => {
    for (const subscriber of subscribers) {
        if (!matchesSubscribeArgs(event, subscriber.args)) continue
        try {
            subscriber.fn(event)
        } catch {
            // ignore
        }
    }
}

const normalizeSourceEvent = ({
    source,
    event
}: {
    source: Source
    event: StreamEvent
}): StreamEvent => {
    const base = isObject(event) ? event : undefined
    const type = toEventType(base?.type) ?? 'error'
    const panelId = toStringValue(base?.panelId)
    const revision = toNumberValue(base?.revision)
    const timestamp = toNumberValue(base?.timestamp) ?? now()

    return {
        version: 1,
        sourceId: source.spec.id,
        clientId: source.spec.clientId,
        ...(panelId ? { panelId } : {}),
        type,
        ...(typeof revision === 'number' ? { revision } : {}),
        timestamp,
        ...(base && 'payload' in base ? { payload: base.payload } : {})
    }
}

const sourceLifecycleEvent = ({
    source,
    type
}: {
    source: Source
    type: 'source:registered' | 'source:unregistered'
}): StreamEvent => {
    return {
        version: 1,
        sourceId: source.spec.id,
        clientId: source.spec.clientId,
        type,
        timestamp: now(),
        payload: {
            namespace: source.spec.namespace,
            title: source.spec.title
        }
    }
}

export function createDebugHub(): Hub {
    const entriesById = new Map<SourceId, SourceEntry>()
    const subscribers = new Set<Subscriber>()
    const recentEvents: StreamEvent[] = []

    const dispatchEvent = (event: StreamEvent): void => {
        const normalized = normalizeHubEvent(event)
        recentEvents.push(normalized)
        if (recentEvents.length > MAX_EVENTS) {
            recentEvents.splice(0, recentEvents.length - MAX_EVENTS)
        }
        emitEvent(subscribers, normalized)
    }

    const register: Hub['register'] = (source) => {
        const sourceId = toStringValue(source?.spec?.id)
        if (!sourceId) {
            throw new Error('[Atoma] Hub.register: source.spec.id 必填')
        }
        if (typeof source.spec.clientId !== 'string' || !source.spec.clientId.trim()) {
            throw new Error('[Atoma] Hub.register: source.spec.clientId 必填')
        }

        const normalizedSource: Source = {
            ...source,
            spec: {
                ...source.spec,
                id: sourceId,
                clientId: source.spec.clientId.trim()
            }
        }

        const previous = entriesById.get(sourceId)
        if (previous?.stopSource) {
            try {
                previous.stopSource()
            } catch {
                // ignore
            }
        }

        const nextEntry: SourceEntry = {
            source: normalizedSource
        }

        if (typeof normalizedSource.subscribe === 'function') {
            nextEntry.stopSource = normalizedSource.subscribe((event) => {
                dispatchEvent(normalizeSourceEvent({
                    source: normalizedSource,
                    event
                }))
            })
        }

        entriesById.set(sourceId, nextEntry)
        dispatchEvent(sourceLifecycleEvent({
            source: normalizedSource,
            type: 'source:registered'
        }))

        return () => {
            const current = entriesById.get(sourceId)
            if (current !== nextEntry) return

            entriesById.delete(sourceId)
            if (current.stopSource) {
                try {
                    current.stopSource()
                } catch {
                    // ignore
                }
            }

            dispatchEvent(sourceLifecycleEvent({
                source: normalizedSource,
                type: 'source:unregistered'
            }))
        }
    }

    const list: Hub['list'] = (args) => {
        return Array.from(entriesById.values())
            .map(entry => entry.source.spec)
            .filter(spec => matchesListArgs(spec, args))
            .sort(sortSourceSpecs)
    }

    const snapshot: Hub['snapshot'] = ({ sourceId, query }: SnapshotArgs) => {
        const normalizedSourceId = toStringValue(sourceId)
        if (!normalizedSourceId) {
            throw new Error('[Atoma] Hub.snapshot: sourceId 必填')
        }

        const entry = entriesById.get(normalizedSourceId)
        if (!entry) {
            throw new Error(`[Atoma] Hub.snapshot: source not found: ${normalizedSourceId}`)
        }

        if (typeof entry.source.snapshot !== 'function') {
            return {
                version: 1,
                sourceId: entry.source.spec.id,
                clientId: entry.source.spec.clientId,
                ...(toStringValue(query?.panelId) ? { panelId: toStringValue(query?.panelId) } : {}),
                revision: 0,
                timestamp: now(),
                data: null,
                meta: { warnings: ['snapshot:unsupported'] }
            }
        }

        try {
            return normalizeSnapshot({
                spec: entry.source.spec,
                query,
                value: entry.source.snapshot(query)
            })
        } catch (error) {
            return buildSnapshotError({
                spec: entry.source.spec,
                error
            })
        }
    }

    const subscribe: Hub['subscribe'] = (args, fn) => {
        const subscriber: Subscriber = {
            args,
            fn
        }
        subscribers.add(subscriber)
        return () => {
            subscribers.delete(subscriber)
        }
    }

    const invoke: Hub['invoke'] = async (command: Command): Promise<CommandResult> => {
        const sourceId = toStringValue(command?.sourceId)
        if (!sourceId) {
            return { ok: false, message: 'sourceId required' }
        }

        const entry = entriesById.get(sourceId)
        if (!entry) {
            return { ok: false, message: `source not found: ${sourceId}` }
        }
        if (typeof entry.source.invoke !== 'function') {
            return { ok: false, message: 'source invoke unsupported' }
        }

        let result: CommandResult
        try {
            result = await entry.source.invoke(command)
        } catch (error) {
            const message = error instanceof Error
                ? (error.message || 'Unknown error')
                : String(error ?? 'Unknown error')
            result = { ok: false, message }
        }

        dispatchEvent({
            version: 1,
            sourceId: entry.source.spec.id,
            clientId: entry.source.spec.clientId,
            type: 'command:result',
            timestamp: now(),
            payload: {
                name: command.name,
                args: command.args,
                result
            }
        })

        return result
    }

    return {
        register,
        list,
        snapshot,
        subscribe,
        invoke
    }
}
