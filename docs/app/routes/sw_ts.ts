const JS = `\
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      await self.registration.unregister()
    } catch {}
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of clients) {
        try { c.navigate(c.url) } catch {}
      }
    } catch {}
  })())
})

self.addEventListener('fetch', () => {})
`

export async function loader() {
  return new Response(JS, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

