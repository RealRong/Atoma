export type RequestIdSequencer = {
    next: (traceId: string) => string
}
