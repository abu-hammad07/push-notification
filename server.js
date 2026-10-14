const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VAPID_FILE = path.join(__dirname, 'vapid-keys.json');
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');
const AUTO_CONFIG_FILE = path.join(__dirname, 'auto-config.json');

// --- Helper: Ensure VAPID Keys exist ---
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
    try {
        vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } catch (e) {
        console.error('Error reading vapid-keys.json, regenerating...');
    }
}

if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
    console.log('Generating new VAPID keys for Web Push...');
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
    console.log('VAPID keys saved to vapid-keys.json');
}

webpush.setVapidDetails(
    'mailto:admin@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

// --- Helper: Read/Write Subscriptions JSON ---
function getSubscriptions() {
    if (!fs.existsSync(SUBSCRIPTIONS_FILE)) {
        fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify([]));
        return [];
    }
    try {
        const data = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
        return JSON.parse(data) || [];
    } catch (err) {
        console.error('Error reading subscriptions.json:', err);
        return [];
    }
}

function saveSubscriptions(subs) {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2), 'utf8');
}

// --- Helper: Read/Write Auto Push Config ---
function getAutoConfig() {
    const defaults = {
        welcome: {
            enabled: true,
            title: "🎉 Welcome to PushAlert!",
            body: "Your device is now connected. You will automatically receive real-time alerts!",
            url: "/",
            delaySeconds: 2
        },
        recurring: {
            enabled: false,
            intervalMinutes: 60,
            title: "⚡ Automated Periodic Alert",
            body: "This is an automatic notification sent to keep you updated.",
            url: "/"
        }
    };

    if (!fs.existsSync(AUTO_CONFIG_FILE)) {
        fs.writeFileSync(AUTO_CONFIG_FILE, JSON.stringify(defaults, null, 2));
        return defaults;
    }

    try {
        return JSON.parse(fs.readFileSync(AUTO_CONFIG_FILE, 'utf8'));
    } catch (e) {
        return defaults;
    }
}

function saveAutoConfig(config) {
    fs.writeFileSync(AUTO_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    restartRecurringTimer();
}

// --- Recurring Auto Push Timer ---
let recurringTimer = null;

function restartRecurringTimer() {
    if (recurringTimer) {
        clearInterval(recurringTimer);
        recurringTimer = null;
    }

    const config = getAutoConfig();
    if (config.recurring && config.recurring.enabled) {
        const intervalMs = Math.max(1, config.recurring.intervalMinutes || 60) * 60 * 1000;
        console.log(`[AUTO PUSH] Recurring timer active: Sending every ${config.recurring.intervalMinutes} minute(s)`);
        
        recurringTimer = setInterval(async () => {
            console.log(`[AUTO PUSH] Triggering recurring push notification...`);
            await sendPushBroadcast({
                title: config.recurring.title,
                body: config.recurring.body,
                url: config.recurring.url || '/',
                target: 'all'
            });
        }, intervalMs);
    }
}

// Helper to send push to recipients
async function sendPushBroadcast({ title, body, icon = '/icon-192.png', url = '/', target = 'all', subscriberId = null }) {
    const allSubscriptions = getSubscriptions();
    if (allSubscriptions.length === 0) {
        return { total: 0, sent: 0, failed: 0, cleaned: 0 };
    }

    let recipients = allSubscriptions;
    if (subscriberId) {
        recipients = allSubscriptions.filter(s => s.id === subscriberId);
    } else if (target === 'android') {
        recipients = allSubscriptions.filter(s => s.platform === 'android');
    } else if (target === 'ios') {
        recipients = allSubscriptions.filter(s => s.platform === 'ios');
    } else if (target === 'desktop') {
        recipients = allSubscriptions.filter(s => s.platform === 'desktop');
    }

    const payload = JSON.stringify({
        title,
        body,
        icon,
        data: { url: url || '/', dateOfArrival: Date.now() }
    });

    const results = { total: recipients.length, sent: 0, failed: 0, cleaned: 0 };
    const expiredEndpoints = [];

    await Promise.all(recipients.map(async (sub) => {
        try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
                TTL: 24 * 60 * 60
            });
            results.sent++;
        } catch (error) {
            results.failed++;
            if (error.statusCode === 410 || error.statusCode === 404) {
                expiredEndpoints.push(sub.endpoint);
                results.cleaned++;
            }
        }
    }));

    if (expiredEndpoints.length > 0) {
        const updated = allSubscriptions.filter(s => !expiredEndpoints.includes(s.endpoint));
        saveSubscriptions(updated);
    }

    return results;
}

