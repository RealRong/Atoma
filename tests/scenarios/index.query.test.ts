import { describe, expect, it } from 'vitest'
import { createLocalDemoClient } from '../support/createDemoClient'
import { createDemoSeed, createUserFilterByRegionAndMinAge } from '../support/demoSchema'
import { useScenarioHarness } from '../support/harness'

const harness = useScenarioHarness()

describe('index.query', () => {
    it('query by indexed fields should return stable result', async () => {
        const client = harness.trackClient(
            await createLocalDemoClient({
                seed: createDemoSeed(),
                enableSync: false
            })
        )
        const users = client.stores('users')

        const result = await users.query({
            filter: createUserFilterByRegionAndMinAge({ region: 'EU', minAge: 20 }),
            sort: [{ field: 'age', dir: 'asc' }],
            page: { mode: 'offset', limit: 20, offset: 0, includeTotal: true }
        })

        expect(result.data.length).toBeGreaterThan(0)
        expect(result.pageInfo?.total).toBeGreaterThanOrEqual(result.data.length)
    })
})
