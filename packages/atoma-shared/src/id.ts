export type IdKind = 'action' | 'entity' | 'request' | 'replica'

export type CreateIdArgs = Readonly<{
    kind?: IdKind
    sortable?: boolean
    prefix?: string
    now?: () => number
}>

type IdState = {
    lastTimeMs: number
    seq: number
}

const ID_STATE_KEY = Symbol.for('atoma.shared.id.state')
const DEFAULT_PREFIX_BY_KIND: Readonly<Record<IdKind, string>> = {
    action: 'a',
    entity: 'e',
    request: 'r',
    replica: 'rp'
}

const createRandomFallback = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`

function tryRandomUUIDInternal(): string | undefined {
    const cryptoObject = (globalThis as { crypto?: unknown }).crypto as
        | { randomUUID?: () => string }
        | undefined
    const randomUUID = cryptoObject?.randomUUID
    if (typeof randomUUID !== 'function') return undefined

    try {
        const value = randomUUID.call(cryptoObject)
        if (typeof value === 'string' && value) {
            return value
        }
    } catch {
        // ignore
    }

    return undefined
}

function getState(): IdState {
    const globalObj = globalThis as Record<PropertyKey, unknown>
    const existing = globalObj[ID_STATE_KEY] as IdState | undefined
    if (existing && typeof existing.lastTimeMs === 'number' && typeof existing.seq === 'number') {
        return existing
    }

    const next: IdState = {
        lastTimeMs: 0,
        seq: 0
    }
    globalObj[ID_STATE_KEY] = next
    return next
}

function nextSeq(nowMs: number): number {
    const state = getState()
    if (state.lastTimeMs === nowMs) {
        state.seq += 1
    } else {
        state.lastTimeMs = nowMs
        state.seq = 1
    }
    return state.seq
}

function normalizePrefix(prefix: string | undefined, kind: IdKind): string {
    const value = String(prefix ?? DEFAULT_PREFIX_BY_KIND[kind]).trim()
    return value || DEFAULT_PREFIX_BY_KIND[kind]
}

function createToken(): string {
    const uuid = tryRandomUUIDInternal()
    if (uuid) return uuid.replace(/-/g, '')
    return createRandomFallback().replace(/[^a-zA-Z0-9]/g, '')
}

export function createId(args?: CreateIdArgs): string {
    const kind = args?.kind ?? 'entity'
    const now = args?.now ?? (() => Date.now())
    const prefix = normalizePrefix(args?.prefix, kind)
    const sortable = args?.sortable ?? (kind === 'entity')

    if (!sortable) {
        return `${prefix}_${createToken()}`
    }

    const nowMs = now()
    const seq = nextSeq(nowMs)
    const token = createToken().slice(0, 12)
    return `${prefix}_${nowMs.toString(36)}_${seq.toString(36)}_${token}`
}

export function createEntityId(now?: () => number): string {
    return createId({ kind: 'entity', sortable: true, now })
}

export function createActionId(now?: () => number): string {
    return createId({ kind: 'action', now })
}
