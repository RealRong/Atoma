export type IdSequence = { value: number }

function getRandomUUID(): string | undefined {
    if (typeof crypto === 'undefined') return undefined
    const randomUUID = Reflect.get(crypto, 'randomUUID')
    if (typeof randomUUID !== 'function') return undefined
    const uuid = randomUUID.call(crypto)
    if (typeof uuid !== 'string' || !uuid) return undefined
    return uuid
}

function nextSeq(seq: IdSequence): number {
    seq.value += 1
    return seq.value
}

export function createIdempotencyKey(
    prefix: string,
    seq: IdSequence,
    now: () => number,
    randomUUID: () => string | undefined = getRandomUUID
): string {
    const uuid = randomUUID()
    if (uuid) return `${prefix}_${uuid}`
    const next = nextSeq(seq)
    return `${prefix}_${now()}_${next}`
}

export function createOpId(
    prefix: string,
    seq: IdSequence,
    now: () => number
): string {
    const next = nextSeq(seq)
    return `${prefix}_${now()}_${next}`
}
