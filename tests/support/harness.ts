import { afterEach } from 'vitest'

type CreateSqliteDemoServer = typeof import('./createSqliteDemoServer').createSqliteDemoServer
type CreateServerOptions = Parameters<CreateSqliteDemoServer>[0]
type SqliteDemoServer = Awaited<ReturnType<CreateSqliteDemoServer>>

type DisposableClient = Readonly<{
    dispose: () => void
}>

export function useScenarioHarness(): {
    createServer: (options?: CreateServerOptions) => Promise<SqliteDemoServer>
    trackClient: <T extends DisposableClient>(client: T) => T
    getServer: () => SqliteDemoServer | null
} {
    let server: SqliteDemoServer | null = null
    const clients: DisposableClient[] = []

    afterEach(async () => {
        while (clients.length > 0) {
            try {
                clients.pop()?.dispose()
            } catch {
                // ignore
            }
        }

        if (!server) return
        try {
            await server.close()
        } finally {
            server = null
        }
    })

    return {
        createServer: async (options) => {
            const { createSqliteDemoServer } = await import('./createSqliteDemoServer')
            server = await createSqliteDemoServer(options)
            return server
        },
        trackClient: (client) => {
            clients.push(client)
            return client
        },
        getServer: () => server
    }
}
