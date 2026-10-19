const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:JrXyVlGflwVEtTKD0TlIH2AvOWDyR5wsDkV5B2UtT46PlgGwvhpKhBcVBd7GzO55@72.60.40.218:5434/postgres';

const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => {
    console.error('❌ [PostgreSQL Pool Error]:', err.message);
});

const WINDOW_MS = 24 * 60 * 60 * 1000;

// --- Helper: Normalize Phone ---
function normalizePhone(raw, defaultCountryCode = '92') {
    if (raw === null || raw === undefined) return null;
    const str = String(raw).trim();
    if (!str) return null;
    const hasPlus = str.startsWith('+');
    const cc = String(defaultCountryCode || '92').replace(/[^0-9]/g, '');
    let digits = str.replace(/[^0-9]/g, '');
    if (!digits) return null;

    if (digits.startsWith('00')) {
        digits = digits.slice(2);
    } else if (digits.startsWith('0')) {
        digits = cc + digits.replace(/^0+/, '');
    } else if (!hasPlus && digits.length <= 10 && cc && !digits.startsWith(cc)) {
        digits = cc + digits;
    }

    if (digits.length < 8 || digits.length > 15) return null;
    return digits;
}

// Compute 24h status object from timestamps
function compute24hStatus(windowRow, latestMsgTime, lastInboundTime) {
    let latestOpenedAt = null;
    let closedAt = null;
    let lastMessage = null;

    if (windowRow) {
        if (windowRow.opened_at) latestOpenedAt = new Date(windowRow.opened_at).getTime();
        if (windowRow.closed_at) closedAt = new Date(windowRow.closed_at).getTime();
        lastMessage = windowRow.last_message || null;
    }

    if (lastInboundTime && (!latestOpenedAt || lastInboundTime > latestOpenedAt)) {
        latestOpenedAt = lastInboundTime;
    }

    if (latestMsgTime && (!latestOpenedAt || latestMsgTime > latestOpenedAt)) {
        latestOpenedAt = latestMsgTime;
    }

    let expiresAt = latestOpenedAt ? latestOpenedAt + WINDOW_MS : null;
    if (closedAt && latestOpenedAt && closedAt > latestOpenedAt && closedAt < expiresAt) {
        expiresAt = closedAt;
    }

    const remainingMs = expiresAt ? Math.max(0, expiresAt - Date.now()) : 0;
    const isActive = remainingMs > 0;

    let remainingFormatted = 'Expired';
    if (isActive) {
        const hours = Math.floor(remainingMs / (1000 * 60 * 60));
        const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        remainingFormatted = `${hours}h ${minutes}m left`;
    }

    return {
        isActive,
        statusText: isActive ? 'Active' : (latestOpenedAt ? 'Expired' : 'Expired / Not Started'),
        remainingMs,
        remainingFormatted,
        openedAt: latestOpenedAt ? new Date(latestOpenedAt).toISOString() : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        closedAt: closedAt ? new Date(closedAt).toISOString() : null,
        lastInboundAt: lastInboundTime ? new Date(lastInboundTime).toISOString() : (windowRow && windowRow.last_inbound_at ? new Date(windowRow.last_inbound_at).toISOString() : null),
        lastMessage
    };
}

