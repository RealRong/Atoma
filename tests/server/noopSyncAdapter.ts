import type { ISyncAdapter } from '../../src/server'

export function createNoopSyncAdapter(): ISyncAdapter {
    return {
        getIdempotency: async () => ({ hit: false }),
        putIdempotency: async () => undefined,
        appendChange: async () => {
            throw new Error('not implemented')
        },
        pullChanges: async () => [],
        waitForChanges: async () => []
    }
}
