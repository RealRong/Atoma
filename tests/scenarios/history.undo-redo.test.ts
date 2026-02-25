import { describe, expect, it } from 'vitest'
import { createMemoryDemoClient } from '../support/createDemoClient'
import { useScenarioHarness } from '../support/harness'
import { createTestId } from '../support/ids'

const harness = useScenarioHarness()

describe('history.undo-redo', () => {
    it('undo/redo should rollback and replay', async () => {
        const client = harness.trackClient(
            createMemoryDemoClient({
                enableHistory: true,
                enableSync: false
            })
        )
        const users = client.stores('users')
        const userId = createTestId('u-history')

        await users.create({
            id: userId,
            name: 'History User',
            age: 18,
            region: 'EU'
        })
        await users.update(userId, (current) => ({
            ...current,
            age: current.age + 1
        }))

        expect(client.history?.canUndo()).toBe(true)

        const undoOk = await client.history?.undo()
        expect(undoOk).toBe(true)
        expect(client.history?.canRedo()).toBe(true)

        const redoOk = await client.history?.redo()
        expect(redoOk).toBe(true)
        expect(client.history?.canUndo()).toBe(true)
    })
})
