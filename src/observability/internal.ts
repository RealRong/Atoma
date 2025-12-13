import type { DebugEmitter } from './debug'

const DEBUG_CARRIER = Symbol.for('atoma.debugCarrier')

export type DebugCarrier = {
    emitter: DebugEmitter
}

export function attachDebugCarrier<T extends object>(target: T, carrier: DebugCarrier): T {
    try {
        ;(target as any)[DEBUG_CARRIER] = carrier
    } catch {
        // ignore
    }
    return target
}

export function getDebugCarrier(value: unknown): DebugCarrier | undefined {
    if (!value || typeof value !== 'object') return undefined
    return (value as any)[DEBUG_CARRIER] as DebugCarrier | undefined
}

