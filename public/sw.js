// Service Worker for Android & iOS Push Notifications
self.addEventListener('install', (event) => {
    // Force activation immediately
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Claim all clients immediately
    event.waitUntil(self.clients.claim());
});

// Handle incoming Push Notification
self.addEventListener('push', (event) => {
    let payload = {
        title: 'New Notification',
        body: 'You have received a new update.',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: '/' }
    };

    if (event.data) {
        try {
            payload = Object.assign(payload, event.data.json());
        } catch (e) {
            payload.body = event.data.text();
        }
    }

    const options = {
        body: payload.body,
        icon: payload.icon || '/icon-192.png',
        badge: payload.badge || '/icon-192.png',
        image: payload.image || undefined,
        vibrate: [200, 100, 200],
        tag: 'push-notification-' + Date.now(),
        renotify: true,
        data: payload.data || { url: '/' },
        actions: [
            { action: 'open', title: 'Open' },
            { action: 'close', title: 'Dismiss' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(payload.title, options)
    );
});

// Handle Notification Click
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'close') {
        return;
    }

    let targetUrl = (event.notification.data && event.notification.data.url) || '/';
    if (targetUrl.startsWith('/')) {
        targetUrl = self.location.origin + targetUrl;
    }

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // Check if there is already a window open with this URL
            for (let client of windowClients) {
                if (client.url === targetUrl && 'focus' in client) {
                    return client.focus();
                }
            }
            // If not, open a new window
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
