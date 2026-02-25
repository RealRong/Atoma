import { afterEach, describe, expect, it } from 'vitest'
import { createDemoSeed, createUserFilterByRegionAndMinAge } from './support/demoSchema'
import { createHttpDemoClient, createMemoryDemoClient, type DemoClient } from './support/createDemoClient'
import { createSqliteDemoServer, type SqliteDemoServer } from './support/createSqliteDemoServer'

function resolveServerMode(): 'in-process' | 'tcp' {
    const raw = String(process.env.ATOMA_DEMO_SERVER_MODE ?? 'in-process').trim()
    return raw === 'tcp' ? 'tcp' : 'in-process'
}

describe.sequential('Demo No-UI Integration System', () => {
    let currentServer: SqliteDemoServer | null = null
    const clients: DemoClient[] = []

    afterEach(async () => {
        while (clients.length > 0) {
            try {
                clients.pop()?.dispose()
            } catch {
                // ignore
            }
        }

        if (currentServer) {
            await currentServer.close()
            currentServer = null
        }
    })

    it('memory backend should cover CRUD + query + history', async () => {
        const seed = createDemoSeed()
        const client = createMemoryDemoClient({
            seed,
            enableHistory: true,
            enableSync: false
        })
        clients.push(client)

        const users = client.stores('users')

        const listBefore = await users.list()
        expect(listBefore).toHaveLength(4)

        const created = await users.create({
            id: 'u5',
            name: 'Ema',
            age: 30,
            region: 'EU'
        })
        expect(created.id).toBe('u5')

        await users.update('u5', (current) => ({
            ...current,
            age: current.age + 1
        }))

        const query = await users.query({
            filter: createUserFilterByRegionAndMinAge({ region: 'EU', minAge: 28 }),
            sort: [{ field: 'age', dir: 'asc' }],
            page: { mode: 'offset', limit: 20, offset: 0, includeTotal: true }
        })
        expect(query.data.some((item) => item.id === 'u5')).toBe(true)
        expect(query.pageInfo?.total).toBeGreaterThanOrEqual(1)

        const canUndo = client.history?.canUndo() ?? false
        expect(canUndo).toBe(true)
        const undoOk = await client.history?.undo()
        expect(undoOk).toBe(true)
    })

    it('http + sqlite backend should pass client API flow and persist rows', async () => {
        currentServer = await createSqliteDemoServer({
            mode: resolveServerMode()
        })

        const client = createHttpDemoClient({
            baseURL: currentServer.baseURL,
            fetchFn: currentServer.request,
            enableHistory: true,
            enableSync: false
        })
        clients.push(client)

        const seed = createDemoSeed()
        const users = client.stores('users')
        const posts = client.stores('posts')
        const comments = client.stores('comments')

        await users.createMany(seed.users)
        await posts.createMany(seed.posts)
        await comments.createMany(seed.comments)

        const userList = await users.list()
        expect(userList).toHaveLength(seed.users.length)

        const result = await users.query({
            filter: createUserFilterByRegionAndMinAge({ region: 'EU', minAge: 20 }),
            sort: [{ field: 'age', dir: 'asc' }],
            page: { mode: 'offset', limit: 20, offset: 0, includeTotal: true }
        })
        expect(result.data.length).toBeGreaterThan(0)
        expect(result.pageInfo?.total).toBeGreaterThanOrEqual(1)

        const postCountRows = await currentServer.dataSource.query('SELECT COUNT(*) AS count FROM posts')
        const postCount = Number(postCountRows[0]?.count ?? 0)
        expect(postCount).toBe(seed.posts.length)
    })

    it('sync pull API should run against http+sqlite transport', async () => {
        currentServer = await createSqliteDemoServer({
            mode: resolveServerMode()
        })

        const syncEvents: string[] = []
        const syncErrors: string[] = []

        const writer = createHttpDemoClient({
            baseURL: currentServer.baseURL,
            fetchFn: currentServer.request,
            enableHistory: false,
            enableSync: false
        })
        const reader = createHttpDemoClient({
            baseURL: currentServer.baseURL,
            fetchFn: currentServer.request,
            enableHistory: false,
            enableSync: true,
            syncMode: 'pull-only',
            subscribe: false,
            syncClientKey: `reader-${Date.now()}`,
            onSyncEvent: (event) => {
                syncEvents.push(event.type)
            },
            onSyncError: (error, context) => {
                syncErrors.push(`${context.phase}:${error.message}`)
            }
        })
        clients.push(writer, reader)

        const writerUsers = writer.stores('users')
        await writerUsers.create({
            id: 'u-sync-1',
            name: 'Sync User',
            age: 29,
            region: 'US'
        })

        const changeRows = await currentServer.dataSource.query('SELECT COUNT(*) AS count FROM atoma_changes')
        expect(Number(changeRows[0]?.count ?? 0)).toBeGreaterThan(0)

        const configured = reader.sync?.status().configured ?? false
        expect(configured).toBe(true)
        await reader.sync?.pull()

        expect(syncErrors).toHaveLength(0)
        expect(syncEvents.includes('pull:start')).toBe(true)
        expect(syncEvents.includes('pull:idle')).toBe(true)
    })
})