// --- Initialize DB & Migrate Data ---
async function initDb(options = {}) {
    const { baseDir = __dirname } = options;
    console.log('🔄 [PostgreSQL] Initializing tables and schema...');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS subscribers (
            id VARCHAR(100) PRIMARY KEY,
            name VARCHAR(150),
            platform VARCHAR(50),
            user_agent TEXT,
            endpoint TEXT UNIQUE NOT NULL,
            keys JSONB NOT NULL,
            ip VARCHAR(100),
            phone VARCHAR(30),
            country_code VARCHAR(10),
            subscribed_at TIMESTAMPTZ DEFAULT NOW(),
            last_active TIMESTAMPTZ DEFAULT NOW(),
            last_wa_click_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS whatsapp_windows (
            phone VARCHAR(30) PRIMARY KEY,
            is_active BOOLEAN DEFAULT FALSE,
            opened_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,
            last_inbound_at TIMESTAMPTZ,
            last_message TEXT,
            last_sender_name VARCHAR(150),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS whatsapp_messages (
            id VARCHAR(100) PRIMARY KEY,
            direction VARCHAR(20) NOT NULL,
            from_phone VARCHAR(30),
            to_phone VARCHAR(30),
            sender_name VARCHAR(150),
            text TEXT,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status VARCHAR(30) DEFAULT 'received',
            raw_id VARCHAR(200),
            error JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS error_logs (
            id VARCHAR(100) PRIMARY KEY,
            type VARCHAR(100),
            message TEXT,
            details JSONB,
            request JSONB,
            timestamp TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS app_config (
            key VARCHAR(50) PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS webhook_events (
            id BIGSERIAL PRIMARY KEY,
            received_at TIMESTAMPTZ DEFAULT NOW(),
            body JSONB
        );

        CREATE INDEX IF NOT EXISTS idx_subscribers_phone ON subscribers(phone);
        CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(from_phone, to_phone);
        CREATE INDEX IF NOT EXISTS idx_wa_messages_timestamp ON whatsapp_messages(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs(timestamp DESC);
    `);

    console.log('✅ [PostgreSQL] Schema ready.');

    // --- Migrate JSON Data if DB is Fresh ---
    try {
        const subCountRes = await pool.query('SELECT COUNT(*) as count FROM subscribers');
        const count = parseInt(subCountRes.rows[0].count, 10);

        if (count === 0) {
            const subsFile = path.join(baseDir, 'subscriptions.json');
            if (fs.existsSync(subsFile)) {
                console.log('📥 [PostgreSQL] Migrating existing subscribers from subscriptions.json...');
                const subs = JSON.parse(fs.readFileSync(subsFile, 'utf8') || '[]');
                for (const s of subs) {
                    const cleanPhone = normalizePhone(s.phone);
                    await pool.query(`
                        INSERT INTO subscribers (id, name, platform, user_agent, endpoint, keys, ip, phone, country_code, subscribed_at, last_active, last_wa_click_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                        ON CONFLICT (endpoint) DO NOTHING;
                    `, [
                        s.id || `sub_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                        s.name || 'Unknown Device',
                        s.platform || 'desktop',
                        s.userAgent || '',
                        s.endpoint,
                        JSON.stringify(s.keys || {}),
                        s.ip || '127.0.0.1',
                        cleanPhone,
                        s.countryCode || '92',
                        s.subscribedAt ? new Date(s.subscribedAt) : new Date(),
                        s.lastActive ? new Date(s.lastActive) : new Date(),
                        s.lastWaClickAt ? new Date(s.lastWaClickAt) : null
                    ]);

                    if (cleanPhone && s.whatsapp24h && s.whatsapp24h.openedAt) {
                        await pool.query(`
                            INSERT INTO whatsapp_windows (phone, is_active, opened_at, expires_at, closed_at, last_inbound_at, last_message, updated_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                            ON CONFLICT (phone) DO UPDATE SET
                                is_active = EXCLUDED.is_active,
                                opened_at = EXCLUDED.opened_at,
                                expires_at = EXCLUDED.expires_at,
                                closed_at = EXCLUDED.closed_at,
                                last_inbound_at = EXCLUDED.last_inbound_at,
                                last_message = EXCLUDED.last_message,
                                updated_at = NOW();
                        `, [
                            cleanPhone,
                            !!s.whatsapp24h.isActive,
                            new Date(s.whatsapp24h.openedAt),
                            s.whatsapp24h.expiresAt ? new Date(s.whatsapp24h.expiresAt) : new Date(new Date(s.whatsapp24h.openedAt).getTime() + WINDOW_MS),
                            s.whatsapp24h.closedAt ? new Date(s.whatsapp24h.closedAt) : null,
                            s.whatsapp24h.openedAt ? new Date(s.whatsapp24h.openedAt) : null,
                            s.whatsapp24h.lastMessage || null
                        ]);
                    }
                }
                console.log(`✅ [PostgreSQL] Migrated ${subs.length} subscribers.`);
            }
        }

        const msgCountRes = await pool.query('SELECT COUNT(*) as count FROM whatsapp_messages');
        if (parseInt(msgCountRes.rows[0].count, 10) === 0) {
            const msgsFile = path.join(baseDir, 'whatsapp-messages.json');
            if (fs.existsSync(msgsFile)) {
                console.log('📥 [PostgreSQL] Migrating existing messages from whatsapp-messages.json...');
                const msgs = JSON.parse(fs.readFileSync(msgsFile, 'utf8') || '[]');
                for (const m of msgs) {
                    await pool.query(`
                        INSERT INTO whatsapp_messages (id, direction, from_phone, to_phone, sender_name, text, timestamp, status, raw_id, error)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        ON CONFLICT (id) DO NOTHING;
                    `, [
                        m.id || `wamsg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                        m.direction || 'incoming',
                        m.from ? String(m.from).replace(/[^0-9]/g, '') : null,
                        m.to ? String(m.to).replace(/[^0-9]/g, '') : null,
                        m.senderName || 'Unknown Customer',
                        m.text || '',
                        m.timestamp ? new Date(m.timestamp) : new Date(),
                        m.status || 'received',
                        m.rawId || null,
                        m.error ? JSON.stringify(m.error) : null
                    ]);
                }
                console.log(`✅ [PostgreSQL] Migrated ${msgs.length} messages.`);
            }
        }

        const confRes = await pool.query("SELECT value FROM app_config WHERE key = 'auto_config'");
        if (confRes.rows.length === 0) {
            const autoConfigFile = path.join(baseDir, 'auto-config.json');
            let configData = null;
            if (fs.existsSync(autoConfigFile)) {
                try { configData = JSON.parse(fs.readFileSync(autoConfigFile, 'utf8')); } catch (e) {}
            }
            if (configData) {
                await pool.query(`
                    INSERT INTO app_config (key, value, updated_at)
                    VALUES ('auto_config', $1, NOW())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
                `, [JSON.stringify(configData)]);
                console.log('✅ [PostgreSQL] Migrated auto-config.json');
            }
        }

    } catch (migErr) {
        console.error('⚠️ [PostgreSQL Migration Notice]:', migErr.message);
    }
}

// --- Subscribers ---

async function getSubscribers() {
    // Left join with whatsapp_windows so every device gets the exact same phone-level 24h status
    const query = `
        SELECT 
            s.id,
            s.name,
            s.platform,
            s.user_agent as "userAgent",
            s.endpoint,
            s.keys,
            s.ip,
            s.phone,
            s.country_code as "countryCode",
            s.subscribed_at as "subscribedAt",
            s.last_active as "lastActive",
            s.last_wa_click_at as "lastWaClickAt",
            w.is_active as "w_is_active",
            w.opened_at as "w_opened_at",
            w.expires_at as "w_expires_at",
            w.closed_at as "w_closed_at",
            w.last_inbound_at as "w_last_inbound_at",
            w.last_message as "w_last_message",
            w.last_sender_name as "w_last_sender_name"
        FROM subscribers s
        LEFT JOIN whatsapp_windows w ON s.phone = w.phone
        ORDER BY s.subscribed_at DESC;
    `;
    const res = await pool.query(query);

    return res.rows.map(row => {
        const windowRow = row.phone ? {
            is_active: row.w_is_active,
            opened_at: row.w_opened_at,
            expires_at: row.w_expires_at,
            closed_at: row.w_closed_at,
            last_inbound_at: row.w_last_inbound_at,
            last_message: row.w_last_message,
            last_sender_name: row.w_last_sender_name
        } : null;

        const whatsapp24h = compute24hStatus(windowRow);

        return {
            id: row.id,
            name: row.name,
            platform: row.platform,
            userAgent: row.userAgent,
            endpoint: row.endpoint,
            keys: row.keys,
            ip: row.ip,
            phone: row.phone,
            countryCode: row.countryCode,
            subscribedAt: row.subscribedAt ? new Date(row.subscribedAt).toISOString() : null,
            lastActive: row.lastActive ? new Date(row.lastActive).toISOString() : null,
            lastWaClickAt: row.lastWaClickAt ? new Date(row.lastWaClickAt).toISOString() : null,
            whatsapp24h
        };
    });
}

async function getSubscriberById(id) {
    const subs = await getSubscribers();
    return subs.find(s => s.id === id) || null;
}

async function addSubscriber({
    id,
    name,
    platform,
    userAgent,
    endpoint,
    keys,
    ip,
    phone,
    countryCode = '92'
}) {
    const cleanPhone = normalizePhone(phone, countryCode);
    const subId = id || `sub_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const res = await pool.query(`
        INSERT INTO subscribers (id, name, platform, user_agent, endpoint, keys, ip, phone, country_code, subscribed_at, last_active, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
        ON CONFLICT (endpoint) DO UPDATE SET
            name = EXCLUDED.name,
            platform = EXCLUDED.platform,
            user_agent = EXCLUDED.user_agent,
            keys = EXCLUDED.keys,
            ip = EXCLUDED.ip,
            phone = COALESCE(EXCLUDED.phone, subscribers.phone),
            country_code = COALESCE(EXCLUDED.country_code, subscribers.country_code),
            last_active = NOW(),
            updated_at = NOW()
        RETURNING *;
    `, [
        subId,
        name || 'Unknown Device',
        platform || 'desktop',
        userAgent || '',
        endpoint,
        JSON.stringify(keys || {}),
        ip || '127.0.0.1',
        cleanPhone,
        countryCode
    ]);

    return getSubscriberById(res.rows[0].id);
}

async function updateSubscriberPhone(id, phone, countryCode = '92') {
    const cleanPhone = normalizePhone(phone, countryCode);
    await pool.query(`
        UPDATE subscribers 
        SET phone = $1, country_code = $2, updated_at = NOW()
        WHERE id = $3;
    `, [cleanPhone, countryCode, id]);
    return getSubscriberById(id);
}

async function updateSubscriberLastActive(endpoint) {
    await pool.query(`
        UPDATE subscribers 
        SET last_active = NOW(), updated_at = NOW()
        WHERE endpoint = $1;
    `, [endpoint]);
}

async function updateSubscriberWaClick(id) {
    await pool.query(`
        UPDATE subscribers 
        SET last_wa_click_at = NOW(), updated_at = NOW()
        WHERE id = $1;
    `, [id]);
}

async function deleteSubscriber(id) {
    const res = await pool.query('DELETE FROM subscribers WHERE id = $1 RETURNING id;', [id]);
    return res.rowCount > 0;
}

// --- WhatsApp 24h Window Tracking ---

async function getWindowForPhone(phone) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
        return compute24hStatus(null, null, null);
    }

    const windowRes = await pool.query('SELECT * FROM whatsapp_windows WHERE phone = $1', [cleanPhone]);
    const windowRow = windowRes.rows[0] || null;

    // Also check latest inbound customer message
    const inboundRes = await pool.query(`
        SELECT timestamp, text, sender_name 
        FROM whatsapp_messages 
        WHERE direction = 'incoming' AND from_phone = $1 
        ORDER BY timestamp DESC LIMIT 1;
    `, [cleanPhone]);
    const lastInbound = inboundRes.rows[0] || null;
    const lastInboundTime = lastInbound ? new Date(lastInbound.timestamp).getTime() : null;

    // Check latest successful outbound message
    const outboundRes = await pool.query(`
        SELECT timestamp, text 
        FROM whatsapp_messages 
        WHERE direction = 'outgoing' AND status = 'sent' AND to_phone = $1 
        ORDER BY timestamp DESC LIMIT 1;
    `, [cleanPhone]);
    const lastOutbound = outboundRes.rows[0] || null;
    const lastOutboundTime = lastOutbound ? new Date(lastOutbound.timestamp).getTime() : null;

    return compute24hStatus(windowRow, lastOutboundTime, lastInboundTime);
}

async function openWindowForPhone(phone, openedAtMs = Date.now(), lastMessage = null, senderName = null) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return null;

    const openedAt = new Date(openedAtMs);
    const expiresAt = new Date(openedAtMs + WINDOW_MS);

    await pool.query(`
        INSERT INTO whatsapp_windows (phone, is_active, opened_at, expires_at, closed_at, last_inbound_at, last_message, last_sender_name, updated_at)
        VALUES ($1, TRUE, $2, $3, NULL, $2, $4, $5, NOW())
        ON CONFLICT (phone) DO UPDATE SET
            is_active = TRUE,
            opened_at = EXCLUDED.opened_at,
            expires_at = EXCLUDED.expires_at,
            closed_at = NULL,
            last_inbound_at = EXCLUDED.last_inbound_at,
            last_message = COALESCE(EXCLUDED.last_message, whatsapp_windows.last_message),
            last_sender_name = COALESCE(EXCLUDED.last_sender_name, whatsapp_windows.last_sender_name),
            updated_at = NOW();
    `, [cleanPhone, openedAt, expiresAt, lastMessage, senderName]);

    return getWindowForPhone(cleanPhone);
}

async function closeWindowForPhone(phone) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return null;

    await pool.query(`
        UPDATE whatsapp_windows 
        SET is_active = FALSE, closed_at = NOW(), updated_at = NOW()
        WHERE phone = $1;
    `, [cleanPhone]);

    return getWindowForPhone(cleanPhone);
}

// --- WhatsApp Messages ---

async function logWaMessage({
    direction = 'incoming',
    from = null,
    to = null,
    senderName = 'Unknown Customer',
    text = '',
    timestamp = new Date(),
    status = 'received',
    rawId = null,
    error = null
}) {
    const id = 'wamsg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const cleanFrom = from ? String(from).replace(/[^0-9]/g, '') : null;
    const cleanTo = to ? String(to).replace(/[^0-9]/g, '') : null;
    const msgDate = timestamp instanceof Date ? timestamp : new Date(timestamp);

    const res = await pool.query(`
        INSERT INTO whatsapp_messages (id, direction, from_phone, to_phone, sender_name, text, timestamp, status, raw_id, error, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        RETURNING *;
    `, [
        id,
        direction,
        cleanFrom,
        cleanTo,
        senderName || (direction === 'outgoing' ? 'You (Agentifire)' : 'Unknown Customer'),
        text || '',
        msgDate,
        status,
        rawId,
        error ? JSON.stringify(error) : null
    ]);

    // Runtime Trigger: Inbound customer message automatically activates 24h window
    if (direction === 'incoming' && cleanFrom) {
        await openWindowForPhone(cleanFrom, msgDate.getTime(), text, senderName);
    }
    // Runtime Trigger: Successful outbound delivery proves 24h window was open
    if (direction === 'outgoing' && status === 'sent' && cleanTo) {
        await openWindowForPhone(cleanTo, msgDate.getTime(), text, 'You (Agentifire)');
    }

    const row = res.rows[0];
    return {
        id: row.id,
        direction: row.direction,
        from: row.from_phone,
        to: row.to_phone,
        senderName: row.sender_name,
        text: row.text,
        timestamp: new Date(row.timestamp).toISOString(),
        status: row.status,
        rawId: row.raw_id,
        error: row.error
    };
}

async function updateWaMessageStatus(rawId, status, error = null) {
    if (!rawId) return;
    await pool.query(`
        UPDATE whatsapp_messages 
        SET status = $1, error = $2
        WHERE raw_id = $3;
    `, [status, error ? JSON.stringify(error) : null, rawId]);
}

async function getWaMessages(limit = 200) {
    const res = await pool.query(`
        SELECT id, direction, from_phone as "from", to_phone as "to", sender_name as "senderName", text, timestamp, status, raw_id as "rawId", error
        FROM whatsapp_messages
        ORDER BY timestamp DESC
        LIMIT $1;
    `, [limit]);

    return res.rows.map(r => ({
        ...r,
        timestamp: new Date(r.timestamp).toISOString()
    }));
}

async function clearWaMessages() {
    await pool.query('TRUNCATE TABLE whatsapp_messages;');
    return true;
}

// --- Error Logs ---

async function logError({ type = 'GENERAL_ERROR', message, details = null, req = null }) {
    const id = 'err_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const msg = typeof message === 'string' ? message : (message?.message || JSON.stringify(message));
    const dt = details ? (typeof details === 'object' ? details : { raw: details }) : (message?.stack ? { stack: message.stack } : null);
    const reqInfo = req ? {
        method: req.method,
        url: req.originalUrl || req.url,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent']
    } : null;

    console.error(`❌ [ERROR LOGGED - ${type}]`, msg);

    try {
        await pool.query(`
            INSERT INTO error_logs (id, type, message, details, request, timestamp)
            VALUES ($1, $2, $3, $4, $5, NOW());
        `, [
            id,
            type,
            msg,
            dt ? JSON.stringify(dt) : null,
            reqInfo ? JSON.stringify(reqInfo) : null
        ]);
    } catch (e) {
        console.error('Failed to insert error log into PostgreSQL:', e.message);
    }

    return { id, timestamp: new Date().toISOString(), type, message: msg, details: dt, request: reqInfo };
}

async function getErrorLogs(limit = 200) {
    const res = await pool.query(`
        SELECT id, type, message, details, request, timestamp
        FROM error_logs
        ORDER BY timestamp DESC
        LIMIT $1;
    `, [limit]);

    return res.rows.map(r => ({
        ...r,
        timestamp: new Date(r.timestamp).toISOString()
    }));
}

async function clearErrorLogs() {
    await pool.query('TRUNCATE TABLE error_logs;');
    return true;
}

// --- App Config / Auto Push ---

const DEFAULT_AUTO_CONFIG = {
    enabled: false,
    frequencyHours: 24,
    lastRun: null,
    alertTitle: '🚀 Exclusive Agentifire Update',
    alertBody: 'Tap here to see what is new today on your Agentifire dashboard!',
    alertUrl: 'https://pushnotification.72.60.40.218.sslip.io/',
    welcomePushEnabled: true,
    welcomePushTitle: '🎉 Welcome to Agentifire Alerts!',
    welcomePushBody: 'You are subscribed to real-time instant alerts on this device.',
    welcomePushUrl: 'https://pushnotification.72.60.40.218.sslip.io/',
    welcomeWhatsAppEnabled: true,
    welcomeWhatsAppTemplate: 'Hi {name}! Thanks for subscribing to Agentifire Alerts. Reply "YES" anytime to maintain your 24h instant alert channel!'
};

async function getAutoConfig() {
    try {
        const res = await pool.query("SELECT value FROM app_config WHERE key = 'auto_config';");
        if (res.rows.length > 0 && res.rows[0].value) {
            return { ...DEFAULT_AUTO_CONFIG, ...res.rows[0].value };
        }
    } catch (e) {}
    return { ...DEFAULT_AUTO_CONFIG };
}

async function saveAutoConfig(config) {
    const merged = { ...DEFAULT_AUTO_CONFIG, ...(config || {}) };
    await pool.query(`
        INSERT INTO app_config (key, value, updated_at)
        VALUES ('auto_config', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    `, [JSON.stringify(merged)]);
    return merged;
}

// --- Webhook Events Logging ---

let lastWebhookAt = null;

async function logWebhookEvent(body) {
    lastWebhookAt = new Date().toISOString();
    try {
        await pool.query(`
            INSERT INTO webhook_events (received_at, body)
            VALUES (NOW(), $1);
        `, [JSON.stringify(body)]);

        // Keep last 100 events
        await pool.query(`
            DELETE FROM webhook_events 
            WHERE id NOT IN (
                SELECT id FROM webhook_events ORDER BY id DESC LIMIT 100
            );
        `);
    } catch (e) {
        console.error('Failed to log webhook event to PostgreSQL:', e.message);
    }
}

async function getLastWebhookAt() {
    if (lastWebhookAt) return lastWebhookAt;
    try {
        const res = await pool.query('SELECT received_at FROM webhook_events ORDER BY id DESC LIMIT 1;');
        if (res.rows.length > 0) {
            lastWebhookAt = new Date(res.rows[0].received_at).toISOString();
        }
    } catch (e) {}
    return lastWebhookAt;
}

module.exports = {
    pool,
    initDb,
    normalizePhone,
    compute24hStatus,
    getSubscribers,
    getSubscriberById,
    addSubscriber,
    updateSubscriberPhone,
    updateSubscriberLastActive,
    updateSubscriberWaClick,
    deleteSubscriber,
    getWindowForPhone,
    openWindowForPhone,
    closeWindowForPhone,
    logWaMessage,
    updateWaMessageStatus,
    getWaMessages,
    clearWaMessages,
    logError,
    getErrorLogs,
    clearErrorLogs,
    getAutoConfig,
    saveAutoConfig,
    logWebhookEvent,
    getLastWebhookAt
};
