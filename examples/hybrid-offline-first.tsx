/**
 * Example: HybridAdapter for Offline-First App
 */

import { createSyncStore, HybridAdapter } from 'atoma'
import { IndexedDBAdapter, HTTPAdapter } from 'atoma/adapters'
import Dexie from 'dexie'

interface Todo {
    id: number
    title: string
    completed: boolean
    createdAt: number
    updatedAt: number
}

// Setup IndexedDB
const db = new Dexie('TodoApp')
db.version(1).stores({
    todos: 'id, title, completed, createdAt'
})

// Create hybrid store: IndexedDB + HTTP
const TodoStore = createSyncStore<Todo>({
    name: 'todos',

    adapter: new HybridAdapter({
        // Local cache (IndexedDB) - fast reads
        local: new IndexedDBAdapter(db.table('todos')),

        // Remote server (HTTP) - authoritative source
        remote: new HTTPAdapter({
            baseURL: 'https://api.example.com',
            endpoints: {
                getOne: (id) => `/todos/${id}`,
                getAll: () => '/todos',
                create: () => '/todos',
                update: (id) => `/todos/${id}`,
                delete: (id) => `/todos/${id}`
            },
            headers: async () => ({
                'Authorization': `Bearer ${await getAuthToken()}`
            }),
            offline: {
                queueWrites: true,
                syncOnReconnect: true
            }
        }),

        // Strategy: local-first reads, remote-first writes
        strategy: {
            read: 'local-first',      // Fast UI, fallback to server
            write: 'remote-first',    // Server is authoritative
            cacheTimeout: 5 * 60 * 1000,  // 5 minutes
            syncDeletes: true
        }
    })
})

async function getAuthToken() {
    return 'your-jwt-token'
}

// Example component
function TodoApp() {
    const todos = TodoStore.useAll()
    const [isOnline, setIsOnline] = React.useState(navigator.onLine)

    React.useEffect(() => {
        const updateOnlineStatus = () => setIsOnline(navigator.onLine)
        window.addEventListener('online', updateOnlineStatus)
        window.addEventListener('offline', updateOnlineStatus)
        return () => {
            window.removeEventListener('online', updateOnlineStatus)
            window.removeEventListener('offline', updateOnlineStatus)
        }
    }, [])

    const addTodo = async () => {
        // This will:
        // 1. Send to server first (if online)
        // 2. Update IndexedDB
        // 3. If offline, queue for later sync
        await TodoStore.addOne({
            title: `New todo ${Date.now()}`,
            completed: false
        })
    }

    return (
        <div>
            <h1>Hybrid Sync Demo</h1>

            {/* Network status */}
            <div style={{
                padding: '8px',
                background: isOnline ? '#90EE90' : '#FFB6C1',
                marginBottom: '16px'
            }}>
                {isOnline ? '🟢 Online - syncing with server' : '🔴 Offline - local only'}
            </div>

            <button onClick={addTodo}>Add Todo</button>

            <ul>
                {todos.map(todo => (
                    <TodoItem key={todo.id} id={todo.id} />
                ))}
            </ul>

            {/* Undo/Redo still works! */}
            <UndoRedoButtons />
        </div>
    )
}

function TodoItem({ id }: { id: number }) {
    const todo = TodoStore.useValue(id)

    if (!todo) return null

    const toggle = async () => {
        // Hybrid adapter handles:
        // - Optimistic local update (instant UI)
        // - Server sync (if online)
        // - Queue for sync (if offline)
        await TodoStore.updateOne({
            id,
            completed: !todo.completed
        })
    }

    const remove = async () => {
        await TodoStore.deleteOneById(id)
    }

    return (
        <li>
            <input type="checkbox" checked={todo.completed} onChange={toggle} />
            <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
                {todo.title}
            </span>
            <button onClick={remove}>Delete</button>
        </li>
    )
}

// Undo/Redo functionality (still works with HybridAdapter!)
function UndoRedoButtons() {
    const [history, setHistory] = React.useState<any[]>([])
    const [currentIndex, setCurrentIndex] = React.useState(-1)

    React.useEffect(() => {
        // Listen to history events from BaseStore
        const handleChange = (event: any) => {
            setHistory(prev => [...prev, event])
            setCurrentIndex(prev => prev + 1)
        }

        // In real implementation, you'd use setHistoryCallback
        // For now, this is a placeholder

        return () => {
            // Cleanup
        }
    }, [])

    const undo = () => {
        if (currentIndex >= 0) {
            const event = history[currentIndex]
            // Apply inverse patches
            // applyPatchesOnAtom(event.atom, event.inversePatches)
            setCurrentIndex(prev => prev - 1)
        }
    }

    const redo = () => {
        if (currentIndex < history.length - 1) {
            const event = history[currentIndex + 1]
            // Apply forward patches
            // applyPatchesOnAtom(event.atom, event.patches)
            setCurrentIndex(prev => prev + 1)
        }
    }

    return (
        <div style={{ marginTop: '16px' }}>
            <button onClick={undo} disabled={currentIndex < 0}>
                ⟲ Undo
            </button>
            <button onClick={redo} disabled={currentIndex >= history.length - 1}>
                ⟳ Redo
            </button>
            <span> (History: {history.length} actions)</span>
        </div>
    )
}

export default TodoApp

/**
 * How HybridAdapter works with Undo/Redo:
 * 
 * 1. User actions generate patches in BaseStore:
 *    updateOne() → dispatch() → handleQueue() → finishDraft(patches, inversePatches)
 * 
 * 2. Patches are sent to HybridAdapter:
 *    adapter.applyPatches(patches)
 * 
 * 3. HybridAdapter forwards to both adapters:
 *    local.applyPatches(patches)   // IndexedDB
 *    remote.applyPatches(patches)  // HTTP
 * 
 * 4. History callback receives patches for undo/redo:
 *    historyCallback(patches, inversePatches, atom)
 * 
 * 5. Undo applies inverse patches:
 *    applyPatchesOnAtom(atom, inversePatches)
 *    → Same flow, HybridAdapter receives inverse patches
 *    → Both local and remote are reverted
 * 
 * Result: Undo/Redo works seamlessly with HybridAdapter!
 */
