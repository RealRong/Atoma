import { useEffect, useMemo, useRef, useState } from 'react'
import { RelationResolver } from '../../core/relations/RelationResolver'
import { stableStringify } from '../../core/query'
import { normalizeKey } from '../../core/relations/utils'
import type { Entity, FindManyOptions, RelationMap, StoreKey } from '../../core/types'
import { resolveStoreAccess } from '../../core/storeAccessRegistry'

type IncludeOption = Record<string, boolean | (FindManyOptions<any> & { live?: boolean })>

export interface UseRelationsResult<T extends Entity> {
    data: T[]
    loading: boolean
    error?: Error
    refetch: () => Promise<T[]>
}

export function useRelations<T extends Entity>(
    items: T[],
    include: IncludeOption | undefined,
    relations: RelationMap<T> | undefined
): UseRelationsResult<T> {
    const includeKey = useMemo(() => stableStringify(include), [include])
    const [data, setData] = useState<T[]>(items)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | undefined>(undefined)
    const resolvedSignatureRef = useRef<string>('')
    const relationsSnapshotRef = useRef<Map<string, Record<string, any>>>(new Map())
    const includeNamesRef = useRef<string[]>([])

    const buildSignature = () => {
        const idsSignature = Array.from(
            new Set(
                items
                    .map(item => (item as any)?.id)
                    .filter(id => id !== undefined && id !== null)
                    .map(id => normalizeKey(id as StoreKey))
            )
        ).sort().join('|')

        const relKeys: string[] = []
        if (relations && include) {
            Object.entries(include).forEach(([name, opts]) => {
                if (opts === undefined || opts === null || opts === false) return
                const rel = relations[name]
                if (!rel) return
                if (rel.type === 'belongsTo') {
                    const fk = rel.foreignKey
                    const sig = Array.from(
                        new Set(
                            items
                                .map(it => (typeof fk === 'function' ? fk(it as any) : (it as any)?.[fk]))
                                .filter(v => v !== undefined && v !== null)
                                .map(v => normalizeKey(v as StoreKey))
                        )
                    ).sort().join(',')
                    relKeys.push(`${name}:${sig}`)
                } else if (rel.type === 'hasMany') {
                    const sig = Array.from(
                        new Set(
                            items
                                .map(it => (it as any)?.id)
                                .filter(v => v !== undefined && v !== null)
                                .map(v => normalizeKey(v as StoreKey))
                        )
                    ).sort().join(',')
                    relKeys.push(`${name}:${sig}`)
                }
            })
        }

        return `${includeKey}::${idsSignature}::${relKeys.join('|')}`
    }

    const canReuseRelations = () => buildSignature() === resolvedSignatureRef.current

    const runResolve = async () => {
        if (!include || !relations || items.length === 0) {
            relationsSnapshotRef.current = new Map()
            includeNamesRef.current = []
            resolvedSignatureRef.current = buildSignature()
            setData(items)
            return items
        }

        const sig = buildSignature()
        setLoading(true)
        setError(undefined)

        const includeWithSkipStore = Object.fromEntries(
            Object.entries(include).map(([key, opts]) => {
                if (opts === false || opts === undefined) return [key, opts]
                if (opts && typeof opts === 'object') {
                    const { live: _live, ...rest } = opts as any
                    return [key, { ...rest, skipStore: false }]
                }
                return [key, { skipStore: false }]
            })
        ) as IncludeOption

        const includeNames = Object.entries(includeWithSkipStore)
            .filter(([, v]) => v !== false && v !== undefined && v !== null)
            .map(([k]) => k)

        try {
            const resolved = await RelationResolver.resolveBatch(
                items,
                includeWithSkipStore,
                relations,
                { onError: 'partial', timeout: 5000, maxConcurrency: 10 }
            )
            const snapshot = new Map<string, Record<string, any>>()
            resolved.forEach(item => {
                const id = (item as any)?.id
                if (id === undefined || id === null) return
                const key = normalizeKey(id as StoreKey)
                const relValues: Record<string, any> = {}
                includeNames.forEach(name => {
                    relValues[name] = (item as any)[name]
                })
                snapshot.set(key, relValues)
            })

            relationsSnapshotRef.current = snapshot
            includeNamesRef.current = includeNames
            resolvedSignatureRef.current = sig

            setData(resolved)
            return resolved
        } catch (err: any) {
            const e = err instanceof Error ? err : new Error(String(err))
            setError(e)
            setData(items)
            return items
        } finally {
            setLoading(false)
        }
    }

    // live 订阅：监听子 store map 变化
    const [liveTick, setLiveTick] = useState(0)
    useEffect(() => {
        if (!include || !relations) return
        const unsubscribers: Array<() => void> = []
        Object.entries(include).forEach(([name, opts]) => {
            if (opts === false || opts === undefined || opts === null) return
            const live = typeof opts === 'object' ? opts.live !== false : true
            if (!live) return
            const rel = relations[name]
            if (!rel) return
            const access = resolveStoreAccess((rel as any).store)
            if (!access || typeof access.jotaiStore.sub !== 'function') return
            const unsub = access.jotaiStore.sub(access.atom, () => setLiveTick(t => t + 1))
            unsubscribers.push(unsub)
        })
        return () => {
            unsubscribers.forEach(fn => fn())
        }

    }, [includeKey, relations])

    const computeLiveRelations = (item: T, includeNames: string[]) => {
        if (!relations) return {}
        const merged: Record<string, any> = {}
        includeNames.forEach(name => {
            const rel = relations[name]
            if (!rel) return
            const includeOpts = (include as any)?.[name]
            const live = typeof includeOpts === 'object' ? includeOpts.live !== false : true
            if (!live) return
            const access = resolveStoreAccess((rel as any).store)
            if (!access || typeof access.jotaiStore.get !== 'function') return
            const map = access.jotaiStore.get(access.atom) as Map<StoreKey, any>

            if (rel.type === 'belongsTo') {
                const fk = typeof rel.foreignKey === 'function'
                    ? rel.foreignKey(item as any)
                    : (item as any)[rel.foreignKey]
                const val = fk !== undefined && fk !== null ? map.get(fk as StoreKey) ?? null : null
                merged[name] = val ?? null
            } else if (rel.type === 'hasMany') {
                const pkVal = typeof rel.primaryKey === 'function'
                    ? rel.primaryKey(item as any)
                    : (item as any).id

                const matches: any[] = []
                map.forEach(v => {
                    if ((v as any)[rel.foreignKey] === pkVal) {
                        matches.push(v)
                    }
                })
                const orderBy = (includeOpts as any)?.orderBy
                if (orderBy) {
                    const rules = Array.isArray(orderBy) ? orderBy : [orderBy]
                    matches.sort((a, b) => {
                        for (const { field, direction } of rules) {
                            const av = (a as any)[field]
                            const bv = (b as any)[field]
                            if (av === bv) continue
                            const cmp = av < bv ? -1 : 1
                            return direction === 'asc' ? cmp : -cmp
                        }
                        return 0
                    })
                }
                const limit = (includeOpts as any)?.limit
                merged[name] = typeof limit === 'number' ? matches.slice(0, limit) : matches
            } else if (rel.type === 'hasOne') {
                const pkVal = typeof rel.primaryKey === 'function'
                    ? rel.primaryKey(item as any)
                    : (item as any).id
                let found: any = null
                map.forEach(v => {
                    if ((v as any)[rel.foreignKey] === pkVal) {
                        found = v
                    }
                })
                merged[name] = found
            }
        })
        return merged
    }

    useEffect(() => {
        if (!include || !relations || items.length === 0) {
            relationsSnapshotRef.current = new Map()
            includeNamesRef.current = []
            setData(items)
            setLoading(false)
            setError(undefined)
            resolvedSignatureRef.current = buildSignature()
            return
        }

        if (canReuseRelations()) {
            setLoading(false)
            return
        }

        runResolve()

    }, [items, includeKey, relations])

    useEffect(() => {
        if (!include || !relations || items.length === 0) {
            setData(items)
            return
        }
        const includeNames = includeNamesRef.current
        const snapshot = relationsSnapshotRef.current
        const rebased = items.map(item => {
            const merged: any = { ...item }
            includeNames.forEach(name => {
                const includeOpts = (include as any)?.[name]
                const live = typeof includeOpts === 'object' ? includeOpts.live !== false : true
                if (live) {
                    Object.assign(merged, computeLiveRelations(item, [name]))
                } else {
                    const cached = snapshot.get(normalizeKey((item as any)?.id as StoreKey))
                    if (cached && name in cached) {
                        merged[name] = cached[name]
                    }
                }
            })
            return merged as T
        })
        setData(rebased)

    }, [items, includeKey, relations, liveTick])

    const refetch = () => runResolve()

    return { data, loading, error, refetch }
}
