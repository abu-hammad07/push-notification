require('dotenv').config();
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
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Files ---
const VAPID_FILE = path.join(__dirname, 'vapid-keys.json');
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');
const AUTO_CONFIG_FILE = path.join(__dirname, 'auto-config.json');
const ERROR_LOGS_FILE = path.join(__dirname, 'error-logs.json');
const WA_MESSAGES_FILE = path.join(__dirname, 'whatsapp-messages.json');

// --- Helper: Read/Write Error Logs JSON ---
function getErrorLogs() {
    if (!fs.existsSync(ERROR_LOGS_FILE)) {
        fs.writeFileSync(ERROR_LOGS_FILE, JSON.stringify([]));
        return [];
    }
    try {
        const data = fs.readFileSync(ERROR_LOGS_FILE, 'utf8');
        return JSON.parse(data) || [];
    } catch (e) {
        return [];
    }
}

function logError({ type = 'GENERAL_ERROR', message, details = null, req = null }) {
    const logs = getErrorLogs();
    const newEntry = {
        id: 'err_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toISOString(),
        type,
        message: typeof message === 'string' ? message : (message?.message || JSON.stringify(message)),
        details: details ? (typeof details === 'object' ? details : { raw: details }) : (message?.stack ? { stack: message.stack } : null),
        request: req ? {
            method: req.method,
            url: req.originalUrl || req.url,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
        } : null
    };

    console.error(`❌ [ERROR LOGGED - ${type}]`, newEntry.message);

    logs.unshift(newEntry);
    if (logs.length > 300) logs.pop();

    try {
        fs.writeFileSync(ERROR_LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to write to error-logs.json:', err.message);
    }

    return newEntry;
}

// --- Helper: Read/Write WhatsApp Messages JSON ---
function getWaMessages() {
    if (!fs.existsSync(WA_MESSAGES_FILE)) {
        fs.writeFileSync(WA_MESSAGES_FILE, JSON.stringify([]));
        return [];
    }
    try {
        const data = fs.readFileSync(WA_MESSAGES_FILE, 'utf8');
        return JSON.parse(data) || [];
    } catch (e) {
        return [];
    }
}

function logWaMessage({
    direction = 'incoming', // 'incoming' | 'outgoing'
    from = null,
    to = null,
    senderName = 'Unknown Customer',
    text = '',
    timestamp = new Date().toISOString(),
    status = 'received', // 'received' | 'sent' | 'failed'
    rawId = null,
    error = null
}) {
    const logs = getWaMessages();
    const newEntry = {
        id: 'wamsg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        direction,
        from: from ? String(from).replace(/[^0-9]/g, '') : null,
        to: to ? String(to).replace(/[^0-9]/g, '') : null,
        senderName: senderName || 'Unknown Customer',
        text: text || '',
        timestamp: typeof timestamp === 'number' ? new Date(timestamp).toISOString() : (timestamp || new Date().toISOString()),
        status,
        rawId,
        error: error ? (typeof error === 'object' ? error : { message: String(error) }) : null
    };

    logs.unshift(newEntry);
    if (logs.length > 500) logs.pop();

    try {
        fs.writeFileSync(WA_MESSAGES_FILE, JSON.stringify(logs, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to write to whatsapp-messages.json:', err.message);
    }

    return newEntry;
}

// --- WhatsApp Meta Cloud API Configuration from .env ---
const WABA_ID = process.env.WABA_ID || process.env.waba_id || '';
const BUSINESS_ACCOUNT_ID = process.env.BUSINESS_ACCOUNT_ID || process.env.business_account_id || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || process.env.phone_number_id || '';
const SYSTEM_TOKEN = process.env.SYSTEM_TOKEN || process.env.system_token || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.whatsapp_verify_token || 'agentifire_push_webhook_verify_2026';
let WHATSAPP_DISPLAY_PHONE_NUMBER = (process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || process.env.whatsapp_display_phone_number || '15553815350').replace(/[^0-9]/g, '');

// Fetch & sync verified business phone number from Meta Graph API
async function syncWhatsAppBusinessProfile() {
    if (!PHONE_NUMBER_ID || !SYSTEM_TOKEN) {
        console.log('[WHATSAPP SYNC] Meta credentials missing in .env');
        return;
    }
    try {
        const res = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,code_verification_status,quality_rating`, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}` }
        });
        const data = await res.json();
        if (data && data.display_phone_number) {
            WHATSAPP_DISPLAY_PHONE_NUMBER = data.display_phone_number.replace(/[^0-9]/g, '');
            console.log(`[WHATSAPP SYNC] Connected to Meta: ${data.verified_name || 'Business'} (${data.display_phone_number})`);
        } else if (data.error) {
            logError({
                type: 'META_PROFILE_SYNC_ERROR',
                message: `Meta Graph API error: ${data.error.message}`,
                details: data.error
            });
            console.warn('[WHATSAPP SYNC WARNING]', data.error.message);
        }
    } catch (e) {
        logError({
            type: 'META_GRAPH_CONNECTION_FAILED',
            message: `Failed to connect to Meta Graph API: ${e.message}`,
            details: { stack: e.stack }
        });
        console.warn('[WHATSAPP SYNC WARNING] Failed to connect to Meta Graph API:', e.message);
    }
}

