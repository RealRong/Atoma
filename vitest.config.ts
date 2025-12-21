import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
    resolve: {
        alias: {
            '#observability': path.resolve(__dirname, 'src/observability/index.ts'),
            '#protocol': path.resolve(__dirname, 'src/protocol/index.ts'),
            '#batch': path.resolve(__dirname, 'src/batch/index.ts')
        }
    }
})
