import type {
    DebugHub,
    DebugHubEvent,
    DebugKind,
    DebugPayload,
    DebugProvider,
    DebugSnapshotArgs
} from 'atoma-types/devtools'

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const sortProviders = (left: DebugProvider, right: DebugProvider): number => {
    const leftPriority = typeof left.priority === 'number' ? left.priority : 0
    const rightPriority = typeof right.priority === 'number' ? right.priority : 0
    if (leftPriority !== rightPriority) return leftPriority - rightPriority
    return left.id.localeCompare(right.id)
}

const normalizePayload = (provider: DebugProvider, payload: DebugPayload): DebugPayload => {
    const base = isObject(payload) ? payload : undefined
    const scopeValue = isObject(base?.scope) ? {
        ...(typeof base?.scope?.storeName === 'string' ? { storeName: base.scope.storeName } : {}),
        ...(typeof base?.scope?.tab === 'string' ? { tab: base.scope.tab } : {})
    } : undefined

    const metaValue = isObject(base?.meta)
        ? {
            ...(typeof base?.meta?.title === 'string' ? { title: base.meta.title } : {}),
            ...(Array.isArray(base?.meta?.tags) ? { tags: base.meta.tags.filter(tag => typeof tag === 'string') as string[] } : {}),
            ...(Array.isArray(base?.meta?.capabilities)
                ? { capabilities: base.meta.capabilities.filter(cap => typeof cap === 'string') as string[] }
                : {})
        }
        : undefined

    return {
        version: 1,
        providerId: provider.id,
        kind: provider.kind,
        clientId: provider.clientId,
        timestamp: typeof base?.timestamp === 'number' ? base.timestamp : Date.now(),
        ...(scopeValue && (scopeValue.storeName || scopeValue.tab) ? { scope: scopeValue } : {}),
        data: base?.data,
        ...(metaValue && (metaValue.title || metaValue.tags?.length || metaValue.capabilities?.length)
            ? { meta: metaValue }
            : {})
    }
}

const buildErrorPayload = (provider: DebugProvider, error: unknown): DebugPayload => {
    const message = error instanceof Error
        ? (error.message || 'Unknown error')
        : String(error ?? 'Unknown error')

    return {
        version: 1,
        providerId: provider.id,
        kind: provider.kind,
        clientId: provider.clientId,
        timestamp: Date.now(),
        data: { error: message },
        meta: { tags: ['snapshot:error'] }
    }
}

const emit = (subscribers: Set<(e: DebugHubEvent) => void>, event: DebugHubEvent): void => {
    for (const subscriber of subscribers) {
        try {
            subscriber(event)
        } catch {
            // ignore
        }
    }
}

const matchesFilter = (provider: DebugProvider, filter?: { kind?: DebugKind; clientId?: string }): boolean => {
    if (!filter) return true
    if (filter.kind && provider.kind !== filter.kind) return false
    if (filter.clientId && provider.clientId !== filter.clientId) return false
    return true
}

export function createDebugHub(): DebugHub {
    const providersById = new Map<string, DebugProvider>()
    const subscribers = new Set<(e: DebugHubEvent) => void>()

    const register = (provider: DebugProvider): (() => void) => {
        const providerId = String(provider?.id ?? '').trim()
        if (!providerId) {
            throw new Error('[Atoma] DebugHub.register: provider.id 必填')
        }
        if (typeof provider.snapshot !== 'function') {
            throw new Error('[Atoma] DebugHub.register: provider.snapshot 必须是函数')
        }

        const normalizedProvider: DebugProvider = {
            ...provider,
            id: providerId
        }

        providersById.set(providerId, normalizedProvider)
        emit(subscribers, {
            type: 'register',
            providerId,
            kind: normalizedProvider.kind,
            clientId: normalizedProvider.clientId
        })

        return () => {
            const current = providersById.get(providerId)
            if (current !== normalizedProvider) return
            providersById.delete(providerId)
            emit(subscribers, {
                type: 'unregister',
                providerId,
                kind: normalizedProvider.kind,
                clientId: normalizedProvider.clientId
            })
        }
    }

    const get = (providerId: string): DebugProvider | undefined => {
        const normalizedId = String(providerId ?? '').trim()
        if (!normalizedId) return undefined
        return providersById.get(normalizedId)
    }

    const list = (filter?: { kind?: DebugKind; clientId?: string }): DebugProvider[] => {
        return Array.from(providersById.values())
            .filter(provider => matchesFilter(provider, filter))
            .sort(sortProviders)
    }

    const snapshotAll = (args?: DebugSnapshotArgs): DebugPayload[] => {
        const providers = list({
            ...(args?.kind ? { kind: args.kind } : {}),
            ...(args?.clientId ? { clientId: args.clientId } : {})
        })

        return providers.map(provider => {
            try {
                return normalizePayload(provider, provider.snapshot({
                    ...(args?.storeName ? { storeName: args.storeName } : {})
                }))
            } catch (error) {
                return buildErrorPayload(provider, error)
            }
        })
    }

    const subscribe = (fn: (e: DebugHubEvent) => void): (() => void) => {
        subscribers.add(fn)
        return () => {
            subscribers.delete(fn)
        }
    }

    return {
        register,
        get,
        list,
        snapshotAll,
        subscribe
    }
}