// --- Helper: Get Local Network IP ---
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// --- API Endpoints ---

// 1. Get Public VAPID Key for client subscription
app.get('/api/config', (req, res) => {
    res.json({
        publicKey: vapidKeys.publicKey
    });
});

// 2. Subscribe a new device (Android / iOS / Desktop) with Auto Welcome Push
app.post('/api/subscribe', (req, res) => {
    const { subscription, deviceName, platform, userAgent } = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Invalid subscription object' });
    }

    const subscriptions = getSubscriptions();
    const existingIndex = subscriptions.findIndex(sub => sub.endpoint === subscription.endpoint);

    const subscriptionEntry = {
        id: existingIndex !== -1 ? subscriptions[existingIndex].id : 'sub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        name: deviceName || (platform === 'ios' ? 'Apple iPhone' : platform === 'android' ? 'Android Device' : 'Desktop Browser'),
        platform: platform || 'unknown',
        userAgent: userAgent || req.headers['user-agent'] || '',
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        subscribedAt: existingIndex !== -1 ? subscriptions[existingIndex].subscribedAt : new Date().toISOString(),
        lastActive: new Date().toISOString()
    };

    if (existingIndex !== -1) {
        subscriptions[existingIndex] = subscriptionEntry;
        console.log(`[UPDATE] Subscription updated: ${subscriptionEntry.name} (${subscriptionEntry.platform})`);
    } else {
        subscriptions.push(subscriptionEntry);
        console.log(`[NEW] Device subscribed: ${subscriptionEntry.name} (${subscriptionEntry.platform})`);
    }

    saveSubscriptions(subscriptions);

    // --- AUTO PUSH: Send Automatic Welcome Notification ---
    const autoConfig = getAutoConfig();
    if (autoConfig.welcome && autoConfig.welcome.enabled) {
        const delayMs = (autoConfig.welcome.delaySeconds || 2) * 1000;
        console.log(`[AUTO PUSH] Scheduling automatic welcome push in ${delayMs}ms for ${subscriptionEntry.name}`);

        setTimeout(async () => {
            try {
                const payload = JSON.stringify({
                    title: autoConfig.welcome.title || '🎉 Welcome to PushAlert!',
                    body: autoConfig.welcome.body || 'You have successfully subscribed to push notifications.',
                    icon: '/icon-192.png',
                    data: { url: autoConfig.welcome.url || '/' }
                });

                await webpush.sendNotification({
                    endpoint: subscriptionEntry.endpoint,
                    keys: subscriptionEntry.keys
                }, payload);

                console.log(`[AUTO PUSH SUCCESS] Auto welcome notification sent to ${subscriptionEntry.name}`);
            } catch (err) {
                console.error(`[AUTO PUSH ERROR] Failed auto welcome notification:`, err.message);
            }
        }, delayMs);
    }

    res.status(201).json({
        success: true,
        message: 'Device subscribed successfully! Automatic welcome push scheduled.',
        subscriber: subscriptionEntry,
        autoWelcomeScheduled: autoConfig.welcome && autoConfig.welcome.enabled
    });
});

// 3. Unsubscribe / Delete a device
app.post('/api/unsubscribe', (req, res) => {
    const { endpoint, id } = req.body;
    let subscriptions = getSubscriptions();
    const initialCount = subscriptions.length;

    subscriptions = subscriptions.filter(sub => {
        if (id && sub.id === id) return false;
        if (endpoint && sub.endpoint === endpoint) return false;
        return true;
    });

    saveSubscriptions(subscriptions);
    res.json({
        success: true,
        removed: initialCount - subscriptions.length
    });
});

