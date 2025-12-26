export type RetryConfig = {
    maxAttempts?: number
    backoff?: 'exponential' | 'linear'
    initialDelay?: number
    maxElapsedMs?: number
    jitter?: boolean
}

function addJitter(base: number): number {
    const jitter = Math.random() * 0.3 * base
    return base + jitter
}

function calculateBackoff(
    backoff: 'exponential' | 'linear',
    initialDelay: number,
    attempt: number,
    jitter: boolean
): number {
    const base = backoff === 'exponential'
        ? initialDelay * Math.pow(2, attempt - 1)
        : initialDelay * attempt
    return jitter ? addJitter(base) : base
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function fetchWithRetry(
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    retry: RetryConfig | undefined,
    startedAt = Date.now(),
    attemptNumber = 1
): Promise<Response> {
    try {
        const response = await fetchFn(input, init)

        // Don't retry client errors (4xx except 409)
        if (response.status >= 400 && response.status < 500 && response.status !== 409) {
            return response
        }

        // Retry server errors (5xx)
        if (response.status >= 500) {
            throw new Error(`Server error: ${response.status}`)
        }

        return response
    } catch (error) {
        const maxAttempts = retry?.maxAttempts ?? 3
        if (attemptNumber >= maxAttempts) throw error

        const maxElapsedMs = retry?.maxElapsedMs ?? 30_000
        const elapsed = Date.now() - startedAt
        if (elapsed >= maxElapsedMs) throw error

        const backoff = retry?.backoff ?? 'exponential'
        const initialDelay = retry?.initialDelay ?? 1000
        const delay = calculateBackoff(backoff, initialDelay, attemptNumber, retry?.jitter === true)

        await sleep(delay)
        return fetchWithRetry(fetchFn, input, init, retry, startedAt, attemptNumber + 1)
    }
}

