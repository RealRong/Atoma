import { useRef } from 'react'

const shallowArrayEqual = <T,>(a: readonly T[], b: readonly T[]) => {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
    }
    return true
}

export const useShallowStableArray = <T,>(value: T[]) => {
    const ref = useRef<T[]>(value)
    if (!shallowArrayEqual(ref.current, value)) ref.current = value
    return ref.current
}
