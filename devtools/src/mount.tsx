import React from 'react'
import { createRoot, Root } from 'react-dom/client'
import { enableGlobalDevtools, getGlobalDevtools } from 'atoma'
import type { DevtoolsBridge } from 'atoma'
import DevtoolsApp from './ui/DevtoolsApp'
import stylesText from './styles.css?inline'

export type MountAtomaDevToolsOptions = {
    target?: HTMLElement
    bridge?: DevtoolsBridge
    defaultOpen?: boolean
}

export type MountedAtomaDevTools = {
    target: HTMLElement
    shadowRoot: ShadowRoot
    unmount: () => void
}

let mounted: MountedAtomaDevTools | null = null

function ensureContainer(target?: HTMLElement) {
    const el = target ?? document.createElement('div')
    if (!target) {
        el.setAttribute('data-atoma-devtools', '1')
        document.body.appendChild(el)
    }
    return el
}

function ensureShadowRoot(container: HTMLElement) {
    const root = container.shadowRoot ?? container.attachShadow({ mode: 'open' })

    if (!root.querySelector('style[data-atoma-devtools]')) {
        const style = document.createElement('style')
        style.setAttribute('data-atoma-devtools', '1')
        style.textContent = stylesText
        root.appendChild(style)
    }

    let mountPoint = root.querySelector('#atoma-devtools-root') as HTMLElement | null
    if (!mountPoint) {
        mountPoint = document.createElement('div')
        mountPoint.id = 'atoma-devtools-root'
        root.appendChild(mountPoint)
    }

    return { shadowRoot: root, mountPoint }
}

export function mountAtomaDevTools(options: MountAtomaDevToolsOptions = {}): MountedAtomaDevTools {
    if (mounted) return mounted

    const container = ensureContainer(options.target)
    const { shadowRoot, mountPoint } = ensureShadowRoot(container)

    const bridge = options.bridge ?? getGlobalDevtools() ?? enableGlobalDevtools()

    const root: Root = createRoot(mountPoint)
    root.render(
        <React.StrictMode>
            <DevtoolsApp bridge={bridge} defaultOpen={options.defaultOpen} />
        </React.StrictMode>
    )

    const unmount = () => {
        try {
            root.unmount()
        } finally {
            if (!options.target) {
                container.remove()
            }
            mounted = null
        }
    }

    mounted = { target: container, shadowRoot, unmount }
    return mounted
}

export function unmountAtomaDevTools() {
    mounted?.unmount()
}