// 4. List all subscribers (for send panel)
app.get('/api/subscriptions', (req, res) => {
    const subscriptions = getSubscriptions();
    const sanitized = subscriptions.map(sub => ({
        id: sub.id,
        name: sub.name,
        platform: sub.platform,
        endpointPreview: sub.endpoint.substring(0, 45) + '...',
        subscribedAt: sub.subscribedAt,
        lastActive: sub.lastActive
    }));
    res.json({
        total: subscriptions.length,
        subscribers: sanitized
    });
});

// 5. Send Manual Push Notification
app.post('/api/send-notification', async (req, res) => {
    const {
        title = 'New Notification',
        body = 'Hello from Push Notification System!',
        icon = '/icon-192.png',
        url = '/',
        target = 'all',
        subscriberId = null
    } = req.body;

    const allSubscriptions = getSubscriptions();
    if (allSubscriptions.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'No subscribers found in subscriptions.json! Please subscribe a device first.'
        });
    }

    const results = await sendPushBroadcast({
        title,
        body,
        icon,
        url,
        target,
        subscriberId
    });

    res.json({
        success: true,
        message: `Notification sent to ${results.sent} of ${results.total} device(s).`,
        results
    });
});

// 6. Schedule Auto Notification (Timer test / Background test)
app.post('/api/schedule-auto', (req, res) => {
    const {
        seconds = 5,
        title = '⏱️ Auto Scheduled Notification',
        body = 'This notification arrived automatically after a timer countdown!',
        url = '/',
        subscriberId = null
    } = req.body;

    const delayMs = Math.max(1, parseInt(seconds)) * 1000;
    console.log(`[SCHEDULED AUTO] Notification scheduled in ${delayMs / 1000} seconds...`);

    setTimeout(async () => {
        console.log(`[SCHEDULED AUTO] Triggering scheduled notification now!`);
        await sendPushBroadcast({
            title,
            body,
            url,
            subscriberId
        });
    }, delayMs);

    res.json({
        success: true,
        message: `Auto notification scheduled! It will arrive in ${seconds} seconds. You can close or minimize the browser now.`
    });
});

// 7. Get Auto Notification Config
app.get('/api/auto-config', (req, res) => {
    res.json(getAutoConfig());
});

// 8. Update Auto Notification Config
app.post('/api/auto-config', (req, res) => {
    const current = getAutoConfig();
    const updated = {
        welcome: {
            ...current.welcome,
            ...(req.body.welcome || {})
        },
        recurring: {
            ...current.recurring,
            ...(req.body.recurring || {})
        }
    };

    saveAutoConfig(updated);
    res.json({
        success: true,
        message: 'Auto push settings saved successfully!',
        config: updated
    });
});

// Shortcut routes
app.get('/send', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'send.html'));
});

// Initialize recurring timer on server boot
restartRecurringTimer();

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log(`\n======================================================`);
    console.log(`🚀 Push Notification Server is running on Port ${PORT}!`);
    console.log(`🤖 Auto Push Notifications: ACTIVE`);
    console.log(`------------------------------------------------------`);
    console.log(`📱 1. Client/Subscribe Page (Android & iOS):`);
    console.log(`   - Localhost:    http://localhost:${PORT}`);
    console.log(`   - Mobile Wi-Fi: http://${localIp}:${PORT}`);
    console.log(``);
    console.log(`📤 2. Send Notification Dashboard:`);
    console.log(`   - Localhost:    http://localhost:${PORT}/send.html`);
    console.log(`   - Mobile Wi-Fi: http://${localIp}:${PORT}/send.html`);
    console.log(``);
    console.log(`💾 Data stored in: subscriptions.json`);
    console.log(`⚙️ Auto config in: auto-config.json`);
    console.log(`🔑 VAPID Keys in:  vapid-keys.json`);
    console.log(`======================================================\n`);
});
