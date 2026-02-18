export type FetchPolicy = 'cache-only' | 'network-only' | 'cache-and-network'

export type FetchPolicyRuntime = Readonly<{
    remoteEnabled: boolean
    isStale: boolean
    loading: boolean
}>

export function resolveRemoteEnabled(fetchPolicy: FetchPolicy): boolean {
    return fetchPolicy !== 'cache-only'
}

export function resolveStaleState(args: {
    fetchPolicy: FetchPolicy
    hasData: boolean
    isFetching: boolean
}): boolean {
    return Boolean(args.fetchPolicy === 'cache-and-network' && args.hasData && args.isFetching)
}

export function resolveLoadingState(args: {
    remoteEnabled: boolean
    hasData: boolean
    isFetching: boolean
}): boolean {
    return Boolean(args.remoteEnabled && args.isFetching && !args.hasData)
}

export function evaluateFetchPolicyRuntime(args: {
    fetchPolicy: FetchPolicy
    hasData: boolean
    isFetching: boolean
}): FetchPolicyRuntime {
    const remoteEnabled = resolveRemoteEnabled(args.fetchPolicy)

    return {
        remoteEnabled,
        isStale: resolveStaleState(args),
        loading: resolveLoadingState({
            remoteEnabled,
            hasData: args.hasData,
            isFetching: args.isFetching
        })
    }
}
