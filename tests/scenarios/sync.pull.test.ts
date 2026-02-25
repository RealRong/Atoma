import { describe, expect, it } from 'vitest'
import { type SyncEvent } from 'atoma-types/sync'
import { createHttpDemoClient } from '../support/createDemoClient'
import { assertEventually } from '../support/assertEventually'
import { useScenarioHarness } from '../support/harness'
import { createTestId } from '../support/ids'

function resolveServerMode(): 'in-process' | 'tcp' {
    const raw = String(process.env.ATOMA_DEMO_SERVER_MODE ?? 'in-process').trim()
    return raw === 'tcp' ? 'tcp' : 'in-process'
}

const harness = useScenarioHarness()

describe.sequential('sync.pull', () => {
    it('reader pull should receive writer data', async () => {
        const server = await harness.createServer({
            mode: resolveServerMode()
        })

        const syncEvents: SyncEvent[] = []
        const syncErrors: string[] = []
        const userId = createTestId('u-sync-pull')

        const writer = harness.trackClient(
            createHttpDemoClient({
                baseURL: server.baseURL,
                fetchFn: server.request,
                enableSync: false,
                enableHistory: false
            })
        )
        const reader = harness.trackClient(
            createHttpDemoClient({
                baseURL: server.baseURL,
                fetchFn: server.request,
                enableSync: true,
                enableHistory: false,
                syncMode: 'pull-only',
                syncResources: ['users'],
                onSyncEvent: (event) => {
                    syncEvents.push(event)
                },
                onSyncError: (error, context) => {
                    syncErrors.push(`${context.phase}:${error.message}`)
                }
            })
        )

        await writer.stores('users').create({
            id: userId,
            name: 'Sync Pull User',
            age: 29,
            region: 'US'
        })

        expect(reader.sync?.status().configured).toBe(true)
        await reader.sync?.pull()

        await assertEventually(async () => {
            const pulled = await reader.stores('users').get(userId)
            expect(pulled?.id).toBe(userId)
        })

        expect(syncErrors).toHaveLength(0)
        expect(syncEvents.some((event) => event.type === 'sync.pull.batch')).toBe(true)
    })
})
