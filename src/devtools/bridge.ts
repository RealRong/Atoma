import { DevtoolsBridge, DevtoolsEvent, StoreSnapshot } from './types'

type Subscriber = (e: DevtoolsEvent) => void

interface BridgeOptions {
    snapshotIntervalMs?: number
}

/**
 * 简易内存版 DevtoolsBridge：
 * - 负责事件分发
 * - registerStore 会定时拉取快照并发送 store-snapshot
 */
export function createDevtoolsBridge(options: BridgeOptions = {}): DevtoolsBridge {
    const subs: Subscriber[] = []
    const intervalMs = options.snapshotIntervalMs ?? 2000
    const timers = new Set<NodeJS.Timeout>()

    const emit = (event: DevtoolsEvent) => {
        subs.forEach(fn => {
            try {
                fn(event)
            } catch (err) {
                console.warn('[Atoma Devtools] subscriber error', err)
            }
        })
    }

    const subscribe = (fn: Subscriber) => {
        subs.push(fn)
        return () => {
            const idx = subs.indexOf(fn)
            if (idx >= 0) subs.splice(idx, 1)
        }
    }

    const intervalRegister = <T>(cb: () => DevtoolsEvent | undefined) => {
        // fire once
        const first = cb()
        if (first) emit(first)
        const t = setInterval(() => {
            const evt = cb()
            if (evt) emit(evt)
        }, intervalMs)
        timers.add(t)
        return () => {
            clearInterval(t)
            timers.delete(t)
        }
    }

    const registerStore = ({ name, snapshot }: { name: string; snapshot: () => StoreSnapshot }) =>
        intervalRegister(() => {
            try {
                return { type: 'store-snapshot', payload: snapshot() }
            } catch (err) {
                console.warn('[Atoma Devtools] snapshot failed', err)
                return undefined
            }
        })

    const registerIndexManager = ({ name, snapshot }: { name: string; snapshot: () => any }) =>
        intervalRegister(() => {
            try {
                const snap = snapshot()
                // 支持旧签名：snapshot() => IndexSnapshot[]
                if (Array.isArray(snap)) {
                    return { type: 'index-snapshot', payload: { name, indexes: snap } }
                }
                return { type: 'index-snapshot', payload: snap }
            } catch (err) {
                console.warn('[Atoma Devtools] index snapshot failed', err)
                return undefined
            }
        })

    const registerQueue = ({ name, snapshot }: { name: string; snapshot: () => { pending: any[]; failed?: any[] } }) =>
        intervalRegister(() => {
            try {
                const snap = snapshot()
                return { type: 'queue-snapshot', payload: { name, pending: snap.pending, failed: snap.failed || [] } }
            } catch (err) {
                console.warn('[Atoma Devtools] queue snapshot failed', err)
                return undefined
            }
        })

    const registerHistory = ({ name, snapshot }: { name: string; snapshot: () => { pointer: number; length: number; entries: any[] } }) =>
        intervalRegister(() => {
            try {
                const snap = snapshot()
                return { type: 'history-snapshot', payload: { name, ...snap } }
            } catch (err) {
                console.warn('[Atoma Devtools] history snapshot failed', err)
                return undefined
            }
        })

    return { emit, subscribe, registerStore, registerIndexManager, registerQueue, registerHistory }
}
