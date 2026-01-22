import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: [
            { find: /^#client$/, replacement: path.resolve(__dirname, 'src/client/index.ts') },
            { find: /^#client\/(.*)$/, replacement: path.resolve(__dirname, 'src/client/$1') },

            { find: /^#core$/, replacement: path.resolve(__dirname, 'src/core/index.ts') },
            { find: /^#core\/(.*)$/, replacement: path.resolve(__dirname, 'src/core/$1') },

            { find: /^#shared$/, replacement: path.resolve(__dirname, 'src/shared/index.ts') },
            { find: /^#shared\/(.*)$/, replacement: path.resolve(__dirname, 'src/shared/$1') },

            { find: /^#observability$/, replacement: path.resolve(__dirname, 'src/observability/index.ts') },
            { find: /^#observability\/(.*)$/, replacement: path.resolve(__dirname, 'src/observability/$1') },

            { find: /^#protocol$/, replacement: path.resolve(__dirname, 'src/protocol/index.ts') },
            { find: /^#protocol\/(.*)$/, replacement: path.resolve(__dirname, 'src/protocol/$1') },

            { find: /^atoma-sync$/, replacement: path.resolve(__dirname, 'packages/atoma-sync/src/index.ts') },
            { find: /^atoma-sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma-sync/src/$1') },

            { find: /^#sync\/(.*)$/, replacement: path.resolve(__dirname, 'packages/atoma-sync/src/$1') },

            { find: /^#backend$/, replacement: path.resolve(__dirname, 'src/backend/index.ts') },
            { find: /^#backend\/(.*)$/, replacement: path.resolve(__dirname, 'src/backend/$1') },

            { find: /^#batch$/, replacement: path.resolve(__dirname, 'src/batch/index.ts') },
            { find: /^#batch\/(.*)$/, replacement: path.resolve(__dirname, 'src/batch/$1') },
        ]
    }
})
