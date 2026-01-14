type IdsState = {
    seq: number
}

const IDS_STATE_KEY = Symbol.for('atoma.protocol.ids.state')
const IDEMPOTENCY_PREFIX = 'i'

function getState(): IdsState {
    const g = globalThis as any
    const existing = g[IDS_STATE_KEY]
    if (existing && typeof existing.seq === 'number') return existing as IdsState
    const next: IdsState = { seq: 0 }
    g[IDS_STATE_KEY] = next
    return next
}

function nextSeq(): number {
    const state = getState()
    state.seq += 1
    return state.seq
}

function getRandomUUID(): string | undefined {
    const c = (globalThis as any)?.crypto
    if (!c) return undefined
    const randomUUID = Reflect.get(c, 'randomUUID')
    if (typeof randomUUID !== 'function') return undefined
    const uuid = randomUUID.call(c)
    if (typeof uuid !== 'string' || !uuid) return undefined
    return uuid
}

export function createIdempotencyKey(args?: { now?: () => number }): string {
    const next = nextSeq()
    const uuid = getRandomUUID()
    if (uuid) return `${IDEMPOTENCY_PREFIX}_${next}_${uuid}`
    const now = args?.now ? args.now() : Date.now()
    return `${IDEMPOTENCY_PREFIX}_${now}_${next}`
}

export function createOpId(prefix: string, args?: { now?: () => number }): string {
    const p = (typeof prefix === 'string' && prefix) ? prefix : 'op'
    const next = nextSeq()
    const now = args?.now ? args.now() : Date.now()
    return `${p}_${now}_${next}`
}

export const ids = {
    createIdempotencyKey,
    createOpId
} as const

