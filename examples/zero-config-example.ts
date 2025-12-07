/**
 * Zero-Config Example: Demonstrating the new resourceName and custom parameter features
 */

import { setDefaultAdapterFactory, HTTPAdapter, Store } from '../src'

// Step 1: Define your types
interface Todo {
    id: number
    title: string
    completed: boolean
    createdAt: number
}

interface User {
    id: number
    name: string
    email: string
}

// Step 2: Module augmentation for type safety
declare module '../src' {
    interface StoreRegistry {
        todos: Todo
        users: User
    }
}

// Step 3: Zero-config setup with resourceName
// This is all you need! No more manual endpoint configuration
setDefaultAdapterFactory((name) => new HTTPAdapter({
    baseURL: 'https://api.example.com',
    resourceName: `/api/v1/${name}`,  // Auto-generates RESTful endpoints
    headers: async () => ({
        Authorization: `Bearer ${await getToken()}`
    })
}), {
    // Optional: Override specific resources
    custom: {
        todos: {
            // Override path prefix for todos
            resourceName: '/api/v1/todo-items'
        },
        users: {
            // Use different API for users
            baseURL: 'https://user-service.example.com',
            resourceName: '/v2/users'
        }
    }
})

// Mocked token function
async function getToken(): Promise<string> {
    return 'mock-jwt-token'
}

// Step 4: Use stores - completely zero-config!
export async function demonstrateZeroConfig() {
    // Auto-generated endpoints:
    // - todos: https://api.example.com/api/v1/todo-items/{id}
    // - users: https://user-service.example.com/v2/users/{id}

    const todoStore = Store('todos')
    const userStore = Store('users')

    // Use the stores normally
    console.log('Zero-config stores created successfully!')
    console.log('Todo endpoints auto-generated from resourceName')
    console.log('User endpoints using custom baseURL and resourceName')

    return { todoStore, userStore }
}

/**
 * Example: Using the default resourceName pattern
 */
export function simpleZeroConfig() {
    setDefaultAdapterFactory((name) => new HTTPAdapter({
        baseURL: 'https://api.example.com',
        resourceName: name,  // Simple: /todos, /users
        headers: () => ({ 'Content-Type': 'application/json' })
    }))

    // Creates endpoints:
    // todos: /todos/{id}, /todos (getAll, create etc)
    // users: /users/{id}, /users (getAll, create etc)
}

/**
 * Example: Mix of auto and manual configuration
 */
export function mixedConfig() {
    setDefaultAdapterFactory((name) => new HTTPAdapter({
        baseURL: 'https://api.example.com',
        resourceName: `/api/v1/${name}`
    }), {
        custom: {
            // Override specific endpoints for legacy API
            todos: {
                endpoints: {
                    getAll: () => '/legacy/getTodos',
                    create: () => '/legacy/createTodo'
                    // Other endpoints still use auto-generated /{name}/{id}
                }
            }
        }
    })
}

export default demonstrateZeroConfig
