import { defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:3000'
        }
    },
    resolve: {
        alias: {
            atoma: path.resolve(__dirname, '../..', 'src'),
            'atoma/react': path.resolve(__dirname, '../..', 'src/react'),
            'atoma-devtools': path.resolve(__dirname, '../..', 'devtools', 'dist', 'index.js'),
            'atoma/server': path.resolve(__dirname, '../..', 'src/server'),
            'atoma/adapters': path.resolve(__dirname, '../..', 'src/adapters'),
            '#observability': path.resolve(__dirname, '../..', 'src/observability/index.ts'),
            '#protocol': path.resolve(__dirname, '../..', 'src/protocol/index.ts'),
            '#batch': path.resolve(__dirname, '../..', 'src/batch/index.ts')
        }
    }
})
