export type RequestSequencer = {
    next: (traceId: string) => string
}
