/**
 * Example: Using HTTP Adapter with Backend API
 */

import { createSyncStore } from 'atoma'
import { HTTPAdapter } from 'atoma/adapters'

// Define Todo type
interface Todo {
    id: number
    title: string
    completed: boolean
    createdAt: number
    updatedAt: number
    version?: number
}

// Create sync store with HTTP adapter
const TodoStore = createSyncStore<Todo>({
    name: 'todos',
    adapter: new HTTPAdapter<Todo>({
        baseURL: 'https://api.example.com',

        endpoints: {
            getOne: (id) => `/todos/${id}`,
            getAll: () => '/todos',
            create: () => '/todos',
            update: (id) => `/todos/${id}`,
            delete: (id) => `/todos/${id}`,
            patch: (id) => `/todos/${id}/patch`  // Optional patch endpoint
        },

        // Async headers for auth
        headers: async () => {
            const token = await getAuthToken()
            return {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        },

        // Retry configuration
        retry: {
            maxAttempts: 3,
            backoff: 'exponential',
            initialDelay: 1000
        },

        // Conflict resolution
        conflictResolution: 'last-write-wins',

        // Offline support
        offline: {
            queueWrites: true,
            maxQueueSize: 100,
            syncOnReconnect: true
        },

        // Enable patch-based updates
        supportsPatch: true
    })
})

// Mock auth function
async function getAuthToken(): Promise<string> {
    return 'your-jwt-token'
}

// Example React component
function TodoList() {
    const todos = TodoStore.useAll()

    const addTodo = async () => {
        await TodoStore.addOne({
            title: 'New todo',
            completed: false
        })
    }

    const toggleTodo = async (id: number) => {
        const todo = TodoStore.getCachedOneById(id)
        if (todo) {
            await TodoStore.updateOne({
                id,
                completed: !todo.completed
            })
        }
    }

    return (
        <div>
            <h1>Todos (HTTP Backend)</h1>
            <button onClick={addTodo}>Add Todo</button>
            <ul>
                {todos.map(todo => (
                    <TodoItem key={todo.id} id={todo.id} />
                ))}
            </ul>
            <StatusIndicator />
        </div>
    )
}

// Individual todo item
function TodoItem({ id }: { id: number }) {
    const todo = TodoStore.useValue(id)

    if (!todo) return null

    const toggleTodo = async () => {
        await TodoStore.updateOne({
            id,
            completed: !todo.completed
        })
    }

    const deleteTodo = async () => {
        await TodoStore.deleteOneById(id)
    }

    return (
        <li>
            <input
                type="checkbox"
                checked={todo.completed}
                onChange={toggleTodo}
            />
            <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
                {todo.title}
            </span>
            {todo.version && <small> (v{todo.version})</small>}
            <button onClick={deleteTodo}>Delete</button>
        </li>
    )
}

// Network status indicator
function StatusIndicator() {
    const [isOnline, setIsOnline] = React.useState(navigator.onLine)

    React.useEffect(() => {
        const handleOnline = () => setIsOnline(true)
        const handleOffline = () => setIsOnline(false)

        window.addEventListener('online', handleOnline)
        window.addEventListener('offline', handleOffline)

        return () => {
            window.removeEventListener('online', handleOnline)
            window.removeEventListener('offline', handleOffline)
        }
    }, [])

    return (
        <div style={{
            padding: '8px',
            background: isOnline ? '#90EE90' : '#FFB6C1',
            marginTop: '16px'
        }}>
            Status: {isOnline ? '🟢 Online' : '🔴 Offline (queue active)'}
        </div>
    )
}

export default TodoList

/**
 * Server-side example (Express.js)
 * 
 * app.get('/todos/:id', async (req, res) => {
 *   const todo = await db.todos.findById(req.params.id)
 *   res.json(todo)
 * })
 * 
 * app.put('/todos/:id', async (req, res) => {
 *   const { id } = req.params
 *   const clientData = req.body
 *   const serverData = await db.todos.findById(id)
 *   
 *   // Conflict detection
 *   if (serverData.updatedAt > clientData.updatedAt) {
 *     return res.status(409).json({
 *       error: 'VERSION_MISMATCH',
 *       currentValue: serverData
 *     })
 *   }
 *   
 *   const updated = await db.todos.update(id, {
 *     ...clientData,
 *     version: serverData.version + 1
 *   })
 *   
 *   res.json(updated)
 * })
 * 
 * app.patch('/todos/:id/patch', async (req, res) => {
 *   const { patches, baseVersion } = req.body
 *   const current = await db.todos.findById(req.params.id)
 *   
 *   if (current.version !== baseVersion) {
 *     return res.status(409).json({
 *       error: 'VERSION_MISMATCH',
 *       currentVersion: current.version,
 *       currentValue: current
 *     })
 *   }
 *   
 *   // Apply patches using immer
 *   const updated = applyPatches(current, patches)
 *   updated.version = current.version + 1
 *   
 *   await db.todos.update(req.params.id, updated)
 *   res.json(updated)
 * })
 */
