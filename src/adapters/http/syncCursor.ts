import { createKVStore } from './kvStore'

const kv = createKVStore()

function randomId(): string {
    const c: any = globalThis.crypto as any
    const uuid = c?.randomUUID?.()
    if (typeof uuid === 'string' && uuid) return uuid
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export type SyncCursorStorage = {
    getCursor: () => Promise<number>
    setCursor: (cursor: number) => Promise<void>
    getOrCreateDeviceId: () => Promise<string>
}

export function createSyncCursorStorage(params: {
    baseKey: string
    cursorKey?: string
    deviceIdKey?: string
}): SyncCursorStorage {
    const cursorKey = params.cursorKey ?? `${params.baseKey}:cursor`
    const deviceKey = params.deviceIdKey ?? `${params.baseKey}:deviceId`

    const getCursor = async () => {
        const v = await kv.get<any>(cursorKey)
        const n = typeof v === 'number' ? v : Number(v)
        if (Number.isFinite(n) && n >= 0) return Math.floor(n)
        return 0
    }

    const setCursor = async (cursor: number) => {
        const n = Number(cursor)
        if (!Number.isFinite(n) || n < 0) return
        await kv.set(cursorKey, Math.floor(n))
    }

    const getOrCreateDeviceId = async () => {
        const existing = await kv.get<any>(deviceKey)
        if (typeof existing === 'string' && existing) return existing
        const created = `d_${randomId()}`
        await kv.set(deviceKey, created)
        return created
    }

    return { getCursor, setCursor, getOrCreateDeviceId }
}

