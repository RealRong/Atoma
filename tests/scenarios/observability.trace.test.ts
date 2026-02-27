import { describe, expect, it } from 'vitest'
import type { DebugEvent } from 'atoma-types/observability'
import { createObservableDemoClient } from '../support/createObservableDemoClient'
import { assertEventually } from '../support/assertEventually'
import { useScenarioHarness } from '../support/harness'
import { createTestId } from '../support/ids'

const harness = useScenarioHarness()

describe('observability.trace', () => {
    it('write path should emit debug events', async () => {
        const events: DebugEvent[] = []
        const client = harness.trackClient(
            await createObservableDemoClient({
                observability: {
                    debug: { enabled: true, sample: 1, payload: true },
                    debugSink: (event) => {
                        events.push(event)
                    }
                }
            })
        )
        const userId = createTestId('u-obs')

        await client.stores('users').create({
            id: userId,
            name: 'Obs User',
            age: 28,
            region: 'US'
        })

        await assertEventually(() => {
            expect(events.some((event) => event.type === 'obs:write:start')).toBe(true)
            expect(events.some((event) => event.type === 'obs:write:finish')).toBe(true)
        })
    })
})
