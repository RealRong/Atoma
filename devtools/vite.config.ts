import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

export default defineConfig({
    plugins: [react()],
    resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
            atoma: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
            'atoma/client': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/client/index.ts'),
            'atoma/devtools': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/devtools/index.ts'),
            '#core': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/core/index.ts'),
            '#observability': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/observability/index.ts'),
            '#protocol': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/protocol/index.ts'),
            'atoma-sync': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/atoma-sync/src/index.ts'),
            '#backend': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/backend/index.ts'),
            '#batch': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/batch/index.ts')
        }
    },
    build: {
        lib: {
            entry: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src/index.ts'),
            name: 'AtomaDevtools',
            formats: ['es'],
            fileName: () => 'index.js'
        },
        sourcemap: true,
        rollupOptions: {
            external: ['react', 'react-dom', 'atoma', 'atoma/devtools'],
            output: {
                globals: {
                    react: 'React',
                    'react-dom': 'ReactDOM',
                    atoma: 'Atoma',
                    'atoma/devtools': 'AtomaDevtools'
                }
            }
        }
    }
})
