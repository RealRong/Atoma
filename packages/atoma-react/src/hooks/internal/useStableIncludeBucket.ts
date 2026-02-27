import { useMemo, useRef } from 'react'
import type { RelationInclude } from 'atoma-types/runtime'
import { normalizeInclude, type IncludeBucket } from './relationInclude'

export function useStableIncludeBucket(include: RelationInclude): IncludeBucket {
    const next = useMemo(() => normalizeInclude(include), [include])
    const cacheRef = useRef(next)

    if (cacheRef.current.includeKey !== next.includeKey) {
        cacheRef.current = next
    }

    return cacheRef.current
}