// Generate direct WhatsApp deep-link with prefilled text
function getWhatsAppDeepLink(text = '') {
    const cleanNumber = (WHATSAPP_DISPLAY_PHONE_NUMBER || '15553815350').replace(/[^0-9]/g, '');
    return `https://wa.me/${cleanNumber}?text=${encodeURIComponent(text)}`;
}

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

// --- Helper: Check 24-Hour Roundtrip Status ---
function get24hStatus(sub) {
    if (!sub || !sub.whatsapp24h || !sub.whatsapp24h.expiresAt) {
        return {
            isActive: false,
            statusText: 'Expired / Not Started',
            remainingMs: 0,
            remainingFormatted: 'Expired'
        };
    }

    const expiresAt = new Date(sub.whatsapp24h.expiresAt).getTime();
    const now = Date.now();
    const remainingMs = expiresAt - now;

    if (remainingMs > 0) {
        const hours = Math.floor(remainingMs / (1000 * 60 * 60));
        const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        return {
            isActive: true,
            statusText: 'Active',
            remainingMs,
            remainingFormatted: `${hours}h ${minutes}m left`
        };
    } else {
        return {
            isActive: false,
            statusText: 'Expired',
            remainingMs: 0,
            remainingFormatted: 'Expired'
        };
    }
}

