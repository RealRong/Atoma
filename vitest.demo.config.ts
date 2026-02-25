import path from 'node:path'
import { defineConfig } from 'vitest/config'

const resolvePath = (target: string) => path.resolve(__dirname, target)

export default defineConfig({
    resolve: {
        alias: [
            { find: /^atoma$/, replacement: resolvePath('packages/atoma/src/index.ts') },
            { find: /^atoma-client$/, replacement: resolvePath('packages/atoma-client/src/index.ts') },
            { find: /^atoma-core$/, replacement: resolvePath('packages/atoma-core/src/index.ts') },
            { find: /^atoma-core\/(.*)$/, replacement: resolvePath('packages/atoma-core/src/$1') },
            { find: /^atoma-runtime$/, replacement: resolvePath('packages/atoma-runtime/src/index.ts') },
            { find: /^atoma-runtime\/(.*)$/, replacement: resolvePath('packages/atoma-runtime/src/$1') },
            { find: /^atoma-react$/, replacement: resolvePath('packages/atoma-react/src/index.ts') },
            { find: /^atoma-types$/, replacement: resolvePath('packages/atoma-types/src/index.ts') },
            { find: /^atoma-types\/(.*)$/, replacement: resolvePath('packages/atoma-types/src/$1') },
            { find: /^atoma-shared$/, replacement: resolvePath('packages/atoma-shared/src/index.ts') },

            { find: /^atoma-backend-shared$/, replacement: resolvePath('packages/plugins/atoma-backend-shared/src/index.ts') },
            { find: /^atoma-backend-memory$/, replacement: resolvePath('packages/plugins/atoma-backend-memory/src/index.ts') },
            { find: /^atoma-backend-indexeddb$/, replacement: resolvePath('packages/plugins/atoma-backend-indexeddb/src/index.ts') },
            { find: /^atoma-backend-http$/, replacement: resolvePath('packages/plugins/atoma-backend-http/src/index.ts') },
            { find: /^atoma-backend-atoma-server$/, replacement: resolvePath('packages/plugins/atoma-backend-atoma-server/src/index.ts') },

            { find: /^atoma-sync$/, replacement: resolvePath('packages/plugins/atoma-sync/src/index.ts') },
            { find: /^atoma-sync\/(.*)$/, replacement: resolvePath('packages/plugins/atoma-sync/src/$1') },
            { find: /^#sync\/(.*)$/, replacement: resolvePath('packages/plugins/atoma-sync/src/$1') },

            { find: /^atoma-history$/, replacement: resolvePath('packages/plugins/atoma-history/src/index.ts') },
            { find: /^atoma-observability$/, replacement: resolvePath('packages/plugins/atoma-observability/src/index.ts') },
            { find: /^atoma-devtools$/, replacement: resolvePath('packages/plugins/atoma-devtools/src/index.ts') },

            { find: /^atoma-server$/, replacement: resolvePath('packages/atoma-server/src/index.ts') },
            { find: /^atoma-server\/(.*)$/, replacement: resolvePath('packages/atoma-server/src/$1') },

            // Force TypeORM to resolve from demo/server workspace so sqlite3 peer is available.
            { find: /^typeorm$/, replacement: resolvePath('demo/server/node_modules/typeorm/index.js') },
        ]
    },
    test: {
        environment: 'node',
        hookTimeout: 120_000,
        testTimeout: 120_000,
        include: [
            'tests/**/*.test.ts',
            'bench/**/*.bench.ts'
        ],
        exclude: [
            'node_modules/**',
            'dist/**'
        ]
    }
})
