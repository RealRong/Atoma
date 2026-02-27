import { createClient } from 'atoma-client'
import { observabilityPlugin } from 'atoma-observability'
import type { AtomaClient } from 'atoma-types/client'
import type { DemoEntities, DemoSchema, DemoSeed } from './demoSchema'
import { demoSchema } from './demoSchema'

export type ObservableDemoClient = AtomaClient<DemoEntities, DemoSchema>

export async function createObservableDemoClient(options: Readonly<{
    seed?: DemoSeed
    observability?: Parameters<typeof observabilityPlugin>[0]
}> = {}): Promise<ObservableDemoClient> {
    const client = createClient<DemoEntities, DemoSchema>({
        stores: {
            schema: demoSchema
        },
        plugins: [
            observabilityPlugin(options.observability)
        ]
    }) as ObservableDemoClient

    try {
        if (options.seed) {
            await client.stores('users').createMany(options.seed.users)
            await client.stores('posts').createMany(options.seed.posts)
            await client.stores('comments').createMany(options.seed.comments)
        }
    } catch (error) {
        client.dispose()
        throw error
    }

    return client
}
