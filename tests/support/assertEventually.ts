type AssertEventuallyOptions = Readonly<{
    timeoutMs?: number
    intervalMs?: number
    message?: string
}>

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

export async function assertEventually(
    check: () => void | boolean | Promise<void | boolean>,
    options: AssertEventuallyOptions = {}
): Promise<void> {
    const timeoutMs = Math.max(100, Math.floor(options.timeoutMs ?? 3_000))
    const intervalMs = Math.max(10, Math.floor(options.intervalMs ?? 50))
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = null

    while (Date.now() < deadline) {
        try {
            const result = await check()
            if (result !== false) {
                return
            }
        } catch (error) {
            lastError = error
        }

        await sleep(intervalMs)
    }

    if (lastError instanceof Error) {
        throw lastError
    }

    throw new Error(options.message ?? `[Test] assertEventually timeout after ${timeoutMs}ms`)
}
