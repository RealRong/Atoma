import { describe, expect, it } from 'vitest'
import { type SyncEvent } from '@atoma-js/types/sync'
import { createHttpDemoClient } from '../support/createDemoClient'
import { assertEventually } from '../support/assertEventually'
import { useScenarioHarness } from '../support/harness'
import { createTestId } from '../support/ids'

function resolveServerMode(): 'in-process' | 'tcp' {
    const raw = String(process.env.ATOMA_DEMO_SERVER_MODE ?? 'in-process').trim()
    return raw === 'tcp' ? 'tcp' : 'in-process'
}

const harness = useScenarioHarness()

describe.sequential('sync.push', () => {
    it('writer push should persist local writes to server', async () => {
        const server = await harness.createServer({
            mode: resolveServerMode()
        })

        const syncEvents: SyncEvent[] = []
        const syncErrors: string[] = []
        const userId = createTestId('u-sync-push')

        const writer = harness.trackClient(
            createHttpDemoClient({
                baseURL: server.baseURL,
                fetchFn: server.request,
                enableSync: true,
                enableHistory: false,
                syncMode: 'push-only',
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
            name: 'Sync Push User',
            age: 31,
            region: 'EU'
        })

        expect(writer.sync?.status().configured).toBe(true)
        await writer.sync?.push()

        await assertEventually(async () => {
            const rows = await server.dataSource.query(
                'SELECT COUNT(*) AS count FROM users WHERE id = ?',
                [userId]
            )
            expect(Number(rows[0]?.count ?? 0)).toBe(1)
        })

        expect(syncErrors).toHaveLength(0)
        expect(syncEvents.some((event) => event.type === 'sync.push.batch')).toBe(true)
    })
})
