import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AtomaDevTools } from 'atoma'
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

    const [title, setTitle] = useState('')
    const [body, setBody] = useState('')

    const authorId = 1 // demo 固定作者（seed 数据已存在）

    const createPost = async (t = title, b = body) => {
        if (!t.trim()) return
        const now = Date.now()
        await PostsStore.addOne({
            title: t.trim(),
            body: b.trim() || '...',
            authorId,
            createdAt: now
        })
        if (t === title) {
            setTitle('')
            setBody('')
        }
    }

    const burstCreate = async () => {
        const tasks = Array.from({ length: 3 }).map((_, i) =>
            createPost(`Batch 新帖 ${i + 1}`, `自动批量示例 ${Date.now() % 100000}`)
        )
        await Promise.all(tasks)
    }

    const burstUpdate = async () => {
        const top3 = posts.slice(0, 3)
        await Promise.all(
            top3.map(p =>
                PostsStore.updateOne({
                    ...p,
                    title: `${p.title} ⚡`
                })
            )
        )
    }

    const burstDelete = async () => {
        const top2 = posts.slice(0, 2)
        await Promise.all(top2.map(p => PostsStore.deleteOneById(p.id, { force: true })))
    }

    const badgeText = useMemo(() => {
        const flush = '5ms flush'
        return `批量开启 /api/batch · ${flush}`
    }, [])

    const initialLoading = loading && posts.length === 0
    if (initialLoading) return <div style={styles.center}>Loading...</div>
    if (error) return <div style={styles.center}>Load failed: {error.message}</div>

    return (
        <div style={styles.page}>
            <header style={styles.header}>
                <div style={styles.badge}>{badgeText}</div>
                <div>
                    <h1 style={styles.title}>Atoma Batch + Relations</h1>
                    <p style={styles.subtitle}>SQLite + TypeORM + Express backend, HTTPAdapter batch frontend</p>
                </div>
            </header>

            <section style={styles.panel}>
                <div style={styles.panelHead}>
                    <div>
                        <div style={styles.panelTitle}>快速演示自动批量</div>
                        <div style={styles.panelHint}>同一事件循环内的写操作会自动合并到单个 /api/batch 请求，无需后端额外代码</div>
                    </div>
                    <div style={styles.panelActions}>
                        <button style={styles.ghostBtn} onClick={burstCreate}>一键新增 3 条</button>
                        <button style={styles.ghostBtn} onClick={burstUpdate} disabled={!posts.length}>批量改标题</button>
                        <button style={{ ...styles.ghostBtn, color: '#ef4444', borderColor: '#ef4444' }} onClick={burstDelete} disabled={!posts.length}>批量删除</button>
                    </div>
                </div>
                <form
                    style={styles.form}
                    onSubmit={e => {
                        e.preventDefault()
                        createPost()
                    }}
                >
                    <div style={styles.fieldRow}>
                        <input
                            style={styles.input}
                            placeholder="标题（必填）"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                        />
                        <button style={styles.primaryBtn} type="submit" disabled={!title.trim()}>新增</button>
                    </div>
                    <textarea
                        style={styles.textarea}
                        placeholder="正文（可选）"
                        value={body}
                        onChange={e => setBody(e.target.value)}
                        rows={3}
                    />
                </form>
            </section>

            <div style={styles.list}>
                {posts.map(post => (
                    <PostCard key={post.id} id={post.id} />
                ))}
            </div>
            <AtomaDevTools />
        </div>
    )
}

