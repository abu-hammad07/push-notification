require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
// Keep the raw body so Meta webhook payloads can be relayed byte-for-byte (signature stays valid)
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Files ---
const VAPID_FILE = path.join(__dirname, 'vapid-keys.json');

// --- Country Code & Phone Settings ---
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '92').replace(/[^0-9]/g, '');

function normalizePhone(raw, countryCode = DEFAULT_COUNTRY_CODE) {
    return db.normalizePhone(raw, countryCode);
}

// --- WhatsApp Meta Cloud API Configuration from .env ---
const WABA_ID = process.env.WABA_ID || process.env.waba_id || '';
const BUSINESS_ACCOUNT_ID = process.env.BUSINESS_ACCOUNT_ID || process.env.business_account_id || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || process.env.phone_number_id || '';
const SYSTEM_TOKEN = process.env.SYSTEM_TOKEN || process.env.system_token || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.whatsapp_verify_token || 'agentifire_push_webhook_verify_2026';
let WHATSAPP_DISPLAY_PHONE_NUMBER = (process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || process.env.whatsapp_display_phone_number || '15553815350').replace(/[^0-9]/g, '');
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const PUBLIC_WEBHOOK_URL = APP_URL ? `${APP_URL}/api/whatsapp/webhook` : null;
const WEBHOOK_FORWARD_URLS = String(process.env.WEBHOOK_FORWARD_URLS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

// Relay the exact raw payload + Meta signature to other platforms sharing this number
function forwardWebhook(req) {
    if (WEBHOOK_FORWARD_URLS.length === 0 || !req.rawBody) return;
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers['x-hub-signature-256']) headers['X-Hub-Signature-256'] = req.headers['x-hub-signature-256'];
    if (req.headers['x-hub-signature']) headers['X-Hub-Signature'] = req.headers['x-hub-signature'];
    WEBHOOK_FORWARD_URLS.forEach(url => {
        fetch(url, { method: 'POST', headers, body: req.rawBody })
            .then(r => console.log(`[WEBHOOK RELAY] -> ${url} (${r.status})`))
            .catch(e => db.logError({ type: 'WEBHOOK_RELAY_FAILED', message: `Relay to ${url} failed: ${e.message}` }));
    });
}

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
            await db.logError({
                type: 'META_PROFILE_SYNC_ERROR',
                message: `Meta Graph API error: ${data.error.message}`,
                details: data.error
            });
            console.warn('[WHATSAPP SYNC WARNING]', data.error.message);
        }
    } catch (e) {
        await db.logError({
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

// --- Recurring Auto Push Timer ---
let recurringTimer = null;

async function restartRecurringTimer() {
    if (recurringTimer) {
        clearInterval(recurringTimer);
        recurringTimer = null;
    }

    try {
        const config = await db.getAutoConfig();
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
    } catch (e) {
        console.error('Failed to configure recurring timer:', e.message);
    }
}

// Helper to send push to recipients
async function sendPushBroadcast({ title, body, icon = '/icon-192.png', url = '/', target = 'all', subscriberId = null, extraData = {} }) {
    const allSubscriptions = await db.getSubscribers();
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
        recipients = allSubscriptions.filter(s => !s.whatsapp24h?.isActive);
    } else if (target === 'active_24h') {
        recipients = allSubscriptions.filter(s => s.whatsapp24h?.isActive);
    }

    const results = { total: recipients.length, sent: 0, failed: 0, cleaned: 0 };

    await Promise.all(recipients.map(async (sub) => {
        try {
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
            await db.updateSubscriberLastActive(sub.endpoint);
        } catch (error) {
            results.failed++;
            await db.logError({
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
                await db.deleteSubscriber(sub.id);
                results.cleaned++;
            }
        }
    }));

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
        db.logError({
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
// Detects incoming WhatsApp messages from customers and opens their 24h roundtrip window in PostgreSQL!
app.post('/api/whatsapp/webhook', async (req, res) => {
    try {
        const body = req.body;
        console.log('[WHATSAPP WEBHOOK] Inbound event received from Meta');
        await db.logWebhookEvent(body);
        forwardWebhook(req);

        if (body.object === 'whatsapp_business_account') {
            if (body.entry && body.entry.length > 0) {
                for (const entry of body.entry) {
                    for (const change of (entry.changes || [])) {
                        const val = change.value;

                        // Delivery status updates for our outgoing messages (sent/delivered/read/failed)
                        if (val && val.statuses && val.statuses.length > 0) {
                            for (const st of val.statuses) {
                                const err = st.errors && st.errors[0] ? st.errors[0] : null;
                                await db.updateWaMessageStatus(st.id, st.status, err);
                                if (err && Number(err.code) === 131047) {
                                    // "Re-engagement message": more than 24h since customer's last message
                                    await db.closeWindowForPhone(st.recipient_id);
                                }
                            }
                        }

                        // Inbound customer messages
                        if (val && val.messages && val.messages.length > 0) {
                            for (const msg of val.messages) {
                                const fromPhone = normalizePhone(msg.from) || String(msg.from || '');
                                const msgText = msg.text ? msg.text.body
                                    : (msg.button ? msg.button.text
                                    : (msg.interactive ? (msg.interactive.button_reply?.title || msg.interactive.list_reply?.title || 'interactive')
                                    : (msg.type || 'media/button')));
                                const timestamp = msg.timestamp ? parseInt(msg.timestamp) * 1000 : Date.now();
                                const expiresAt = new Date(timestamp + 24 * 3600 * 1000).toISOString();

                                let contactName = 'WhatsApp Customer';
                                if (val.contacts && val.contacts.length > 0) {
                                    const c = val.contacts.find(cnt => cnt.wa_id === fromPhone) || val.contacts[0];
                                    if (c && c.profile && c.profile.name) {
                                        contactName = c.profile.name;
                                    }
                                }

                                console.log(`\n======================================================`);
                                console.log(`🟢 [24h WINDOW OPENED IN POSTGRESQL] Inbound message from: +${fromPhone} (${contactName})`);
                                console.log(`💬 Message Text: "${msgText}"`);
                                console.log(`⏳ Free 24h Customer Service Window Active Until: ${expiresAt}`);
                                console.log(`======================================================\n`);

                                // 1) Open window in PostgreSQL whatsapp_windows table (updates all devices with this number live)
                                await db.openWindowForPhone(fromPhone, timestamp, msgText, contactName);

                                // 2) Log inbound message into whatsapp_messages table in PostgreSQL
                                await db.logWaMessage({
                                    direction: 'incoming',
                                    from: fromPhone,
                                    to: WHATSAPP_DISPLAY_PHONE_NUMBER,
                                    senderName: contactName,
                                    text: msgText,
                                    timestamp: new Date(timestamp),
                                    status: 'received',
                                    rawId: msg.id || null
                                });
                            }
                        }
                    }
                }
            }
            return res.status(200).send('EVENT_RECEIVED');
        } else {
            return res.sendStatus(404);
        }
    } catch (e) {
        await db.logError({
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
app.get('/api/redirect-wa', async (req, res) => {
    const { type = 'welcome', subId, promoText } = req.query;
    const autoConfig = await db.getAutoConfig();

    let text = autoConfig.whatsapp?.defaultWelcomeText || 'Hi! I want to complete my subscription and activate real-time alerts.';
    if (type === 'reopen') {
        text = autoConfig.whatsapp?.defaultReopen24hText || 'Hi! Please re-open my 24h VIP alerts session.';
    } else if (type === 'promo') {
        text = promoText || autoConfig.whatsapp?.defaultPromoText || 'Hi! I saw your promotion and I want to claim the special offer.';
    }

    if (subId) {
        await db.updateSubscriberWaClick(subId);
    }

    const waLink = getWhatsAppDeepLink(text);
    return res.redirect(waLink);
});

// 4. WhatsApp Configuration & Webhook Status
app.get('/api/whatsapp/status', async (req, res) => {
    const subscriptions = await db.getSubscribers();
    let active24h = 0;
    let expired24h = 0;

    subscriptions.forEach(s => {
        if (s.whatsapp24h && s.whatsapp24h.isActive) {
            active24h++;
        } else {
            expired24h++;
        }
    });

    const localIp = getLocalIp();
    const config = await db.getAutoConfig();

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
    const config = await db.getAutoConfig();
    const cleanNumber = (WHATSAPP_DISPLAY_PHONE_NUMBER || '15553815350').replace(/[^0-9]/g, '');
    const reopenText = config.whatsapp?.defaultReopen24hText || 'Hi! Please re-open my 24h VIP alerts session.';

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

    const cleanTo = normalizePhone(toPhone);
    if (!cleanTo) {
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
        if (Number(data.error?.code) === 131047) {
            await db.closeWindowForPhone(cleanTo);
        }
        await db.logWaMessage({
            direction: 'outgoing',
            from: WHATSAPP_DISPLAY_PHONE_NUMBER,
            to: cleanTo,
            senderName: 'You (Agentifire)',
            text: messageText,
            status: 'failed',
            error: data.error || errMsg
        });
        await db.logError({
            type: 'WA_SEND_FAILED',
            message: `Failed to send WhatsApp message to +${cleanTo}: ${errMsg}`,
            details: data.error
        });
        return { success: false, error: errMsg, details: data.error };
    }

    const msgId = data.messages && data.messages[0] ? data.messages[0].id : null;
    
    // Meta confirmed send succeeded -> activates 24h window in PostgreSQL in real time!
    await db.openWindowForPhone(cleanTo, Date.now(), messageText, 'You (Agentifire)');

    await db.logWaMessage({
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

// 6e. 1-Click Runtime Activation & Live Sync of 24h Window
app.post('/api/whatsapp/activate-24h', async (req, res) => {
    try {
        const { phone, subscriberId } = req.body;
        let targetPhone = phone;
        if (!targetPhone && subscriberId) {
            const sub = await db.getSubscriberById(subscriberId);
            if (sub) targetPhone = sub.phone;
        }
        const cleanPhone = normalizePhone(targetPhone);
        if (!cleanPhone) {
            return res.status(400).json({ success: false, error: 'Valid WhatsApp phone number required' });
        }
        await db.openWindowForPhone(cleanPhone, Date.now(), 'Manual runtime activation');
        const updatedStatus = await db.getWindowForPhone(cleanPhone);
        res.json({
            success: true,
            message: `24h window activated in PostgreSQL for +${cleanPhone}!`,
            status: updatedStatus
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 6b. Check 24h customer-service window for any number (live computed from PostgreSQL)
app.get('/api/whatsapp/window/:phone', async (req, res) => {
    try {
        const phone = normalizePhone(req.params.phone, req.query.cc);
        if (!phone) return res.status(400).json({ success: false, error: 'Invalid phone number' });
        const status = await db.getWindowForPhone(phone);
        res.json({ success: true, phone, ...status });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 6c. Webhook health: where is Meta actually sending this number's events?
app.get('/api/whatsapp/webhook-health', async (req, res) => {
    const lastWebhookAt = await db.getLastWebhookAt();
    const result = {
        expectedWebhookUrl: PUBLIC_WEBHOOK_URL,
        lastWebhookAt,
        forwardUrls: WEBHOOK_FORWARD_URLS,
        metaWebhookConfiguration: null,
        isRoutedHere: null
    };
    if (!PHONE_NUMBER_ID || !SYSTEM_TOKEN) {
        return res.json({ ...result, error: 'Meta credentials missing in .env' });
    }
    try {
        const r = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}?fields=webhook_configuration`, {
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}` }
        });
        const data = await r.json();
        if (data.error) throw new Error(data.error.message);
        const cfg = data.webhook_configuration || {};
        const effective = cfg.phone_number || cfg.whatsapp_business_account || cfg.application || null;
        result.metaWebhookConfiguration = cfg;
        result.effectiveWebhookUrl = effective;
        result.isRoutedHere = Boolean(PUBLIC_WEBHOOK_URL && effective && effective.replace(/\/+$/, '') === PUBLIC_WEBHOOK_URL);
        res.json(result);
    } catch (e) {
        await db.logError({ type: 'WEBHOOK_HEALTH_FAILED', message: e.message });
        res.status(500).json({ ...result, error: e.message });
    }
});

// 6d. Route this phone number's Meta webhooks to THIS server (phone-number level override)
app.post('/api/whatsapp/webhook-override', async (req, res) => {
    if (!PHONE_NUMBER_ID || !SYSTEM_TOKEN) return res.status(400).json({ success: false, error: 'Meta credentials missing in .env' });
    if (!PUBLIC_WEBHOOK_URL) return res.status(400).json({ success: false, error: 'APP_URL missing in .env' });
    try {
        const r = await fetch(`https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${SYSTEM_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                webhook_configuration: {
                    override_callback_uri: PUBLIC_WEBHOOK_URL,
                    verify_token: WHATSAPP_VERIFY_TOKEN
                }
            })
        });
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error?.message || `Meta API error (${r.status})`);
        console.log(`[WEBHOOK OVERRIDE] Phone ${PHONE_NUMBER_ID} now routes webhooks to ${PUBLIC_WEBHOOK_URL}`);
        res.json({ success: true, webhookUrl: PUBLIC_WEBHOOK_URL, data });
    } catch (e) {
        await db.logError({ type: 'WEBHOOK_OVERRIDE_FAILED', message: e.message, req });
        res.status(500).json({ success: false, error: e.message });
    }
});

// 7. Get All WhatsApp Messages (Live from PostgreSQL)
app.get('/api/whatsapp/messages', async (req, res) => {
    try {
        const messages = await db.getWaMessages();
        const incomingCount = messages.filter(m => m.direction === 'incoming').length;
        const outgoingCount = messages.filter(m => m.direction === 'outgoing').length;
        res.json({
            total: messages.length,
            incomingCount,
            outgoingCount,
            messages
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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
        await db.logError({
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
app.post('/api/whatsapp/messages/clear', async (req, res) => {
    try {
        await db.clearWaMessages();
        res.json({
            success: true,
            message: 'All WhatsApp message logs have been cleared in PostgreSQL!'
        });
    } catch (e) {
        await db.logError({
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
app.get('/api/config', async (req, res) => {
    const autoConfig = await db.getAutoConfig();
    res.json({
        publicKey: vapidKeys.publicKey,
        whatsappNumber: WHATSAPP_DISPLAY_PHONE_NUMBER,
        waWelcomeLink: getWhatsAppDeepLink(autoConfig.whatsapp?.defaultWelcomeText)
    });
});

// 2. Subscribe a new device with Auto WhatsApp Welcome Push
app.post('/api/subscribe', async (req, res) => {
    const { subscription, deviceName, platform, userAgent, phone, countryCode } = req.body;
    const normalizedPhone = phone ? normalizePhone(phone, countryCode) : null;
    if (phone && !normalizedPhone) {
        return res.status(400).json({ error: 'Invalid WhatsApp number. Please include country code, e.g. +923001234567' });
    }

    if (!subscription || !subscription.endpoint || !subscription.keys) {
        await db.logError({
            type: 'INVALID_SUBSCRIPTION_PAYLOAD',
            message: 'Invalid subscription object received: missing endpoint or keys',
            details: req.body,
            req
        });
        return res.status(400).json({ error: 'Invalid subscription object' });
    }

    try {
        const sub = await db.addSubscriber({
            name: deviceName,
            platform,
            userAgent,
            endpoint: subscription.endpoint,
            keys: subscription.keys,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            phone: normalizedPhone,
            countryCode: countryCode || DEFAULT_COUNTRY_CODE
        });

        console.log(`[SUBSCRIPTION SUCCESS - POSTGRESQL] Device registered: ${sub.name} (${sub.platform}), phone: +${sub.phone || 'none'}`);

        // --- AUTO PUSH: Send Welcome Notification that leads directly into WhatsApp ---
        const autoConfig = await db.getAutoConfig();
        if (autoConfig.welcome && autoConfig.welcome.enabled) {
            const delayMs = (autoConfig.welcome.delaySeconds || 2) * 1000;
            setTimeout(async () => {
                try {
                    const welcomeUrl = `/api/redirect-wa?type=welcome&subId=${sub.id}`;
                    const payload = JSON.stringify({
                        title: autoConfig.welcome.title || '💬 Complete Your WhatsApp Activation!',
                        body: autoConfig.welcome.body || 'Tap here to send a quick WhatsApp message and unlock your 24h VIP alerts!',
                        icon: '/icon-192.png',
                        data: {
                            url: welcomeUrl,
                            subscriberId: sub.id,
                            isWhatsAppWelcome: true
                        }
                    });

                    await webpush.sendNotification({
                        endpoint: sub.endpoint,
                        keys: sub.keys
                    }, payload);

                    console.log(`[AUTO PUSH SUCCESS] WhatsApp welcome push notification sent to ${sub.name}`);
                } catch (err) {
                    await db.logError({
                        type: 'AUTO_WELCOME_PUSH_FAILED',
                        message: `Failed auto welcome push for ${sub.name}: ${err.message}`,
                        details: { stack: err.stack, subscriberId: sub.id }
                    });
                }
            }, delayMs);
        }

        res.status(201).json({
            success: true,
            message: 'Device subscribed successfully! Welcome push leading to WhatsApp scheduled.',
            subscriber: sub,
            waLink: getWhatsAppDeepLink(autoConfig.whatsapp?.defaultWelcomeText)
        });
    } catch (err) {
        await db.logError({
            type: 'SUBSCRIBE_ERROR',
            message: `Subscription failed: ${err.message}`,
            details: { stack: err.stack },
            req
        });
        res.status(500).json({ error: 'Failed to subscribe device', message: err.message });
    }
});

// 3. Unsubscribe / Delete a device
app.post('/api/unsubscribe', async (req, res) => {
    try {
        const { endpoint, id } = req.body;
        if (id) {
            await db.deleteSubscriber(id);
        } else if (endpoint) {
            await db.pool.query('DELETE FROM subscribers WHERE endpoint = $1', [endpoint]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. List all subscribers with 24-Hour Roundtrip Live Status (Live from PostgreSQL)
app.get('/api/subscriptions', async (req, res) => {
    try {
        const subscribers = await db.getSubscribers();
        const sanitized = subscribers.map(sub => ({
            id: sub.id,
            name: sub.name,
            platform: sub.platform,
            phone: sub.phone || null,
            endpointPreview: (sub.endpoint || '').substring(0, 45) + '...',
            subscribedAt: sub.subscribedAt,
            lastActive: sub.lastActive,
            lastWaClickAt: sub.lastWaClickAt || null,
            whatsapp24h: sub.whatsapp24h
        }));
        res.json({
            total: subscribers.length,
            subscribers: sanitized
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. Send Manual Push Notification
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

    const allSubscriptions = await db.getSubscribers();
    if (allSubscriptions.length === 0) {
        await db.logError({
            type: 'NO_SUBSCRIBERS_FOUND',
            message: 'Notification send failed: no subscribers found in PostgreSQL database',
            req
        });
        return res.status(400).json({
            success: false,
            message: 'No subscribers found! Please subscribe a device first.'
        });
    }

    let finalUrl = url;
    if (openWhatsApp) {
        const autoConfig = await db.getAutoConfig();
        const text = whatsappText || autoConfig.whatsapp?.defaultPromoText || 'Hi! I saw your promotion and I want to claim the special offer.';
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
        await db.logError({
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
app.post('/api/schedule-auto', async (req, res) => {
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
app.get('/api/auto-config', async (req, res) => {
    try {
        const cfg = await db.getAutoConfig();
        res.json(cfg);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8. Update Auto Notification Config
app.post('/api/auto-config', async (req, res) => {
    try {
        const current = await db.getAutoConfig();
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

        await db.saveAutoConfig(updated);
        await restartRecurringTimer();
        res.json({
            success: true,
            message: 'Push & WhatsApp settings saved successfully in PostgreSQL!',
            config: updated
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Shortcut route
app.get('/send', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'send.html'));
});

// --- ERROR LOGS API ENDPOINTS ---

// 1. Get All Error Logs (from PostgreSQL)
app.get('/api/error-logs', async (req, res) => {
    try {
        const logs = await db.getErrorLogs();
        res.json({
            total: logs.length,
            logs
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Clear Error Logs (in PostgreSQL)
app.post('/api/error-logs/clear', async (req, res) => {
    try {
        await db.clearErrorLogs();
        res.json({
            success: true,
            message: 'All error logs have been cleared successfully in PostgreSQL!'
        });
    } catch (e) {
        await db.logError({
            type: 'CLEAR_LOGS_FAILED',
            message: e.message,
            details: { stack: e.stack }
        });
        res.status(500).json({ success: false, error: e.message });
    }
});

// Global Express Error Middleware
app.use(async (err, req, res, next) => {
    await db.logError({
        type: 'EXPRESS_UNHANDLED_ERROR',
        message: err.message,
        details: { stack: err.stack },
        req
    });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Process Uncaught Exceptions & Rejections
process.on('uncaughtException', async (err) => {
    await db.logError({
        type: 'UNCAUGHT_EXCEPTION',
        message: err.message,
        details: { stack: err.stack }
    });
});

process.on('unhandledRejection', async (reason) => {
    await db.logError({
        type: 'UNHANDLED_REJECTION',
        message: reason?.message || String(reason),
        details: reason?.stack ? { stack: reason.stack } : { reason }
    });
});

// Initialize PostgreSQL and Start Server
async function startServer() {
    try {
        await db.initDb({ baseDir: __dirname });
        await restartRecurringTimer();
        await syncWhatsAppBusinessProfile();

        app.listen(PORT, '0.0.0.0', () => {
            const localIp = getLocalIp();
            console.log(`\n======================================================`);
            console.log(`🚀 Push Notification + WhatsApp 24h Server ACTIVE on Port ${PORT}!`);
            console.log(`🐘 Database: PostgreSQL (Connected & Synchronized)`);
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
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}

startServer();
