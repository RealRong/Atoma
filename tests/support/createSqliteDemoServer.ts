export type DemoServerMode = 'in-process' | 'tcp'

export type SqliteDemoServer = Readonly<{
    mode: DemoServerMode
    baseURL: string
    dbPath: string
    request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    close: () => Promise<void>
    dataSource: {
        query: (sql: string, parameters?: unknown[]) => Promise<unknown[]>
    }
}>

export async function createSqliteDemoServer(_options: Readonly<{
    mode?: DemoServerMode
    host?: string
    port?: number
    dirPrefix?: string
}> = {}): Promise<SqliteDemoServer> {
    throw new Error(
        '[createSqliteDemoServer] @atoma-js/server 已移除 TypeORM 适配器，请迁移测试基建到 Prisma 方案。'
    )
}
