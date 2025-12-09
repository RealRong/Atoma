import React from 'react'
import { PostsStore } from './stores'

export function App() {
    const { data: posts, loading, error } = PostsStore.useFindMany({
        orderBy: { field: 'createdAt', direction: 'desc' },
        include: {
            author: true,
            comments: {
                orderBy: { field: 'id', direction: 'asc' },
                include: { author: true }
            }
        } as const
    })

    if (loading) return <div style={styles.center}>Loading...</div>
    if (error) return <div style={styles.center}>Load failed: {error.message}</div>

    return (
        <div style={styles.page}>
            <header style={styles.header}>
                <div style={styles.badge}>Zero-config</div>
                <div>
                    <h1 style={styles.title}>Atoma Batch + Relations</h1>
                    <p style={styles.subtitle}>SQLite + TypeORM + Express backend, HTTPAdapter batch frontend</p>
                </div>
            </header>

            <div style={styles.list}>
                {posts.map(post => (
                    <article key={post.id} style={styles.card}>
                        <div style={styles.cardHead}>
                            <h2 style={styles.cardTitle}>{post.title}</h2>
                            <div style={styles.meta}>
                                <span>Author: {post.author?.name}</span>
                                <span style={styles.dot}>•</span>
                                <span>{new Date(post.createdAt).toLocaleString()}</span>
                            </div>
                        </div>
                        <p style={styles.body}>{post.body}</p>
                        <div style={styles.comments}>
                            <div style={styles.commentsTitle}>Comments</div>
                            <ul style={styles.commentList}>
                                {post.comments?.map(c => (
                                    <li key={c.id} style={styles.commentItem}>
                                        <strong>{c.author?.name}</strong>
                                        <span style={styles.commentText}>{c.body}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </article>
                ))}
            </div>
        </div>
    )
}

const styles: Record<string, React.CSSProperties> = {
    page: {
        maxWidth: 900,
        margin: '0 auto',
        padding: '32px 20px',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        color: '#0f172a'
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        marginBottom: 24
    },
    badge: {
        background: 'linear-gradient(135deg, #60a5fa, #a78bfa)',
        color: '#fff',
        padding: '10px 14px',
        borderRadius: 12,
        fontWeight: 700,
        letterSpacing: 0.3
    },
    title: {
        margin: 0,
        fontSize: 28,
        letterSpacing: -0.5
    },
    subtitle: {
        margin: '4px 0 0',
        color: '#475569'
    },
    list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16
    },
    card: {
        background: '#fff',
        borderRadius: 14,
        padding: 18,
        boxShadow: '0 10px 40px rgba(15, 23, 42, 0.06)',
        border: '1px solid #e2e8f0'
    },
    cardHead: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginBottom: 10
    },
    cardTitle: {
        margin: 0,
        fontSize: 20
    },
    meta: {
        display: 'flex',
        gap: 8,
        color: '#475569',
        fontSize: 13
    },
    dot: {
        color: '#cbd5e1'
    },
    body: {
        margin: '6px 0 12px',
        lineHeight: 1.6
    },
    comments: {
        borderTop: '1px dashed #e2e8f0',
        paddingTop: 10
    },
    commentsTitle: {
        fontWeight: 700,
        color: '#0ea5e9',
        marginBottom: 8
    },
    commentList: {
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8
    },
    commentItem: {
        display: 'flex',
        gap: 8,
        alignItems: 'center'
    },
    commentText: {
        color: '#334155'
    },
    center: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif'
    }
}

export default App
