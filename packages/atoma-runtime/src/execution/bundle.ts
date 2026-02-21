import type {
    ExecutionBundle,
    ExecutionSpec,
} from 'atoma-types/runtime'
import type { CreateExecutionError } from './errors'
import type {
    KernelLayer,
    KernelResolvedExecution,
    KernelSnapshot
} from './kernelTypes'

function normalize(value: unknown): string {
    return String(value ?? '').trim()
}

function ensureExecutorSpec({
    id,
    executor,
    createError
}: {
    id: string
    executor: ExecutionSpec | undefined
    createError: CreateExecutionError
}): ExecutionSpec {
    if (!executor || typeof executor !== 'object') {
        throw createError({
            code: 'E_EXECUTION_BUNDLE_INVALID',
            message: `[Atoma] execution.apply: executor 配置缺失: ${id}`,
            retryable: false
        })
    }
    if (typeof executor.query !== 'function' && typeof executor.write !== 'function') {
        throw createError({
            code: 'E_EXECUTION_BUNDLE_INVALID',
            message: `[Atoma] execution.apply: executor 至少实现 query/write 之一: ${id}`,
            retryable: false
        })
    }
    return executor
}

function toResolvedExecution(layer: KernelLayer): KernelResolvedExecution {
    return {
        resolution: {
            executor: layer.id
        },
        spec: layer.executor
    }
}

export function normalizeBundle({
    bundle,
    createError
}: {
    bundle: ExecutionBundle
    createError: CreateExecutionError
}): Omit<KernelLayer, 'token'> {
    const id = normalize(bundle.id)
    if (!id) {
        throw createError({
            code: 'E_EXECUTION_BUNDLE_INVALID',
            message: '[Atoma] execution.apply: bundle.id 必填',
            retryable: false
        })
    }

    const executor = ensureExecutorSpec({
        id,
        executor: bundle.executor,
        createError
    })

    return {
        id,
        executor
    }
}

export function buildSnapshot({
    layers,
    createError
}: {
    layers: ReadonlyArray<KernelLayer>
    createError: CreateExecutionError
}): KernelSnapshot {
    let query: KernelResolvedExecution | undefined
    let write: KernelResolvedExecution | undefined

    layers.forEach((layer) => {
        if (layer.executor.query) {
            if (query) {
                throw createError({
                    code: 'E_EXECUTION_CONFLICT',
                    message: `[Atoma] execution.apply: query executor 冲突: ${layer.id}`,
                    retryable: false,
                    details: { executor: layer.id, phase: 'query' }
                })
            }
            query = toResolvedExecution(layer)
        }

        if (layer.executor.write) {
            if (write) {
                throw createError({
                    code: 'E_EXECUTION_CONFLICT',
                    message: `[Atoma] execution.apply: write executor 冲突: ${layer.id}`,
                    retryable: false,
                    details: { executor: layer.id, phase: 'write' }
                })
            }
            write = toResolvedExecution(layer)
        }
    })

    return {
        ...(query ? { query } : {}),
        ...(write ? { write } : {})
    }
}
