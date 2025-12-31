import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: {
            '#core': path.resolve(__dirname, 'src/core/index.ts'),
            '#observability': path.resolve(__dirname, 'src/observability/index.ts'),
            '#protocol': path.resolve(__dirname, 'src/protocol/index.ts'),
            '#sync': path.resolve(__dirname, 'src/sync/index.ts'),
            '#backend': path.resolve(__dirname, 'src/backend/index.ts'),
            '#batch': path.resolve(__dirname, 'src/batch/index.ts')
        }
    }
})
