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

// Compute 24h status object from timestamps (Strictly customer inbound driven).
// lastOutbound = { time (ms), status } of the latest free-form message we sent to this number.
// It NEVER opens/extends a window by itself; it is only used as PROOF reported by Meta:
//   - delivered/read free-form message => customer window was open (Meta rejects free-form otherwise)
//   - merely 'sent' => accepted by Meta but not yet confirmed (shown as a separate 'unconfirmed' state)
function compute24hStatus(windowRow, lastInboundTime, lastOutbound = null) {
    let latestOpenedAt = null;
    let closedAt = null;
    let lastMessage = null;

    if (windowRow) {
        // Only consider opened_at if it was legitimately initiated by a customer inbound message (never outbound or manual activation)
        const isValidInbound = windowRow.opened_at &&
            windowRow.last_sender_name !== 'You (Agentifire)' &&
            windowRow.last_message !== 'Manual runtime activation' &&
            !(windowRow.last_message && windowRow.last_message.startsWith('[Audio Voice Note'));

        if (isValidInbound) {
            latestOpenedAt = new Date(windowRow.opened_at).getTime();
            lastMessage = windowRow.last_message || null;
        }
        if (windowRow.closed_at) closedAt = new Date(windowRow.closed_at).getTime();
    }

    // Inbound customer message is the authoritative trigger for 24h window
    if (lastInboundTime && (!latestOpenedAt || lastInboundTime > latestOpenedAt)) {
        latestOpenedAt = lastInboundTime;
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

    const isValidWindowForLastInbound = windowRow &&
        windowRow.last_inbound_at &&
        windowRow.last_sender_name !== 'You (Agentifire)' &&
        windowRow.last_message !== 'Manual runtime activation' &&
        !(windowRow.last_message && windowRow.last_message.startsWith('[Audio Voice Note'));

    const result = {
        isActive,
        statusText: isActive ? 'Active' : (latestOpenedAt ? 'Expired' : 'Expired / Off'),
        source: isActive ? 'inbound' : null,
        isUnconfirmed: false,
        remainingMs,
        remainingFormatted,
        openedAt: latestOpenedAt ? new Date(latestOpenedAt).toISOString() : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        closedAt: closedAt ? new Date(closedAt).toISOString() : null,
        lastInboundAt: lastInboundTime ? new Date(lastInboundTime).toISOString() : (isValidWindowForLastInbound ? new Date(windowRow.last_inbound_at).toISOString() : null),
        lastOutboundAt: lastOutbound && lastOutbound.time ? new Date(lastOutbound.time).toISOString() : null,
        lastMessage
    };

    // Fallback proof from Meta's own delivery result of our latest free-form message
    if (!isActive && lastOutbound && lastOutbound.time && (Date.now() - lastOutbound.time) < WINDOW_MS) {
        const st = String(lastOutbound.status || '').toLowerCase();
        const proofExpires = lastOutbound.time + WINDOW_MS; // upper bound (exact customer msg time unknown)
        if (st === 'delivered' || st === 'read') {
            result.isActive = true;
            result.statusText = 'Active';
            result.source = 'delivery_confirmed';
            result.remainingMs = Math.max(0, proofExpires - Date.now());
            result.remainingFormatted = 'Confirmed by delivery';
            result.expiresAt = null;
        } else if (st === 'sent' || st === 'accepted') {
            result.statusText = 'Sent OK - awaiting Meta confirmation';
            result.isUnconfirmed = true;
            result.source = 'sent_unconfirmed';
        }
    }

    return result;
}

// Latest free-form message we sent to a phone (any status) used as delivery proof
async function getLatestOutboundForPhone(phone) {
    const r = await pool.query(`
        SELECT timestamp, status FROM whatsapp_messages
        WHERE direction = 'outgoing' AND to_phone = $1
        ORDER BY timestamp DESC LIMIT 1;
    `, [phone]);
    return r.rows[0] ? { time: new Date(r.rows[0].timestamp).getTime(), status: r.rows[0].status } : null;
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

        CREATE TABLE IF NOT EXISTS missed_calls (
            id VARCHAR(100) PRIMARY KEY,
            subscriber_phone VARCHAR(30) NOT NULL,
            caller_name VARCHAR(150),
            caller_phone VARCHAR(30),
            audio_url TEXT,
            duration_seconds INT DEFAULT 0,
            transcript TEXT,
            window_active_at_call BOOLEAN DEFAULT FALSE,
            delivery_status VARCHAR(40) DEFAULT 'delivered_whatsapp',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            delivered_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS pending_voice_notes (
            id VARCHAR(100) PRIMARY KEY,
            subscriber_phone VARCHAR(30) NOT NULL,
            missed_call_id VARCHAR(100),
            caller_name VARCHAR(150),
            caller_phone VARCHAR(30),
            audio_url TEXT NOT NULL,
            duration_seconds INT DEFAULT 0,
            transcript TEXT,
            status VARCHAR(30) DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            delivered_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS invite_tokens (
            token VARCHAR(200) PRIMARY KEY,
            phone VARCHAR(30) NOT NULL,
            name VARCHAR(150),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_verified_at TIMESTAMPTZ,
            is_active BOOLEAN DEFAULT TRUE
        );

        CREATE INDEX IF NOT EXISTS idx_subscribers_phone ON subscribers(phone);
        CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(from_phone, to_phone);
        CREATE INDEX IF NOT EXISTS idx_wa_messages_timestamp ON whatsapp_messages(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_missed_calls_phone ON missed_calls(subscriber_phone, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pending_voice_notes_phone ON pending_voice_notes(subscriber_phone, status);
        CREATE INDEX IF NOT EXISTS idx_invite_tokens_phone ON invite_tokens(phone);
        CREATE INDEX IF NOT EXISTS idx_wa_messages_raw_id ON whatsapp_messages(raw_id);

        ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
        ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
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
    // Left join with whatsapp_windows and latest inbound customer message
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
            w.last_sender_name as "w_last_sender_name",
            inbound.last_inbound_time as "msg_last_inbound_at",
            outb.out_time as "out_time",
            outb.out_status as "out_status"
        FROM subscribers s
        LEFT JOIN whatsapp_windows w ON s.phone = w.phone
        LEFT JOIN (
            SELECT from_phone, MAX(timestamp) as last_inbound_time
            FROM whatsapp_messages
            WHERE direction = 'incoming'
            GROUP BY from_phone
        ) inbound ON s.phone = inbound.from_phone
        LEFT JOIN LATERAL (
            SELECT timestamp as out_time, status as out_status
            FROM whatsapp_messages
            WHERE direction = 'outgoing' AND to_phone = s.phone
            ORDER BY timestamp DESC LIMIT 1
        ) outb ON TRUE
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

        const lastInboundTime = row.msg_last_inbound_at ? new Date(row.msg_last_inbound_at).getTime() : null;
        const lastOutbound = row.out_time ? { time: new Date(row.out_time).getTime(), status: row.out_status } : null;
        const whatsapp24h = compute24hStatus(windowRow, lastInboundTime, lastOutbound);

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
        return compute24hStatus(null, null);
    }

    const windowRes = await pool.query('SELECT * FROM whatsapp_windows WHERE phone = $1', [cleanPhone]);
    const windowRow = windowRes.rows[0] || null;

    // Check latest inbound customer message
    const inboundRes = await pool.query(`
        SELECT timestamp, text, sender_name 
        FROM whatsapp_messages 
        WHERE direction = 'incoming' AND from_phone = $1 
        ORDER BY timestamp DESC LIMIT 1;
    `, [cleanPhone]);
    const lastInbound = inboundRes.rows[0] || null;
    const lastInboundTime = lastInbound ? new Date(lastInbound.timestamp).getTime() : null;

    const lastOutbound = await getLatestOutboundForPhone(cleanPhone);

    return compute24hStatus(windowRow, lastInboundTime, lastOutbound);
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

    // Runtime Trigger: Only INBOUND customer message automatically activates 24h window
    if (direction === 'incoming' && cleanFrom) {
        await openWindowForPhone(cleanFrom, msgDate.getTime(), text, senderName);
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

async function updateWaMessageStatus(rawId, status, error = null, timestamp = null) {
    if (!rawId) return;
    const ts = timestamp ? new Date(Number(timestamp) * 1000) : new Date();

    if (status === 'read') {
        await pool.query(`
            UPDATE whatsapp_messages 
            SET status = 'read',
                read_at = COALESCE(read_at, $1),
                error = $2
            WHERE raw_id = $3;
        `, [ts, error ? JSON.stringify(error) : null, rawId]);
    } else if (status === 'delivered') {
        await pool.query(`
            UPDATE whatsapp_messages 
            SET status = CASE WHEN status = 'read' THEN 'read' ELSE 'delivered' END,
                delivered_at = COALESCE(delivered_at, $1),
                error = $2
            WHERE raw_id = $3;
        `, [ts, error ? JSON.stringify(error) : null, rawId]);
    } else if (status === 'failed') {
        await pool.query(`
            UPDATE whatsapp_messages 
            SET status = 'failed',
                error = $1
            WHERE raw_id = $2;
        `, [error ? JSON.stringify(error) : null, rawId]);
    } else {
        await pool.query(`
            UPDATE whatsapp_messages 
            SET status = CASE WHEN status IN ('read', 'delivered') THEN status ELSE $1 END,
                error = $2
            WHERE raw_id = $3;
        `, [status, error ? JSON.stringify(error) : null, rawId]);
    }
}

async function getWaMessages(limit = 200) {
    const res = await pool.query(`
        SELECT id, direction, from_phone as "from", to_phone as "to", sender_name as "senderName", 
               text, timestamp, status, raw_id as "rawId", error,
               delivered_at as "deliveredAt", read_at as "readAt"
        FROM whatsapp_messages
        ORDER BY timestamp DESC
        LIMIT $1;
    `, [limit]);

    return res.rows.map(r => ({
        ...r,
        timestamp: new Date(r.timestamp).toISOString(),
        deliveredAt: r.deliveredAt ? new Date(r.deliveredAt).toISOString() : null,
        readAt: r.readAt ? new Date(r.readAt).toISOString() : null
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

// --- Missed Calls & Pending Voice Notes ---

async function logMissedCall({
    subscriberPhone,
    callerName = 'Unknown Caller',
    callerPhone = null,
    audioUrl = null,
    durationSeconds = 0,
    transcript = '',
    windowActiveAtCall = false,
    deliveryStatus = 'delivered_whatsapp'
}) {
    const id = 'mc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const cleanSubPhone = normalizePhone(subscriberPhone);
    const cleanCallerPhone = callerPhone ? normalizePhone(callerPhone) : null;
    const deliveredAt = deliveryStatus === 'delivered_whatsapp' ? new Date() : null;

    const res = await pool.query(`
        INSERT INTO missed_calls (id, subscriber_phone, caller_name, caller_phone, audio_url, duration_seconds, transcript, window_active_at_call, delivery_status, created_at, delivered_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
        RETURNING *;
    `, [
        id,
        cleanSubPhone,
        callerName || 'Unknown Caller',
        cleanCallerPhone,
        audioUrl,
        parseInt(durationSeconds) || 0,
        transcript || '',
        !!windowActiveAtCall,
        deliveryStatus,
        deliveredAt
    ]);

    return res.rows[0];
}

async function getMissedCalls(limit = 100) {
    const res = await pool.query(`
        SELECT * FROM missed_calls
        ORDER BY created_at DESC
        LIMIT $1;
    `, [limit]);
    return res.rows.map(r => ({
        ...r,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null
    }));
}

async function queuePendingVoiceNote({
    missedCallId,
    subscriberPhone,
    callerName,
    callerPhone,
    audioUrl,
    durationSeconds = 0,
    transcript = ''
}) {
    const id = 'pvn_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const cleanSubPhone = normalizePhone(subscriberPhone);
    const cleanCallerPhone = callerPhone ? normalizePhone(callerPhone) : null;

    const res = await pool.query(`
        INSERT INTO pending_voice_notes (id, subscriber_phone, missed_call_id, caller_name, caller_phone, audio_url, duration_seconds, transcript, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
        RETURNING *;
    `, [
        id,
        cleanSubPhone,
        missedCallId || null,
        callerName || 'Unknown Caller',
        cleanCallerPhone,
        audioUrl,
        parseInt(durationSeconds) || 0,
        transcript || ''
    ]);

    return res.rows[0];
}

async function getPendingVoiceNotesForPhone(phone) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return [];

    const res = await pool.query(`
        SELECT * FROM pending_voice_notes
        WHERE subscriber_phone = $1 AND status = 'pending'
        ORDER BY created_at ASC;
    `, [cleanPhone]);

    return res.rows;
}

async function markPendingVoiceNoteDelivered(id) {
    await pool.query(`
        UPDATE pending_voice_notes
        SET status = 'delivered', delivered_at = NOW()
        WHERE id = $1;
    `, [id]);

    await pool.query(`
        UPDATE missed_calls
        SET delivery_status = 'delivered_whatsapp', delivered_at = NOW()
        WHERE id = (SELECT missed_call_id FROM pending_voice_notes WHERE id = $1);
    `);
}

async function saveInviteToken(token, phone, name = '') {
    const cleanPhone = normalizePhone(phone);
    await pool.query(`
        INSERT INTO invite_tokens (token, phone, name, created_at, is_active)
        VALUES ($1, $2, $3, NOW(), TRUE)
        ON CONFLICT (token) DO UPDATE SET phone = EXCLUDED.phone, name = EXCLUDED.name, is_active = TRUE;
    `, [token, cleanPhone, name || '']);
}

async function getInviteToken(token) {
    if (!token) return null;
    const res = await pool.query(`
        SELECT * FROM invite_tokens WHERE token = $1 AND is_active = TRUE;
    `, [token]);
    if (res.rows.length === 0) return null;
    await pool.query(`UPDATE invite_tokens SET last_verified_at = NOW() WHERE token = $1;`, [token]);
    return res.rows[0];
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
    getLastWebhookAt,
    logMissedCall,
    getMissedCalls,
    queuePendingVoiceNote,
    getPendingVoiceNotesForPhone,
    markPendingVoiceNoteDelivered,
    saveInviteToken,
    getInviteToken
};