// --- Helper: Read/Write Auto Push Config ---
function getAutoConfig() {
    const defaults = {
        whatsapp: {
            enabled: true,
            displayPhoneNumber: WHATSAPP_DISPLAY_PHONE_NUMBER || '15553815350',
            defaultWelcomeText: "Hi! I want to complete my subscription and activate real-time alerts.",
            defaultPromoText: "Hi! I saw your promotion and I want to claim the special offer.",
            defaultReopen24hText: "Hi! Please re-open my 24h VIP alerts session."
        },
        welcome: {
            enabled: true,
            title: "💬 Complete Your WhatsApp Activation!",
            body: "Tap here to send a quick WhatsApp message and unlock your free 24h VIP alerts!",
            url: "/api/redirect-wa?type=welcome",
            delaySeconds: 2
        },
        reengagement24h: {
            enabled: true,
            title: "⚡ 24h Window Expired - Re-activate Now!",
            body: "Tap here to re-open your free 24h WhatsApp alerts with 1 click.",
            url: "/api/redirect-wa?type=reopen"
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
        const config = JSON.parse(fs.readFileSync(AUTO_CONFIG_FILE, 'utf8'));
        return { ...defaults, ...config };
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
async function sendPushBroadcast({ title, body, icon = '/icon-192.png', url = '/', target = 'all', subscriberId = null, extraData = {} }) {
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
    } else if (target === 'expired_24h') {
        recipients = allSubscriptions.filter(s => !get24hStatus(s).isActive);
    } else if (target === 'active_24h') {
        recipients = allSubscriptions.filter(s => get24hStatus(s).isActive);
    }

    const results = { total: recipients.length, sent: 0, failed: 0, cleaned: 0 };
    const expiredEndpoints = [];

    await Promise.all(recipients.map(async (sub) => {
        try {
            // Personalize URL with subscriber ID if needed
            let personalizedUrl = url;
            if (url && url.includes('/api/redirect-wa')) {
                personalizedUrl = `${url}${url.includes('?') ? '&' : '?'}subId=${sub.id}`;
            }

            const payload = JSON.stringify({
                title,
                body,
                icon,
                data: {
                    url: personalizedUrl || '/',
                    subscriberId: sub.id,
                    dateOfArrival: Date.now(),
                    ...extraData
                }
            });

            await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
                TTL: 24 * 60 * 60
            });
            results.sent++;
        } catch (error) {
            results.failed++;
            logError({
                type: 'PUSH_DELIVERY_FAILED',
                message: `Failed push delivery to ${sub.name} (${sub.platform}): ${error.message}`,
                details: {
                    statusCode: error.statusCode,
                    subscriberId: sub.id,
                    name: sub.name,
                    platform: sub.platform,
                    endpointPreview: sub.endpoint.substring(0, 50) + '...',
                    body: error.body || null
                }
            });
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

// ==========================================
// --- META WHATSAPP WEBHOOK ENDPOINTS ---
// ==========================================

// 1. Meta Webhook Verification (GET)
app.get('/api/whatsapp/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log(`[WHATSAPP WEBHOOK] Verification probe: mode="${mode}", token="${token}"`);

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
        console.log('[WHATSAPP WEBHOOK] Verified successfully with Meta!');
        return res.status(200).send(challenge);
    } else {
        logError({
            type: 'WEBHOOK_VERIFY_FAILED',
            message: `Meta webhook verification token mismatch. Received "${token}", Expected "${WHATSAPP_VERIFY_TOKEN}"`,
            details: { mode, receivedToken: token },
            req
        });
        console.error(`[WHATSAPP WEBHOOK] Verification failed! Received "${token}", Expected "${WHATSAPP_VERIFY_TOKEN}"`);
        return res.sendStatus(403);
    }
});

// 2. Meta Incoming Webhook Events (POST)
// Detects incoming WhatsApp messages from customers and opens their 24h roundtrip window!
app.post('/api/whatsapp/webhook', (req, res) => {
    try {
        const body = req.body;
        console.log('[WHATSAPP WEBHOOK] Inbound event received from Meta');

        if (body.object === 'whatsapp_business_account') {
            if (body.entry && body.entry.length > 0) {
                body.entry.forEach(entry => {
                    (entry.changes || []).forEach(change => {
                        const val = change.value;
                        if (val && val.messages && val.messages.length > 0) {
                            val.messages.forEach(msg => {
                                const fromPhone = msg.from; // e.g. "923001234567"
                                const msgText = msg.text ? msg.text.body : (msg.type || 'media/button');
                                const timestamp = msg.timestamp ? parseInt(msg.timestamp) * 1000 : Date.now();
                                const now = Date.now();
                                const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();

                                // Extract contact profile name if Meta provided it
                                let contactName = 'WhatsApp Customer';
                                if (val.contacts && val.contacts.length > 0) {
                                    const c = val.contacts.find(cnt => cnt.wa_id === fromPhone) || val.contacts[0];
                                    if (c && c.profile && c.profile.name) {
                                        contactName = c.profile.name;
                                    }
                                }

                                console.log(`\n======================================================`);
                                console.log(`🟢 [24h WINDOW OPENED] Inbound message from: +${fromPhone} (${contactName})`);
                                console.log(`💬 Message Text: "${msgText}"`);
                                console.log(`⏳ Free 24h Customer Service Window Active Until: ${expiresAt}`);
                                console.log(`======================================================\n`);

                                // Match subscriber in subscriptions.json
                                const subscriptions = getSubscriptions();
                                let matched = subscriptions.find(s => s.phone && s.phone.replace(/[^0-9]/g, '') === fromPhone.replace(/[^0-9]/g, ''));

                                // Fallback: If phone not yet bound, match subscriber who recently clicked the WhatsApp link
                                if (!matched && subscriptions.length > 0) {
                                    matched = subscriptions.slice().sort((a, b) => new Date(b.lastWaClickAt || b.lastActive || 0) - new Date(a.lastWaClickAt || a.lastActive || 0))[0];
                                }

                                if (matched) {
                                    matched.phone = fromPhone;
                                    matched.whatsapp24h = {
                                        isActive: true,
                                        openedAt: new Date(timestamp).toISOString(),
                                        expiresAt: expiresAt,
                                        lastMessage: msgText
                                    };
                                    saveSubscriptions(subscriptions);
                                    console.log(`[SUBSCRIPTION UPDATED] 24h roundtrip activated for ${matched.name} (${matched.id})`);
                                    if (!contactName || contactName === 'WhatsApp Customer') {
                                        contactName = matched.name;
                                    }
                                }

                                // 🟢 Record inbound message to whatsapp-messages.json logs
                                logWaMessage({
                                    direction: 'incoming',
                                    from: fromPhone,
                                    to: WHATSAPP_DISPLAY_PHONE_NUMBER,
                                    senderName: contactName,
                                    text: msgText,
                                    timestamp: timestamp,
                                    status: 'received',
                                    rawId: msg.id || null
                                });
                            });
                        }
                    });
                });
            }
            return res.status(200).send('EVENT_RECEIVED');
        } else {
            return res.sendStatus(404);
        }
    } catch (e) {
        logError({
            type: 'WEBHOOK_PROCESS_ERROR',
            message: `Error processing Meta WhatsApp webhook event: ${e.message}`,
            details: { stack: e.stack, body: req.body },
            req
        });
        console.error('[WHATSAPP WEBHOOK ERROR]', e);
        return res.status(200).send('ERROR_HANDLED');
    }
});

// 3. Smart WhatsApp Deep Link & Click Tracker Redirect
app.get('/api/redirect-wa', (req, res) => {
    const { type = 'welcome', subId, promoText } = req.query;
    const autoConfig = getAutoConfig();

    let text = autoConfig.whatsapp?.defaultWelcomeText || 'Hi! I want to complete my subscription and activate real-time alerts.';
    if (type === 'reopen') {
        text = autoConfig.whatsapp?.defaultReopen24hText || 'Hi! Please re-open my 24h VIP alerts session.';
    } else if (type === 'promo') {
        text = promoText || autoConfig.whatsapp?.defaultPromoText || 'Hi! I saw your promotion and I want to claim the special offer.';
    }

    if (subId) {
        const subs = getSubscriptions();
        const sub = subs.find(s => s.id === subId);
        if (sub) {
            sub.lastWaClickAt = new Date().toISOString();
            saveSubscriptions(subs);
            console.log(`[WA CLICK] Subscriber ${sub.name} tapped WhatsApp notification (${type})`);
        }
    }

    const waLink = getWhatsAppDeepLink(text);
    return res.redirect(waLink);
});

// 4. WhatsApp Configuration & Webhook Status
app.get('/api/whatsapp/status', (req, res) => {
    const subscriptions = getSubscriptions();
    let active24h = 0;
    let expired24h = 0;

    subscriptions.forEach(s => {
        if (get24hStatus(s).isActive) {
            active24h++;
        } else {
            expired24h++;
        }
    });

    const localIp = getLocalIp();
    const config = getAutoConfig();

    res.json({
        configured: Boolean(PHONE_NUMBER_ID && SYSTEM_TOKEN),
        waba_id: WABA_ID,
        phone_number_id: PHONE_NUMBER_ID,
        display_phone_number: WHATSAPP_DISPLAY_PHONE_NUMBER,
        verify_token: WHATSAPP_VERIFY_TOKEN,
        webhook_path: '/api/whatsapp/webhook',
        full_webhook_url_example: `https://YOUR-DOMAIN-OR-TUNNEL.loca.lt/api/whatsapp/webhook`,
        active24h,
        expired24h,
        totalSubscribers: subscriptions.length,
        config: config.whatsapp || {}
    });
});

// 5. Send 24h Re-Open Push Notification Broadcast (To reopen expired 24h window)
app.post('/api/send-24h-reopen', async (req, res) => {
    const { subscriberId = null, target = 'expired_24h' } = req.body;
    const config = getAutoConfig();
    const cleanNumber = (WHATSAPP_DISPLAY_PHONE_NUMBER || '15553815350').replace(/[^0-9]/g, '');
    const reopenText = config.whatsapp?.defaultReopen24hText || 'Hi! Please re-open my 24h VIP alerts session.';

    // Direct wa.me link with prefilled text
    const waUrl = `https://wa.me/${cleanNumber}?text=${encodeURIComponent(reopenText)}`;

    const title = config.reengagement24h?.title || '⚡ 24h WhatsApp Session Expired!';
    const body = config.reengagement24h?.body || 'Tap here to send 1 quick message & re-open your free 24h WhatsApp alerts!';

    const results = await sendPushBroadcast({
        title,
        body,
        icon: '/icon-192.png',
        url: `/api/redirect-wa?type=reopen`,
        target,
        subscriberId,
        extraData: {
            is24hReopen: true,
            waUrl
        }
    });

    res.json({
        success: true,
        message: `24h Re-Open Push Notification sent to ${results.sent} device(s)!`,
        results
    });
});

// 6. Direct Meta WhatsApp Message Sender
async function sendDirectWhatsAppMessage(toPhone, messageText) {
    if (!PHONE_NUMBER_ID || !SYSTEM_TOKEN) {
        throw new Error('Meta credentials (phone_number_id or system_token) not configured in .env');
    }

    const cleanTo = (toPhone || '').replace(/[^0-9]/g, '');
    if (!cleanTo || cleanTo.length < 8) {
        throw new Error('Please enter a valid phone number with country code (e.g. 923001234567 or 15553815350).');
    }

    if (!messageText || !messageText.trim()) {
        throw new Error('Message text cannot be empty.');
    }

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
        type: 'text',
        text: {
            preview_url: false,
            body: messageText.trim()
        }
    };

    const res = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SYSTEM_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        const errMsg = data.error?.message || `Meta API error (${res.status})`;
        logWaMessage({
            direction: 'outgoing',
            from: WHATSAPP_DISPLAY_PHONE_NUMBER,
            to: cleanTo,
            senderName: 'You (Agentifire)',
            text: messageText,
            status: 'failed',
            error: data.error || errMsg
        });
        logError({
            type: 'WA_SEND_FAILED',
            message: `Failed to send WhatsApp message to +${cleanTo}: ${errMsg}`,
            details: data.error
        });
        return { success: false, error: errMsg, details: data.error };
    }

    const msgId = data.messages && data.messages[0] ? data.messages[0].id : null;
    logWaMessage({
        direction: 'outgoing',
        from: WHATSAPP_DISPLAY_PHONE_NUMBER,
        to: cleanTo,
        senderName: 'You (Agentifire)',
        text: messageText,
        status: 'sent',
        rawId: msgId
    });

    return {
        success: true,
        messageId: msgId,
        data
    };
}

// 7. Get All WhatsApp Messages (Inbound & Outbound Logs)
app.get('/api/whatsapp/messages', (req, res) => {
    const messages = getWaMessages();
    const incomingCount = messages.filter(m => m.direction === 'incoming').length;
    const outgoingCount = messages.filter(m => m.direction === 'outgoing').length;
    res.json({
        total: messages.length,
        incomingCount,
        outgoingCount,
        messages
    });
});

// 8. Send Direct WhatsApp Test Message
app.post('/api/whatsapp/send-message', async (req, res) => {
    const { to, message } = req.body;
    try {
        const result = await sendDirectWhatsAppMessage(to, message);
        if (result.success) {
            return res.json({
                success: true,
                message: `WhatsApp message delivered successfully to +${(to || '').replace(/[^0-9]/g, '')}!`,
                messageId: result.messageId,
                data: result.data
            });
        } else {
            return res.status(400).json({
                success: false,
                error: result.error,
                details: result.details
            });
        }
    } catch (e) {
        logError({
            type: 'WA_SEND_EXCEPTION',
            message: e.message,
            details: { to, message, stack: e.stack },
            req
        });
        return res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// 9. Clear WhatsApp Message Logs
app.post('/api/whatsapp/messages/clear', (req, res) => {
    try {
        fs.writeFileSync(WA_MESSAGES_FILE, JSON.stringify([], null, 2), 'utf8');
        res.json({
            success: true,
            message: 'All WhatsApp message logs have been cleared!'
        });
    } catch (e) {
        logError({
            type: 'WA_CLEAR_LOGS_FAILED',
            message: e.message,
            details: { stack: e.stack }
        });
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// --- STANDARD WEB PUSH API ENDPOINTS ---
// ==========================================

// 1. Get Public VAPID Key for client subscription
app.get('/api/config', (req, res) => {
    res.json({
        publicKey: vapidKeys.publicKey,
        whatsappNumber: WHATSAPP_DISPLAY_PHONE_NUMBER,
        waWelcomeLink: getWhatsAppDeepLink(getAutoConfig().whatsapp?.defaultWelcomeText)
    });
});

// 2. Subscribe a new device with Auto WhatsApp Welcome Push
app.post('/api/subscribe', (req, res) => {
    const { subscription, deviceName, platform, userAgent, phone } = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
        logError({
            type: 'INVALID_SUBSCRIPTION_PAYLOAD',
            message: 'Invalid subscription object received: missing endpoint or keys',
            details: req.body,
            req
        });
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
        phone: phone || (existingIndex !== -1 ? subscriptions[existingIndex].phone : null),
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        subscribedAt: existingIndex !== -1 ? subscriptions[existingIndex].subscribedAt : new Date().toISOString(),
        lastActive: new Date().toISOString(),
        lastWaClickAt: null,
        whatsapp24h: existingIndex !== -1 && subscriptions[existingIndex].whatsapp24h ? subscriptions[existingIndex].whatsapp24h : {
            isActive: false,
            expiresAt: null
        }
    };

    if (existingIndex !== -1) {
        subscriptions[existingIndex] = subscriptionEntry;
        console.log(`[UPDATE] Subscription updated: ${subscriptionEntry.name} (${subscriptionEntry.platform})`);
    } else {
        subscriptions.push(subscriptionEntry);
        console.log(`[NEW] Device subscribed: ${subscriptionEntry.name} (${subscriptionEntry.platform})`);
    }

    saveSubscriptions(subscriptions);

    // --- AUTO PUSH: Send Welcome Notification that leads directly into WhatsApp ---
    const autoConfig = getAutoConfig();
    if (autoConfig.welcome && autoConfig.welcome.enabled) {
        const delayMs = (autoConfig.welcome.delaySeconds || 2) * 1000;
        console.log(`[AUTO PUSH] Scheduling WhatsApp welcome push in ${delayMs}ms for ${subscriptionEntry.name}`);

        setTimeout(async () => {
            try {
                const welcomeUrl = `/api/redirect-wa?type=welcome&subId=${subscriptionEntry.id}`;
                const payload = JSON.stringify({
                    title: autoConfig.welcome.title || '💬 Complete Your WhatsApp Activation!',
                    body: autoConfig.welcome.body || 'Tap here to send a quick WhatsApp message and unlock your 24h VIP alerts!',
                    icon: '/icon-192.png',
                    data: {
                        url: welcomeUrl,
                        subscriberId: subscriptionEntry.id,
                        isWhatsAppWelcome: true
                    }
                });

                await webpush.sendNotification({
                    endpoint: subscriptionEntry.endpoint,
                    keys: subscriptionEntry.keys
                }, payload);

                console.log(`[AUTO PUSH SUCCESS] WhatsApp welcome push notification sent to ${subscriptionEntry.name}`);
            } catch (err) {
                logError({
                    type: 'AUTO_WELCOME_PUSH_FAILED',
                    message: `Failed auto welcome push for ${subscriptionEntry.name}: ${err.message}`,
                    details: { stack: err.stack, subscriberId: subscriptionEntry.id }
                });
                console.error(`[AUTO PUSH ERROR] Failed auto welcome push:`, err.message);
            }
        }, delayMs);
    }

    res.status(201).json({
        success: true,
        message: 'Device subscribed successfully! Welcome push leading to WhatsApp scheduled.',
        subscriber: subscriptionEntry,
        waLink: getWhatsAppDeepLink(autoConfig.whatsapp?.defaultWelcomeText)
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

// 4. List all subscribers with 24-Hour Roundtrip Live Status
app.get('/api/subscriptions', (req, res) => {
    const subscriptions = getSubscriptions();
    const sanitized = subscriptions.map(sub => {
        const roundtrip = get24hStatus(sub);
        return {
            id: sub.id,
            name: sub.name,
            platform: sub.platform,
            phone: sub.phone || null,
            endpointPreview: sub.endpoint.substring(0, 45) + '...',
            subscribedAt: sub.subscribedAt,
            lastActive: sub.lastActive,
            lastWaClickAt: sub.lastWaClickAt || null,
            whatsapp24h: {
                isActive: roundtrip.isActive,
                statusText: roundtrip.statusText,
                remainingFormatted: roundtrip.remainingFormatted,
                remainingMs: roundtrip.remainingMs,
                expiresAt: sub.whatsapp24h?.expiresAt || null,
                lastMessage: sub.whatsapp24h?.lastMessage || null
            }
        };
    });
    res.json({
        total: subscriptions.length,
        subscribers: sanitized
    });
});

// 5. Send Manual Push Notification (With Click-to-WhatsApp Promo Support)
app.post('/api/send-notification', async (req, res) => {
    const {
        title = 'New Notification',
        body = 'Hello from Push Notification System!',
        icon = '/icon-192.png',
        url = '/',
        target = 'all',
        subscriberId = null,
        openWhatsApp = false,
        whatsappText = null
    } = req.body;

    const allSubscriptions = getSubscriptions();
    if (allSubscriptions.length === 0) {
        logError({
            type: 'NO_SUBSCRIBERS_FOUND',
            message: 'Notification send failed: no subscribers found in subscriptions.json',
            req
        });
        return res.status(400).json({
            success: false,
            message: 'No subscribers found! Please subscribe a device first.'
        });
    }

    let finalUrl = url;
    if (openWhatsApp) {
        const text = whatsappText || getAutoConfig().whatsapp?.defaultPromoText || 'Hi! I saw your promotion and I want to claim the special offer.';
        finalUrl = `/api/redirect-wa?type=promo&promoText=${encodeURIComponent(text)}`;
    }

    try {
        const results = await sendPushBroadcast({
            title,
            body,
            icon,
            url: finalUrl,
            target,
            subscriberId,
            extraData: {
                openWhatsApp: Boolean(openWhatsApp)
            }
        });

        res.json({
            success: true,
            message: `Notification sent to ${results.sent} of ${results.total} device(s). ${openWhatsApp ? '(Opens WhatsApp on click)' : ''}`,
            results
        });
    } catch (err) {
        logError({
            type: 'SEND_NOTIFICATION_EXCEPTION',
            message: `Failed to broadcast notification: ${err.message}`,
            details: { stack: err.stack },
            req
        });
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// 6. Schedule Auto Notification
app.post('/api/schedule-auto', (req, res) => {
    const {
        seconds = 5,
        title = '⏱️ Auto Scheduled Notification',
        body = 'This notification arrived automatically after a timer countdown!',
        url = '/',
        subscriberId = null,
        openWhatsApp = false
    } = req.body;

    const delayMs = Math.max(1, parseInt(seconds)) * 1000;
    console.log(`[SCHEDULED AUTO] Notification scheduled in ${delayMs / 1000} seconds...`);

    let finalUrl = url;
    if (openWhatsApp) {
        finalUrl = `/api/redirect-wa?type=promo`;
    }

    setTimeout(async () => {
        console.log(`[SCHEDULED AUTO] Triggering scheduled notification now!`);
        await sendPushBroadcast({
            title,
            body,
            url: finalUrl,
            subscriberId
        });
    }, delayMs);

    res.json({
        success: true,
        message: `Auto notification scheduled! It will arrive in ${seconds} seconds.`
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
        whatsapp: {
            ...current.whatsapp,
            ...(req.body.whatsapp || {})
        },
        welcome: {
            ...current.welcome,
            ...(req.body.welcome || {})
        },
        reengagement24h: {
            ...current.reengagement24h,
            ...(req.body.reengagement24h || {})
        },
        recurring: {
            ...current.recurring,
            ...(req.body.recurring || {})
        }
    };

    saveAutoConfig(updated);
    res.json({
        success: true,
        message: 'Push & WhatsApp settings saved successfully!',
        config: updated
    });
});

// Shortcut route
app.get('/send', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'send.html'));
});

// --- ERROR LOGS API ENDPOINTS ---

// 1. Get All Error Logs
app.get('/api/error-logs', (req, res) => {
    const logs = getErrorLogs();
    res.json({
        total: logs.length,
        logs
    });
});

// 2. Clear Error Logs
app.post('/api/error-logs/clear', (req, res) => {
    try {
        fs.writeFileSync(ERROR_LOGS_FILE, JSON.stringify([], null, 2), 'utf8');
        res.json({
            success: true,
            message: 'All error logs have been cleared successfully!'
        });
    } catch (e) {
        logError({
            type: 'CLEAR_LOGS_FAILED',
            message: e.message,
            details: { stack: e.stack }
        });
        res.status(500).json({ success: false, error: e.message });
    }
});

// Global Express Error Middleware
app.use((err, req, res, next) => {
    logError({
        type: 'EXPRESS_UNHANDLED_ERROR',
        message: err.message,
        details: { stack: err.stack },
        req
    });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Process Uncaught Exceptions & Rejections
process.on('uncaughtException', (err) => {
    logError({
        type: 'UNCAUGHT_EXCEPTION',
        message: err.message,
        details: { stack: err.stack }
    });
});

process.on('unhandledRejection', (reason) => {
    logError({
        type: 'UNHANDLED_REJECTION',
        message: reason?.message || String(reason),
        details: reason?.stack ? { stack: reason.stack } : { reason }
    });
});

// Initialize
restartRecurringTimer();
syncWhatsAppBusinessProfile();

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log(`\n======================================================`);
    console.log(`🚀 Push Notification + WhatsApp 24h Server ACTIVE on Port ${PORT}!`);
    console.log(`------------------------------------------------------`);
    console.log(`📱 1. Client / Subscribe Page:`);
    console.log(`   - Localhost:    http://localhost:${PORT}`);
    console.log(`   - Mobile Wi-Fi: http://${localIp}:${PORT}`);
    console.log(``);
    console.log(`📤 2. Send & 24h Roundtrip Dashboard:`);
    console.log(`   - Localhost:    http://localhost:${PORT}/send.html`);
    console.log(`   - Mobile Wi-Fi: http://${localIp}:${PORT}/send.html`);
    console.log(``);
    console.log(`🔗 3. Meta WhatsApp Webhook URL:`);
    console.log(`   - Path:         /api/whatsapp/webhook`);
    console.log(`   - Verify Token: ${WHATSAPP_VERIFY_TOKEN}`);
    console.log(`   - Phone Number: +${WHATSAPP_DISPLAY_PHONE_NUMBER}`);
    console.log(`======================================================\n`);
});
