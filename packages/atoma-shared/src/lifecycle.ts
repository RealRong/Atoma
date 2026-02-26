export function safeDispose(dispose?: (() => void) | null): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

export function disposeInReverse(disposers: Array<() => void>): void {
    while (disposers.length > 0) {
        safeDispose(disposers.pop())
    }
}