const PostCard = React.memo(function PostCard({ id }: { id: number }) {
    const post = PostsStore.useValue(id)
    const [editing, setEditing] = useState(false)
    const [title, setTitle] = useState(post?.title ?? '')
    const [body, setBody] = useState(post?.body ?? '')
    const [renderCount, setRenderCount] = useState(0)

    useEffect(() => {
        setRenderCount(r => r + 1)
    }, [post])

    if (!post) return null
    const save = async () => {
        await PostsStore.updateOne({ ...post, title: title.trim() || post.title, body })
        setEditing(false)
    }

    const remove = async () => {
        // force=true 语义上“硬删”，实现上走 forceRemove（同样是直接 DELETE + 本地移除）
        await PostsStore.deleteOneById(post.id, { force: true })
    }
    if (post.deleted) return null
    return (
        <article style={styles.card}>
            <div style={styles.cardHead}>
                {editing ? (
                    <>
                        <input style={styles.input} value={title} onChange={e => setTitle(e.target.value)} />
                        <textarea style={styles.textarea} value={body} onChange={e => setBody(e.target.value)} rows={2} />
                    </>
                ) : (
                    <>
                        <h2 style={styles.cardTitle}>{post.title}</h2>
                        <div style={styles.renderTag}>rerender #{renderCount}</div>
                        <div style={styles.meta}>
                            <span>Author: {post.author?.name}</span>
                            <span style={styles.dot}>•</span>
                            <span>{new Date(post.createdAt).toLocaleString()}</span>
                        </div>
                    </>
                )}
            </div>

            {!editing && <p style={styles.body}>{post.body}</p>}

            <div style={styles.actions}>
                {editing ? (
                    <>
                        <button style={styles.primaryBtn} onClick={save}>保存</button>
                        <button style={styles.ghostBtn} onClick={() => setEditing(false)}>取消</button>
                    </>
                ) : (
                    <>
                        <button style={styles.ghostBtn} onClick={() => setEditing(true)}>编辑</button>
                        <button style={{ ...styles.ghostBtn, color: '#ef4444', borderColor: '#ef4444' }} onClick={remove}>删除</button>
                    </>
                )}
            </div>

            <div style={styles.comments}>
                <div style={styles.commentsTitle}>Comments</div>
                <ul style={styles.commentList}>
                    {post.comments?.map((c: any) => (
                        <li key={c.id} style={styles.commentItem}>
                            <strong>{c.author?.name}</strong>
                            <span style={styles.commentText}>{c.body}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </article>
    )
})

const styles: Record<string, React.CSSProperties> = {
    page: {
        maxWidth: 900,
        margin: '0 auto',
        padding: '32px 20px',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        color: '#0a0a0a',
        background: '#ffffff'
    },
    panel: {
        background: '#f7f7f7',
        color: '#0a0a0a',
        padding: 16,
        borderRadius: 14,
        marginBottom: 16,
        boxShadow: '0 10px 30px rgba(0,0,0,0.08)',
        border: '1px solid #e5e5e5'
    },
    panelHead: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        alignItems: 'center',
        marginBottom: 12
    },
    panelTitle: {
        fontSize: 18,
        fontWeight: 700,
        marginBottom: 4
    },
    panelHint: {
        margin: 0,
        color: '#cbd5e1',
        fontSize: 13
    },
    panelActions: {
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap'
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        marginBottom: 24
    },
    badge: {
        background: '#0a0a0a',
        color: '#ffffff',
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
        color: '#3a3a3a'
    },
    list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 16
    },
    form: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8
    },
    fieldRow: {
        display: 'flex',
        gap: 8
    },
    input: {
        flex: 1,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid #d1d1d1',
        fontSize: 14
    },
    textarea: {
        width: '100%',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid #d1d1d1',
        fontSize: 14,
        resize: 'vertical'
    },
    primaryBtn: {
        background: '#0a0a0a',
        color: '#ffffff',
        border: '1px solid #0a0a0a',
        padding: '10px 14px',
        borderRadius: 10,
        cursor: 'pointer',
        fontWeight: 700
    },
    ghostBtn: {
        background: 'transparent',
        color: '#0a0a0a',
        border: '1px solid #0a0a0a30',
        padding: '9px 12px',
        borderRadius: 10,
        cursor: 'pointer',
        fontWeight: 600
    },
    card: {
        background: '#fff',
        borderRadius: 14,
        padding: 18,
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.06)',
        border: '1px solid #e5e5e5'
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
    actions: {
        display: 'flex',
        gap: 8,
        margin: '6px 0 10px'
    },
    meta: {
        display: 'flex',
        gap: 8,
        color: '#4a4a4a',
        fontSize: 13
    },
    dot: {
        color: '#9b9b9b'
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
        color: '#0a0a0a',
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
    renderTag: {
        display: 'inline-block',
        marginTop: 2,
        padding: '2px 6px',
        borderRadius: 8,
        background: '#eef2ff',
        color: '#4338ca',
        fontSize: 11,
        fontWeight: 700,
        alignSelf: 'flex-start'
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
