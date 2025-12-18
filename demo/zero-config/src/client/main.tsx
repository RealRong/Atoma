import React from 'react'
import ReactDOM from 'react-dom/client'
import { mountAtomaDevTools } from 'atoma-devtools'
import { App } from './App'

const root = document.getElementById('root')
if (!root) {
    throw new Error('Root element not found')
}

ReactDOM.createRoot(root).render(
    <App />
)

if (import.meta.env.DEV) {
    mountAtomaDevTools()
}
