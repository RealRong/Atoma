import path from 'node:path'
import { defineConfig } from 'vitest/config'

const resolvePath = (target: string) => path.resolve(__dirname, target)

export default defineConfig({
    resolve: {
        alias: [
            { find: /^@atoma-js\/atoma$/, replacement: resolvePath('packages/atoma/src/index.ts') },
            { find: /^@atoma-js\/client$/, replacement: resolvePath('packages/client/src/index.ts') },
            { find: /^@atoma-js\/core$/, replacement: resolvePath('packages/core/src/index.ts') },
            { find: /^@atoma-js\/core\/(.*)$/, replacement: resolvePath('packages/core/src/$1') },
            { find: /^@atoma-js\/runtime$/, replacement: resolvePath('packages/runtime/src/index.ts') },
            { find: /^@atoma-js\/runtime\/(.*)$/, replacement: resolvePath('packages/runtime/src/$1') },
            { find: /^@atoma-js\/react$/, replacement: resolvePath('packages/react/src/index.ts') },
            { find: /^@atoma-js\/types$/, replacement: resolvePath('packages/types/src/index.ts') },
            { find: /^@atoma-js\/types\/(.*)$/, replacement: resolvePath('packages/types/src/$1') },
            { find: /^@atoma-js\/shared$/, replacement: resolvePath('packages/shared/src/index.ts') },

            { find: /^@atoma-js\/backend-shared$/, replacement: resolvePath('packages/plugins/backend-shared/src/index.ts') },
            { find: /^@atoma-js\/backend-indexeddb$/, replacement: resolvePath('packages/plugins/backend-indexeddb/src/index.ts') },
            { find: /^@atoma-js\/backend-http$/, replacement: resolvePath('packages/plugins/backend-http/src/index.ts') },
            { find: /^@atoma-js\/backend-atoma-server$/, replacement: resolvePath('packages/plugins/backend-atoma-server/src/index.ts') },

            { find: /^@atoma-js\/sync$/, replacement: resolvePath('packages/plugins/sync/src/index.ts') },
            { find: /^@atoma-js\/sync\/(.*)$/, replacement: resolvePath('packages/plugins/sync/src/$1') },
            { find: /^#sync\/(.*)$/, replacement: resolvePath('packages/plugins/sync/src/$1') },

            { find: /^@atoma-js\/history$/, replacement: resolvePath('packages/plugins/history/src/index.ts') },
            { find: /^@atoma-js\/observability$/, replacement: resolvePath('packages/plugins/observability/src/index.ts') },
            { find: /^@atoma-js\/devtools$/, replacement: resolvePath('packages/plugins/devtools/src/index.ts') },

            { find: /^@atoma-js\/server$/, replacement: resolvePath('packages/server/src/index.ts') },
            { find: /^@atoma-js\/server\/(.*)$/, replacement: resolvePath('packages/server/src/$1') },

            // Resolve TypeORM from workspace root.
            { find: /^typeorm$/, replacement: resolvePath('node_modules/typeorm/index.js') },
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
