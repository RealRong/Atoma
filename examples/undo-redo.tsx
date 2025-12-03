/**
 * Example: Undo/Redo with HistoryManager
 */

import React from 'react'
import { createStore, HistoryManager, setHistoryCallback } from 'atoma'
import { IndexedDB } from 'atoma/adapters'
import Dexie from 'dexie'

interface Todo {
    id: number
    title: string
    completed: boolean
    createdAt: number
    updatedAt: number
}

// Setup database
const db = new Dexie('TodoApp')
db.version(1).stores({ todos: 'id, title, completed, createdAt' })

// Create store
const TodoStore = createStore<Todo>({
    adapter: new IndexedDB(db.table('todos'))
})

// Create history manager
const history = new HistoryManager({
    maxStackSize: 50,
    debug: true  // Enable logging
})

// Connect history manager to store
setHistoryCallback((patches, inversePatches, atom, adapterName) => {
    history.record(patches, inversePatches, atom, adapterName)
})

// Example component
function TodoApp() {
    const todos = TodoStore.useAll()
    const [historyState, setHistoryState] = React.useState(history.getState())

    // Update history state when operations happen
    React.useEffect(() => {
        const interval = setInterval(() => {
            setHistoryState(history.getState())
        }, 100)
        return () => clearInterval(interval)
    }, [])

    const addTodo = async () => {
        await TodoStore.addOne({
            title: `Todo ${Date.now()}`,
            completed: false
        })
    }

    const clearCompleted = async () => {
        const completed = todos.filter(t => t.completed)
        for (const todo of completed) {
            await TodoStore.deleteOneById(todo.id)
        }
    }

    const undo = () => {
        history.undo()
    }

    const redo = () => {
        history.redo()
    }

    const clearHistory = () => {
        history.clear()
        setHistoryState(history.getState())
    }

    return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
            <h1>Undo/Redo Demo</h1>

            {/* History controls */}
            <div style={{
                padding: '16px',
                background: '#f5f5f5',
                borderRadius: '8px',
                marginBottom: '16px'
            }}>
                <h3>History Controls</h3>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                    <button
                        onClick={undo}
                        disabled={!historyState.canUndo}
                        style={{
                            padding: '8px 16px',
                            cursor: historyState.canUndo ? 'pointer' : 'not-allowed',
                            opacity: historyState.canUndo ? 1 : 0.5
                        }}
                    >
                        ⟲ Undo
                    </button>

                    <button
                        onClick={redo}
                        disabled={!historyState.canRedo}
                        style={{
                            padding: '8px 16px',
                            cursor: historyState.canRedo ? 'pointer' : 'not-allowed',
                            opacity: historyState.canRedo ? 1 : 0.5
                        }}
                    >
                        ⟳ Redo
                    </button>

                    <button onClick={clearHistory} style={{ padding: '8px 16px' }}>
                        🗑️ Clear History
                    </button>
                </div>

                <div style={{ fontSize: '14px', color: '#666' }}>
                    Undo stack: {historyState.undoCount} | Redo stack: {historyState.redoCount}
                </div>
            </div>

            {/* Todo operations */}
            <div style={{ marginBottom: '16px' }}>
                <button onClick={addTodo} style={{ padding: '8px 16px', marginRight: '8px' }}>
                    ➕ Add Todo
                </button>
                <button onClick={clearCompleted} style={{ padding: '8px 16px' }}>
                    🗑️ Clear Completed
                </button>
            </div>

            {/* Todo list */}
            <div>
                <h3>Todos ({todos.length})</h3>
                {todos.length === 0 ? (
                    <p style={{ color: '#999' }}>No todos yet. Add one to get started!</p>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                        {todos.map(todo => (
                            <TodoItem key={todo.id} id={todo.id} />
                        ))}
                    </ul>
                )}
            </div>

            {/* Instructions */}
            <div style={{
                marginTop: '32px',
                padding: '16px',
                background: '#e3f2fd',
                borderRadius: '8px'
            }}>
                <h4>Try this:</h4>
                <ol style={{ margin: '8px 0', paddingLeft: '20px' }}>
                    <li>Add a few todos</li>
                    <li>Toggle some as completed</li>
                    <li>Delete some todos</li>
                    <li>Click Undo to revert changes</li>
                    <li>Click Redo to reapply them</li>
                </ol>
                <p style={{ fontSize: '14px', color: '#666', margin: '8px 0 0 0' }}>
                    💡 Every operation is recorded and can be undone/redone!
                </p>
            </div>
        </div>
    )
}

function TodoItem({ id }: { id: number }) {
    const todo = TodoStore.useValue(id)

    if (!todo) return null

    const toggle = async () => {
        await TodoStore.updateOne({
            id,
            completed: !todo.completed
        })
    }

    const remove = async () => {
        await TodoStore.deleteOneById(id)
    }

    const updateTitle = async () => {
        const newTitle = prompt('New title:', todo.title)
        if (newTitle && newTitle !== todo.title) {
            await TodoStore.updateOne({
                id,
                title: newTitle
            })
        }
    }

    return (
        <li style={{
            padding: '12px',
            marginBottom: '8px',
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
        }}>
            <input
                type="checkbox"
                checked={todo.completed}
                onChange={toggle}
                style={{ cursor: 'pointer' }}
            />

            <span
                onClick={updateTitle}
                style={{
                    flex: 1,
                    textDecoration: todo.completed ? 'line-through' : 'none',
                    color: todo.completed ? '#999' : '#000',
                    cursor: 'pointer'
                }}
            >
                {todo.title}
            </span>

            <button
                onClick={remove}
                style={{
                    padding: '4px 8px',
                    background: '#f44336',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                }}
            >
                Delete
            </button>
        </li>
    )
}

export default TodoApp

/**
 * How it works:
 * 
 * 1. Every operation (add/update/delete) generates patches in BaseStore
 * 2. setHistoryCallback receives patches + inversePatches
 * 3. HistoryManager.record() saves them to undo stack
 * 4. Undo: applies inversePatches (reverts the change)
 * 5. Redo: applies original patches (reapplies the change)
 * 
 * Key features:
 * - Max stack size (prevents memory bloat)
 * - Redo stack clears on new changes
 * - Works with all adapters (IndexedDB, HTTP, Hybrid)
 * - Fine-grained: only affects changed atoms
 */
