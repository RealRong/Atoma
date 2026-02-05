export type SingleflightState<T> = {
    id: number
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
}

export function createSingleflight<T>() {
    let current: SingleflightState<T> | undefined
    let nextId = 1

    const start = (): SingleflightState<T> => {
        if (current) return current
        const id = nextId++
        let resolve!: (value: T) => void
        let reject!: (error: unknown) => void
        const promise = new Promise<T>((res, rej) => {
            resolve = res
            reject = rej
        })
        current = { id, promise, resolve, reject }
        return current
    }

    const resolve = (id: number, value: T): boolean => {
        if (!current || current.id !== id) return false
        current.resolve(value)
        current = undefined
        return true
    }

    const reject = (id: number, error: unknown): boolean => {
        if (!current || current.id !== id) return false
        current.reject(error)
        current = undefined
        return true
    }

    const cancel = (error: unknown) => {
        if (!current) return
        current.reject(error)
        current = undefined
    }

    const peek = () => current

    return { start, resolve, reject, cancel, peek }
}

