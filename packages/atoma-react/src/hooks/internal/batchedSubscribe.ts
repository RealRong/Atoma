type Subscribe = (listener: () => void) => () => void

const scheduleMicrotask = typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (cb: () => void) => Promise.resolve().then(cb)

export function createBatchedSubscribe(subscribe: Subscribe): Subscribe {
    return (listener: () => void) => {
        let scheduled = false
        let active = true

        const wrapped = () => {
            if (!active || scheduled) return
            scheduled = true
            scheduleMicrotask(() => {
                scheduled = false
                if (!active) return
                listener()
            })
        }

        const unsubscribe = subscribe(wrapped)
        return () => {
            active = false
            unsubscribe()
        }
    }
}
