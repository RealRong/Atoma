import { describe, expect, it } from 'vitest'
import { createMemoryDemoClient } from '../support/createDemoClient'
import { createDemoSeed } from '../support/demoSchema'
import { useScenarioHarness } from '../support/harness'
import { createTestId } from '../support/ids'

const harness = useScenarioHarness()

describe('crud.basic', () => {
    it('create/update/delete should work', async () => {
        const client = harness.trackClient(
            createMemoryDemoClient({
                seed: createDemoSeed(),
                enableSync: false
            })
        )
        const users = client.stores('users')
        const userId = createTestId('u-crud')

        await users.create({
            id: userId,
            name: 'Crud User',
            age: 20,
            region: 'US'
        })

        await users.update(userId, (current) => ({
            ...current,
            age: current.age + 1
        }))
        expect((await users.get(userId))?.age).toBe(21)

        await users.delete(userId)
        const deleted = await users.get(userId)
        expect(deleted?.deleted).toBe(true)
        expect(typeof deleted?.deletedAt).toBe('number')
    })
})
