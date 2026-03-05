import { normalizePositiveInt } from './number'

export type RetryOptions = {
    maxAttempts?: number
    backoff?: 'exponential' | 'linear'
    initialDelayMs?: number
    maxElapsedMs?: number
    jitter?: boolean
}

function addJitter(base: number): number {
    const jitter = Math.random() * 0.3 * base
    return base + jitter
}

function calculateBackoffDelay(args: {
    backoff: 'exponential' | 'linear'
    initialDelayMs: number
    attempt: number
    jitter: boolean
}): number {
    const base = args.backoff === 'exponential'
        ? args.initialDelayMs * Math.pow(2, Math.max(0, args.attempt - 1))
        : args.initialDelayMs * Math.max(1, args.attempt)
    return args.jitter ? addJitter(base) : base
}

function resolveSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
    if (init?.signal) return init.signal
    if (typeof Request !== 'undefined' && input instanceof Request) {
        return input.signal
    }
    return undefined
}

export function isAbortError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError')
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

export async function fetchWithRetry(args: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    input: RequestInfo | URL
    init?: RequestInit
    retry?: RetryOptions
}): Promise<Response> {
    const maxAttempts = normalizePositiveInt(args.retry?.maxAttempts, 3)
    const maxElapsedMs = normalizePositiveInt(args.retry?.maxElapsedMs, 30_000)
    const initialDelayMs = normalizePositiveInt(args.retry?.initialDelayMs, 1000)
    const backoff = args.retry?.backoff ?? 'exponential'
    const jitter = args.retry?.jitter === true
    const startedAt = Date.now()
    const signal = resolveSignal(args.input, args.init)
    let attempt = 0
    let lastError: unknown

    while (attempt < maxAttempts) {
        attempt += 1
        try {
            if (signal?.aborted) {
                throw new Error('Request aborted')
            }

            const response = await args.fetchFn(args.input, args.init)
            if (response.status >= 500) {
                throw new Error(`Server error: ${response.status}`)
            }
            return response
        } catch (error) {
            lastError = error
            if (signal?.aborted || isAbortError(error)) {
                throw error
            }
            if (attempt >= maxAttempts) {
                break
            }

            const delay = calculateBackoffDelay({
                backoff,
                initialDelayMs,
                attempt,
                jitter
            })
            if (Date.now() - startedAt + delay > maxElapsedMs) {
                break
            }
            await sleep(delay)
        }
    }

    if (lastError instanceof Error) {
        throw lastError
    }
    throw new Error('Request failed')
}
