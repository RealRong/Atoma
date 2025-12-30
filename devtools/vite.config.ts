import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

export default defineConfig({
    plugins: [react()],
    resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
            atoma: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.mjs')
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
            external: ['react', 'react-dom', 'atoma'],
            output: {
                globals: {
                    react: 'React',
                    'react-dom': 'ReactDOM',
                    atoma: 'Atoma'
                }
            }
        }
    }
})
