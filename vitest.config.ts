import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: [
            { find: /^@atoma-js\/client$/, replacement: path.resolve(__dirname, 'packages/client/src/index.ts') },
            { find: /^@atoma-js\/core\/store$/, replacement: path.resolve(__dirname, 'packages/core/src/store/index.ts') },
            { find: /^@atoma-js\/core\/query$/, replacement: path.resolve(__dirname, 'packages/core/src/query/index.ts') },
            { find: /^@atoma-js\/core\/relations$/, replacement: path.resolve(__dirname, 'packages/core/src/relations/index.ts') },
            { find: /^@atoma-js\/core\/indexes$/, replacement: path.resolve(__dirname, 'packages/core/src/indexes/index.ts') },
            { find: /^@atoma-js\/core\/operation$/, replacement: path.resolve(__dirname, 'packages/core/src/operation.ts') },
            { find: /^@atoma-js\/shared$/, replacement: path.resolve(__dirname, 'packages/shared/src/index.ts') },
            { find: /^@atoma-js\/observability$/, replacement: path.resolve(__dirname, 'packages/plugins/observability/src/index.ts') },
            { find: /^@atoma-js\/types\/tools$/, replacement: path.resolve(__dirname, 'packages/types/src/tools/index.ts') },

            { find: /^@atoma-js\/sync$/, replacement: path.resolve(__dirname, 'packages/plugins/sync/src/index.ts') },
            { find: /^@atoma-js\/sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/plugins/sync/src/$1') },

            { find: /^#sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/plugins/sync/src/$1') },

            { find: /^#backend$/, replacement: path.resolve(__dirname, 'packages/atoma/src/backend/index.ts') },
            { find: /^#backend\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/backend/$1') },

            { find: /^#batch$/, replacement: path.resolve(__dirname, 'packages/atoma/src/batch/index.ts') },
            { find: /^#batch\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/batch/$1') },
        ]
    }
})
