// Service worker: makes the app installable and shows internal chat notifications. Always uses the network
// so data and updates are never stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// a push from the server (someone messaged you while you were away)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'New message', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // the CRM is open and on screen on this device: it already chimes, so skip the popup here
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(d.title || 'New internal chat message', {
      body: d.body || '', tag: d.tag || 'team-chat', renotify: true, icon: '/icon-192.png', badge: '/badge-96.png', data: { url: d.url || '/#chat' },
    });
  })());
});

// tapping the notification opens the CRM on that conversation, reusing an open window if there is one
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/#chat', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) { await win.focus(); win.postMessage({ type: 'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
