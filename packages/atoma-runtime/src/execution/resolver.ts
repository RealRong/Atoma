import type { CreateExecutionError } from './errors'
import type {
    KernelPhase,
    KernelResolvedExecution,
    KernelSnapshot
} from './kernelTypes'

type ResolveExecutionArgs = Readonly<{
    snapshot: KernelSnapshot
    phase: KernelPhase
    createError: CreateExecutionError
}>

export function resolveExecution({
    snapshot,
    phase,
    createError
}: ResolveExecutionArgs): KernelResolvedExecution | undefined {
    const resolved = snapshot[phase]
    if (!resolved) return undefined

    const executor = String(resolved.resolution.executor ?? '').trim()
    if (!executor) {
        throw createError({
            code: 'E_EXECUTION_BUNDLE_INVALID',
            message: `[Atoma] execution: executor 非法（phase=${phase}）`,
            retryable: false
        })
    }

    return resolved
}
