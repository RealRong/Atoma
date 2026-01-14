import type { EntityId } from '#protocol'

export function resolveFiniteVersion(value: unknown): number | undefined {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    return (typeof v === 'number' && Number.isFinite(v)) ? v : undefined
}

export function resolvePositiveVersion(value: unknown): number | undefined {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : undefined
}

export function requireBaseVersion(id: EntityId, value: unknown): number {
    const v = resolvePositiveVersion(value)
    if (typeof v === 'number') return v
    throw new Error(`[Atoma] write requires baseVersion (missing version for id=${String(id)})`)
}

