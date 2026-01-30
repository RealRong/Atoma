import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: [
            { find: /^#client$/, replacement: path.resolve(__dirname, 'packages/atoma-client/src/index.ts') },
            { find: /^#client\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma-client/src/$1') },

            { find: /^atoma-client$/, replacement: path.resolve(__dirname, 'packages/atoma-client/src/index.ts') },
            { find: /^atoma-core$/, replacement: path.resolve(__dirname, 'packages/atoma-core/src/index.ts') },
            { find: /^atoma-shared$/, replacement: path.resolve(__dirname, 'packages/atoma-shared/src/index.ts') },
            { find: /^atoma-observability$/, replacement: path.resolve(__dirname, 'packages/atoma-observability/src/index.ts') },
            { find: /^atoma-protocol$/, replacement: path.resolve(__dirname, 'packages/atoma-protocol/src/index.ts') },

            { find: /^atoma-sync$/, replacement: path.resolve(__dirname, 'packages/atoma-sync/src/index.ts') },
            { find: /^atoma-sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma-sync/src/$1') },

            { find: /^#sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma-sync/src/$1') },

            { find: /^#backend$/, replacement: path.resolve(__dirname, 'packages/atoma/src/backend/index.ts') },
            { find: /^#backend\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/backend/$1') },

            { find: /^#batch$/, replacement: path.resolve(__dirname, 'packages/atoma/src/batch/index.ts') },
            { find: /^#batch\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/batch/$1') },
        ]
    }
})
