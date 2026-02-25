# Atoma 小场景测试基建评估与落地指南

> 范围：根目录 `tests/support` 及其在 CRUD / index / sync / history / observability 小测试中的可用性。

## 0. 结论（先说结果）

`tests/support` **目前“可用但不够系统”**：

1. 作为单文件集成测试底座（`tests/test.ts`）是够的。
2. 作为“多个小测试文件”的长期基础设施还不够，主要缺少统一 harness、最终一致性断言和 observability 快速装配。

结论等级：`P0 可跑通`，`P1 可维护性不足`。

## 1. 现有基础设施盘点

当前文件：

1. `tests/support/demoSchema.ts`
   - 提供 demo 实体、schema（含索引与关系）、seed、组合 filter 构造。
2. `tests/support/createDemoClient.ts`
   - 提供 memory / http 两种 client 构建，支持 history、sync 开关。
3. `tests/support/createSqliteDemoServer.ts`
   - 提供 sqlite server（in-process / tcp）与 `request`、`close`、`dataSource`。
4. `tests/test.ts`
   - 当前是“大集成文件”，已覆盖 CRUD/query/history、http+sqlite、sync pull 基础流。

## 2. 足够性评估（按测试主题）

1. 基础 CRUD：`足够`
   - memory client + seed 已能快速写测试。
2. index 查询：`足够`
   - schema 内已有 `users.region/users.age` 等索引字段，可直接写 query 断言。
3. sync：`部分足够`
   - server + writer/reader 客户端基础具备，但缺少 `eventual` 轮询断言 helper。
4. history：`足够`
   - `historyPlugin` 默认可挂，`canUndo/undo/redo` 可直接断言。
5. observability：`不足`
   - 现有 `createDemoClient` 没有 observability 快速装配入口，需要每个测试手动 `createClient + observabilityPlugin`。

## 3. 关键缺口（建议补齐）

建议在 `tests/support` 新增 4 个最小能力：

1. `tests/support/harness.ts`
   - 统一创建 client/server 与清理，消除每个测试重复 `afterEach`。
2. `tests/support/assertEventually.ts`
   - 提供 `assertEventually(fn, { timeoutMs, intervalMs })`，用于 sync 最终一致性断言。
3. `tests/support/createObservableDemoClient.ts`（或扩展 `createDemoClient`）
   - 一步挂载 `observabilityPlugin` 并暴露 `observe`。
4. `tests/support/ids.ts`
   - 统一生成测试唯一 id，避免并发/重跑冲突。

## 4. 小测试拆分建议（目录）

建议把当前大文件拆成独立场景文件：

```text
tests/scenarios/
  crud.basic.test.ts
  index.query.test.ts
  history.undo-redo.test.ts
  sync.pull.test.ts
  sync.push.test.ts
  observability.trace.test.ts
```

每个文件只做一件事，避免“一个 case 里验证所有能力”。

## 5. 执行策略（快慢分层）

1. L0（快速，默认 PR 必跑）
   - memory：CRUD / index / history / observability。
2. L1（中速，PR 关键改动必跑）
   - http + sqlite(in-process)：sync pull/push、server 语义。
3. L2（慢速，日跑或发布前）
   - http + sqlite(tcp)：网络形态 smoke。

## 6. 小测试模板（可直接参考）

### 6.1 CRUD（memory）

```ts
import { describe, expect, it } from 'vitest'
import { createMemoryDemoClient } from '../support/createDemoClient'
import { createDemoSeed } from '../support/demoSchema'

describe('crud.basic', () => {
    it('create/update/delete should work', async () => {
        const client = createMemoryDemoClient({ seed: createDemoSeed(), enableSync: false })
        const users = client.stores('users')

        await users.create({ id: 'u-crud-1', name: 'Neo', age: 20, region: 'US' })
        await users.update('u-crud-1', (current) => ({ ...current, age: current.age + 1 }))
        expect((await users.get('u-crud-1'))?.age).toBe(21)

        await users.delete('u-crud-1')
        expect(await users.get('u-crud-1')).toBeUndefined()

        client.dispose()
    })
})
```

### 6.2 Index 查询（memory）

```ts
import { describe, expect, it } from 'vitest'
import { createMemoryDemoClient } from '../support/createDemoClient'
import { createDemoSeed, createUserFilterByRegionAndMinAge } from '../support/demoSchema'

describe('index.query', () => {
    it('query by indexed fields should return stable result', async () => {
        const client = createMemoryDemoClient({ seed: createDemoSeed(), enableSync: false })
        const users = client.stores('users')

        const result = await users.query({
            filter: createUserFilterByRegionAndMinAge({ region: 'EU', minAge: 20 }),
            sort: [{ field: 'age', dir: 'asc' }],
            page: { mode: 'offset', limit: 20, offset: 0, includeTotal: true }
        })

        expect(result.data.length).toBeGreaterThan(0)
        expect(result.pageInfo?.total).toBeGreaterThanOrEqual(result.data.length)
        client.dispose()
    })
})
```

