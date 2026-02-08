import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        dedupe: ['react', 'react-dom']
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
            external: ['react', 'react-dom', 'atoma', 'atoma-client'],
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
