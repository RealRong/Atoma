import { createClient } from 'atoma-client'
import { memoryBackendPlugin } from 'atoma-backend-memory'
import { observabilityPlugin } from 'atoma-observability'
import type { AtomaClient } from 'atoma-types/client'
import type { DemoEntities, DemoSchema, DemoSeed } from './demoSchema'
import { demoSchema } from './demoSchema'

export type ObservableDemoClient = AtomaClient<DemoEntities, DemoSchema>

export function createObservableDemoClient(options: Readonly<{
    seed?: DemoSeed
    observability?: Parameters<typeof observabilityPlugin>[0]
}> = {}): ObservableDemoClient {
    return createClient<DemoEntities, DemoSchema>({
        stores: {
            schema: demoSchema
        },
        plugins: [
            memoryBackendPlugin(options.seed ? { seed: options.seed as unknown as Record<string, any[]> } : undefined),
            observabilityPlugin(options.observability)
        ]
    }) as ObservableDemoClient
}
