import type { SyncMode } from './types'

export function wantsPush(mode: SyncMode | string): boolean {
    return mode === 'push-only' || mode === 'full'
}

export function wantsSubscribe(mode: SyncMode | string): boolean {
    return mode === 'subscribe-only' || mode === 'pull+subscribe' || mode === 'full'
}

