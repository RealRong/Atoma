/**
 * Example: Basic Todo App using atoma
 */

import { createSyncStore } from 'atoma'
import { IndexedDBAdapter } from 'atoma/adapters'
import Dexie from 'dexie'

// Define Todo type
interface Todo {
    id: number
    title: string
    completed: boolean
    createdAt: number
    updatedAt: number
}

// Set up IndexedDB with Dexie
const db = new Dexie('TodoApp')
db.version(1).stores({
    todos: 'id, title, completed, createdAt'
})

// Create sync store
const TodoStore = createSyncStore<Todo>({
    name: 'todos',
    adapter: new IndexedDBAdapter(db.table('todos'))
})

// Example React component
function TodoList() {
    // Subscribe to all todos - fine-grained updates
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

    const deleteTodo = async (id: number) => {
        await TodoStore.deleteOneById(id)
    }

    return (
        <div>
            <h1>Todos ({todos.length})</h1>
            <button onClick={addTodo}>Add Todo</button>
            <ul>
                {todos.map(todo => (
                    <TodoItem key={todo.id} id={todo.id} />
                ))}
            </ul>
        </div>
    )
}

// Individual todo item - subscribes only to its own data
function TodoItem({ id }: { id: number }) {
    const todo = TodoStore.useValue(id)

    if (!todo) return null

    return (
        <li>
            <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggleTodo(id)}
            />
            <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
                {todo.title}
            </span>
            <button onClick={() => deleteTodo(id)}>Delete</button>
        </li>
    )
}

async function toggleTodo(id: number) {
    const todo = TodoStore.getCachedOneById(id)
    if (todo) {
        await TodoStore.updateOne({
            id,
            completed: !todo.completed
        })
    }
}

async function deleteTodo(id: number) {
    await TodoStore.deleteOneById(id)
}

export default TodoList