### 6.3 Sync（http + sqlite）

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpDemoClient } from '../support/createDemoClient'
import { createSqliteDemoServer, type SqliteDemoServer } from '../support/createSqliteDemoServer'

describe.sequential('sync.pull', () => {
    let server: SqliteDemoServer | null = null
    const clients: Array<{ dispose: () => void }> = []

    afterEach(async () => {
        while (clients.length > 0) clients.pop()?.dispose()
        if (server) await server.close()
        server = null
    })

    it('reader pull should receive writer data', async () => {
        server = await createSqliteDemoServer({ mode: 'in-process' })

        const writer = createHttpDemoClient({ baseURL: server.baseURL, fetchFn: server.request, enableSync: false, enableHistory: false })
        const reader = createHttpDemoClient({
            baseURL: server.baseURL,
            fetchFn: server.request,
            enableSync: true,
            syncMode: 'pull-only',
            syncResources: ['users'],
            enableHistory: false
        })
        clients.push(writer, reader)

        await writer.stores('users').create({ id: 'u-sync-1', name: 'Sync', age: 30, region: 'US' })
        await reader.sync?.pull()

        const pulled = await reader.stores('users').get('u-sync-1')
        expect(pulled?.id).toBe('u-sync-1')
    })
})
```

### 6.4 History（memory）

```ts
import { describe, expect, it } from 'vitest'
import { createMemoryDemoClient } from '../support/createDemoClient'

describe('history.undo-redo', () => {
    it('undo/redo should rollback and replay', async () => {
        const client = createMemoryDemoClient({ enableHistory: true, enableSync: false })
        const users = client.stores('users')

        await users.create({ id: 'u-history-1', name: 'A', age: 18, region: 'EU' })
        await users.update('u-history-1', (current) => ({ ...current, age: 19 }))
        expect(client.history?.canUndo()).toBe(true)

        const undoOk = await client.history?.undo()
        expect(undoOk).toBe(true)
        expect((await users.get('u-history-1'))?.age).toBe(18)

        const redoOk = await client.history?.redo()
        expect(redoOk).toBe(true)
        expect((await users.get('u-history-1'))?.age).toBe(19)

        client.dispose()
    })
})
```

### 6.5 Observability（memory）

```ts
import { describe, expect, it } from 'vitest'
import { createClient } from 'atoma-client'
import { memoryBackendPlugin } from 'atoma-backend-memory'
import { observabilityPlugin, type ObservabilityExtension } from 'atoma-observability'
import type { AtomaClient } from 'atoma-types/client'
import type { DebugEvent } from 'atoma-types/observability'
import type { DemoEntities, DemoSchema } from '../support/demoSchema'
import { demoSchema } from '../support/demoSchema'

describe('observability.trace', () => {
    it('write path should emit debug events', async () => {
        const events: DebugEvent[] = []
        const client = createClient<DemoEntities, DemoSchema>({
            stores: { schema: demoSchema },
            plugins: [memoryBackendPlugin(), observabilityPlugin()]
        }) as AtomaClient<DemoEntities, DemoSchema> & ObservabilityExtension

        client.observe.registerStore({
            storeName: 'users',
            debug: { enabled: true, sample: 1, payload: true },
            debugSink: (event) => events.push(event)
        })

        await client.stores('users').create({ id: 'u-obs-1', name: 'Obs', age: 28, region: 'US' })
        expect(events.some((event) => event.type === 'obs:write:start')).toBe(true)
        expect(events.some((event) => event.type === 'obs:write:finish')).toBe(true)

        client.dispose()
    })
})
```

## 7. 运行命令建议

1. 跑全部小场景：
   - `pnpm vitest run --config vitest.demo.config.ts "tests/scenarios/**/*.test.ts"`
2. 跑单个文件：
   - `pnpm vitest run --config vitest.demo.config.ts tests/scenarios/sync.pull.test.ts`
3. tcp 模式 smoke：
   - `ATOMA_DEMO_SERVER_MODE=tcp pnpm vitest run --config vitest.demo.config.ts tests/scenarios/sync.pull.test.ts`

## 8. 注意事项（当前仓库现实）

1. `vitest.demo.config.ts` 默认 include `tests/**/*.test.ts`，建议新文件统一使用 `*.test.ts`。
2. 现有 `tests/test.ts` 是系统集成入口，可保留为 smoke；新增小测试不要继续堆进同一文件。
3. sync 相关断言尽量避免“立即一致”假设，优先事件驱动或 `eventual` 轮询断言。
