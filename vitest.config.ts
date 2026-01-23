import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: [
            { find: /^#client$/, replacement: path.resolve(__dirname, 'packages/atoma/src/client/index.ts') },
            { find: /^#client\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/client/$1') },

            { find: /^#core$/, replacement: path.resolve(__dirname, 'packages/atoma/src/core/index.ts') },
            { find: /^#core\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/core/$1') },

            { find: /^#shared$/, replacement: path.resolve(__dirname, 'packages/atoma/src/shared/index.ts') },
            { find: /^#shared\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/shared/$1') },

            { find: /^#observability$/, replacement: path.resolve(__dirname, 'packages/atoma/src/observability/index.ts') },
            { find: /^#observability\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/observability/$1') },

            { find: /^#protocol$/, replacement: path.resolve(__dirname, 'packages/atoma/src/protocol/index.ts') },
            { find: /^#protocol\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma/src/protocol/$1') },

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
