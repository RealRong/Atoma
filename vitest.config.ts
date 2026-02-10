import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: [
            { find: /^atoma-client$/, replacement: path.resolve(__dirname, 'packages/atoma-client/src/index.ts') },
            { find: /^atoma-core\/store$/, replacement: path.resolve(__dirname, 'packages/atoma-core/src/store/index.ts') },
            { find: /^atoma-core\/query$/, replacement: path.resolve(__dirname, 'packages/atoma-core/src/query/index.ts') },
            { find: /^atoma-core\/relations$/, replacement: path.resolve(__dirname, 'packages/atoma-core/src/relations/index.ts') },
            { find: /^atoma-core\/indexes$/, replacement: path.resolve(__dirname, 'packages/atoma-core/src/indexes/index.ts') },
            { find: /^atoma-core\/operation$/, replacement: path.resolve(__dirname, 'packages/atoma-core/src/operation.ts') },
            { find: /^atoma-shared$/, replacement: path.resolve(__dirname, 'packages/atoma-shared/src/index.ts') },
            { find: /^atoma-observability$/, replacement: path.resolve(__dirname, 'packages/plugins/atoma-observability/src/index.ts') },
            { find: /^atoma-types\/protocol-tools$/, replacement: path.resolve(__dirname, 'packages/atoma-types/src/protocol-tools/index.ts') },

            { find: /^atoma-sync$/, replacement: path.resolve(__dirname, 'packages/plugins/atoma-sync/src/index.ts') },
            { find: /^atoma-sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/plugins/atoma-sync/src/$1') },

            { find: /^#sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/plugins/atoma-sync/src/$1') },

            { find: /^#backend$/, replacement: path.resolve(__dirname, 'packages/atoma/src/backend/index.ts') },
            { find: /^#backend\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/backend/$1') },

            { find: /^#batch$/, replacement: path.resolve(__dirname, 'packages/atoma/src/batch/index.ts') },
            { find: /^#batch\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/batch/$1') },
        ]
    }
})
