export function addJitter(base: number): number {
    const jitter = Math.random() * 0.3 * base
    return base + jitter
}

export function calculateBackoff(
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
