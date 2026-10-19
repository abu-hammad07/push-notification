# 🔔 Agentifire Web Push & WhatsApp 24h Roundtrip System

A complete, enterprise-grade **Web Push Notification & WhatsApp Cloud API 24h Roundtrip Automation System** built with **Node.js, Express, W3C Web Push, and Meta Cloud API (Graph v23.0)**. Supports Android, iOS 16.4+ (PWA / Safari), and Desktop browsers.

---

## 📑 Table of Contents
1. [Overview & Core Value Proposition](#-overview--core-value-proposition)
2. [End-to-End Visual Tour & Tab Documentation](#-visual-tour--pages--tabs)
   - [1. Client Subscriber Page (`push-alert.png`)](#1-client-subscriber-page-publicindexhtml)
   - [2. Manual Push Notification & Live Mockup (`Manual-Send-tab.png`)](#2-manual-push-sender--live-device-mockup-tab-1)
   - [3. Automated Push Triggers (`Auto-Push-tab.png`)](#3-automated-push-triggers--welcome-alerts-tab-2)
   - [4. WhatsApp 24h Roundtrip & Meta Webhook (`WhatsApp-24h-&-Webhook-tab.png`)](#4-whatsapp-24h-roundtrip--meta-webhook-setup-tab-3)
   - [5. System Error Logs & Diagnostics (`Error-Logs-tab.png`)](#5-system-error-logs--diagnostics-tab-4)
   - [6. WhatsApp Live Messages & Direct Testing (`WhatsApp-Messages&Test-tab.png`)](#6-whatsapp-live-messages--direct-sender-tab-5)
3. [Architecture: How the 24h WhatsApp Roundtrip Works](#-architecture-the-free-24h-roundtrip-loop)
4. [File Structure](#-file-structure)
5. [Installation & Setup](#-installation--setup)
6. [Meta Cloud API & Webhook Configuration](#-meta-cloud-api--webhook-configuration)
7. [API Endpoints Reference](#-api-endpoints-reference)

---

## 🌟 Overview & Core Value Proposition

In Meta WhatsApp Business Cloud API, sending marketing or outreach templates outside a 24-hour window incurs per-message charges. This system bridges **100% Free Web Push Notifications** with **WhatsApp Cloud API** to trigger customer-initiated conversations, keeping the **Free 24-Hour Customer Care Window permanently open at zero cost**.

```
   ┌─────────────────────────────────────────────────────────────┐
   │ 1. User Subscribes to Push on Android / iOS / Desktop        │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ (2-second Auto Welcome Push)
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ 2. Push Notification Delivered with WhatsApp 1-Click Link    │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ (User taps notification)
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ 3. WhatsApp Opens with Pre-filled Message & User Taps Send  │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ (Meta Webhook Inbound Event)
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ 4. 24h Roundtrip Window Opens: Send Unlimited Free Messages!│
   └─────────────────────────────────────────────────────────────┘
```

---

## 📸 Visual Tour: Pages & Tabs

---

### 1. Client Subscriber Page (`public/index.html`)

![Client Subscriber Page](public/images/push-alert.png)

#### 🎯 Purpose & Functionality
This is the client-facing progressive web page where visitors subscribe their devices to push notifications and link their WhatsApp number for 24h VIP alerts.

#### ⚙️ Key Features:
- **Automatic Device & Platform Detection:** Accurately detects whether the visitor is on an **Apple iOS device (iPhone/iPad)**, **Android device**, or **Desktop browser**.
- **iOS Safari PWA Guidance:** Automatically displays step-by-step instructions (*Share ⎋ ➔ Add to Home Screen ➕*) required by Apple for Web Push on iOS 16.4+.
- **Country Code Selector & Phone Normalization:**
  - Interactive country code selector (🇵🇰 `+92`, 🇦🇪 `+971`, 🇸🇦 `+966`, 🇺🇸 `+1`, 🇬🇧 `+44`, etc.).
  - Automatic normalization: converts local numbers like `03131192139` into international format `923131192139`.
  - Real-time preview label showing: *`Will be saved as +923131192139`*.
- **1-Click Native Permission Request:** Requests native browser notification permission. If permission is blocked, displays a helpful guide to reset browser permissions.
- **Post-Subscription Instant Actions:**
  - `🔔 Subscribed!`: Confirmation badge with green status indicator.
  - `💬 Open WhatsApp & Complete 24h Activation`: Direct deep-link button to open the business WhatsApp with pre-filled verification text.
  - `🚀 Send Instant Test Notification`: Triggers an immediate test push to verify delivery.
  - `⏱️ Test Auto Push in 5s`: Simulates lock-screen push testing with a 5-second countdown.
  - `🔕 Unsubscribe this Device`: Removes endpoint tokens cleanly from `subscriptions.json`.

---

### 2. Manual Push Sender & Live Device Mockup (Tab 1)

![Manual Push Sender & Live Mockup](public/images/Manual-Send-tab.png)

#### 🎯 Purpose & Functionality
The command center for broadcasting targeted push notifications to devices with real-time iPhone & Android mockup preview and subscriber management table.

#### ⚙️ Key Features:
- **Notification Composer:**
  - **Title & Body:** Full customization with emoji support.
  - **Target URL (On Click):** URL opened when subscriber clicks the notification.
  - **Custom Icon URL:** Brand logo or custom badge URL.
- **WhatsApp 24h Trigger Toggle:**
  - Checkbox: *💬 Open WhatsApp on Click (Trigger Free 24h Roundtrip)*.
  - Configurable pre-filled customer message (e.g., *"Hi! I saw your promotion and I want to claim the special offer."*).
- **Target Audience Segmentation:**
  - `🌐 All Devices`: Broadcasts to all active endpoints.
  - `⚡ 24h Expired`: Targets only subscribers whose 24h WhatsApp window has expired to prompt re-engagement.
  - `🟢 24h Active`: Broadcasts exclusively to subscribers currently inside their active 24h window.
  - `🍎 iOS Only`: Filters Apple iPhone / iPad subscribers.
  - `🤖 Android Only`: Filters Android smartphones / tablets.
  - `💻 Desktop Only`: Filters desktop Chrome, Edge, Firefox users.
  - `Dropdown Single Device`: Direct send to a specific subscriber ID.
- **Interactive Device Mockups:**
  - Toggle between **🍎 iOS iPhone** and **🤖 Android** mockup cards to inspect title, body, icon, and timestamp preview in real-time.
- **Registered Subscribers & 24h Status Table:**
  - Displays Device Name, Platform badge, Normalized WhatsApp Number, Subscribed Date.
  - **24h Roundtrip Status Pill:** Shows `🟢 Active (23h 45m left)` or `🔴 Expired / Off` with exact timestamp of last customer message.
  - **Actions:** `⚡ Re-open Push` (sends a single re-engagement push), `💬 Test` (opens direct WhatsApp test composer), and `Delete` (unsubscribes device).
  - **Meta Webhook Routing Banner:** Real-time health badge warning if Meta is delivering webhooks elsewhere, with a 1-click *Route to this server* override button.

---

### 3. Automated Push Triggers & Welcome Alerts (Tab 2)

![Automated Push Triggers](public/images/Auto-Push-tab.png)

#### 🎯 Purpose & Functionality
Automates notification workflows so subscribers receive immediate and recurring engagements without manual intervention.

#### ⚙️ Key Features:
- **Auto Welcome WhatsApp Activation Notification:**
  - **Enable/Disable Switch:** Toggles auto welcome alert on new subscription.
  - **Delay Seconds:** Configurable delivery delay (default: 2 seconds) after subscription.
  - **Title & Body:** Customized prompt inviting user to send 1 WhatsApp message to unlock VIP alerts.
- **24h Window Re-engagement Broadcast:**
  - Pre-configured re-activation notification used by the `Re-open Push` button when the 24h session expires.
- **Automated Periodic / Recurring Alerts:**
  - Scheduled background push interval (e.g. every 60 minutes) to keep subscribers informed.
- **Live Hot-Reloading:** Any change saved here updates [auto-config.json](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/auto-config.json) immediately without server restarts.

---

### 4. WhatsApp 24h Roundtrip & Meta Webhook Setup (Tab 3)

![WhatsApp 24h & Webhook Setup](public/images/WhatsApp-24h-&-Webhook-tab.png)

#### 🎯 Purpose & Functionality
Connects the system to Meta Cloud API (WhatsApp Business Graph v23.0) and configures the incoming webhook verification and roundtrip tracking.

#### ⚙️ Key Features:
- **Meta Cloud API Credentials Overview:**
  - Displays active Phone Number ID, WABA ID, Business Account ID, and System Token status.
  - Synchronizes verified Business Display Name (*Doplexer Solution*) and Phone Number (*+1 555-381-5350*) directly from Graph API.
- **Meta Webhook Verification Settings:**
  - Callback URL: `https://<your-domain>/api/whatsapp/webhook`
  - Verification Token: `agentifire_push_webhook_verify_2026`
- **Webhook Routing Health Diagnostic:**
  - Inspects Meta Graph API to verify whether Meta is sending inbound messages to this server or an external application (e.g. Talkloo).
  - Provides a 1-click **Phone-Level Webhook Override** button to instantly bind incoming events to this server.
- **Default Message Templates:**
  - Configures pre-filled welcome text, promotion text, and 24h re-engagement text.

---

### 5. System Error Logs & Diagnostics (Tab 4)

![System Error Logs](public/images/Error-Logs-tab.png)

#### 🎯 Purpose & Functionality
Provides enterprise observability, tracking every push delivery failure, Meta API exception, and webhook mismatch with zero data loss.

#### ⚙️ Key Features:
- **Structured JSON Logging:** All errors are captured in [error-logs.json](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/error-logs.json).
- **Error Categories:**
  - `PUSH_DELIVERY_FAILED`: Captures status codes like `410 Gone` (user revoked permission) or `404 Not Found` and automatically cleans expired tokens.
  - `WA_SEND_FAILED`: Captures Meta Cloud API rejections (e.g. error code `131047` when 24h window is expired, or `131009` invalid parameter).
  - `WEBHOOK_VERIFY_FAILED`: Logs verify token mismatches.
- **Search & Clear:** Filter logs by keyword, inspect stack traces, and clear log history with 1 click.

---

### 6. WhatsApp Live Messages & Direct Sender (Tab 5)

![WhatsApp Messages & Direct Sender](public/images/WhatsApp-Messages&Test-tab.png)

#### 🎯 Purpose & Functionality
An in-dashboard communication hub to test direct WhatsApp Cloud API delivery and view real-time inbound & outbound message history.

#### ⚙️ Key Features:
- **Direct WhatsApp Message Sender:**
  - Input recipient phone number with country code (e.g. `923131192139`).
  - Quick-fill pills from registered subscribers.
  - Message textarea to send real Meta Cloud API text messages immediately.
  - Returns Meta message ID (`wamid.HBgM...`) upon delivery.
- **Live WhatsApp Messages Table:**
  - Direction badges: `📥 Inbound` (received from customer) and `📤 Outbound` (sent to customer).
  - Phone number, Contact Profile Name, Message preview bubble, timestamp, and status (`sent`, `received`, `failed`).
  - **Quick Test / Reply Button:** Clicking any phone number pre-fills the sender for rapid testing.
  - Auto-updates [whatsapp-messages.json](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/whatsapp-messages.json).

---

## 🔄 Architecture: The Free 24h Roundtrip Loop

Meta charges businesses for template messages sent outside the customer service window, but allows **unlimited free custom messages** within 24 hours of any customer-initiated inbound message.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PushAlert 24h Lifecycle                         │
└────────────────────────────────────────────────────────────────────────┘

    [Subscriber Page]  ──> Saves device endpoint + phone (e.g. +923131192139)
            │
            ▼
    [Auto Welcome Push] ──> "Tap here to send 1 quick WhatsApp message"
            │
            ▼
    [Customer Taps]    ──> Opens WhatsApp with pre-filled verification text
            │
            ▼
    [Customer Sends]   ──> Inbound message hits POST /api/whatsapp/webhook
            │
            ▼
    [Server Updates]   ──> sets whatsapp24h.isActive = true
                           sets expiresAt = now + 24 hours
            │
            ▼
    [Free Outreach]    ──> Send direct custom promotions at $0 cost!
            │
            ▼ (After 24h)
    [Window Expires]   ──> Status turns "🔴 Expired / Off"
            │              Meta returns error 131047 if attempted
            ▼
    [Re-open Push]     ──> 1-click Push sent to customer to tap and re-open!
```

---

## 📁 File Structure

```
push-notification/
├── .env                              # Meta Cloud API credentials & App URL
├── auto-config.json                  # Automated push & recurring triggers config
├── error-logs.json                   # Structured system diagnostic error logs
├── package.json                      # Node.js dependencies
├── db.js                             # PostgreSQL database connection, schema & 24h dynamic logic
├── server.js                         # Core Express server, Webhook & Web Push engine
├── vapid-keys.json                   # Generated VAPID Public & Private key pair
└── public/
    ├── icon-192.png                  # App icon (192x192)
    ├── icon-512.png                  # App icon (512x512)
    ├── index.html                    # Client subscriber page (compact, centered)
    ├── manifest.json                 # PWA web manifest for Android / iOS
    ├── send.html                     # Admin broadcast & 24h roundtrip dashboard
    ├── sw.js                         # Service worker for push display & click actions
    └── images/                       # Documentation screenshots
        ├── push-alert.png
        ├── Manual-Send-tab.png
        ├── Auto-Push-tab.png
        ├── WhatsApp-24h-&-Webhook-tab.png
        ├── Error-Logs-tab.png
        └── WhatsApp-Messages&Test-tab.png
```

---

## 🚀 Installation & Setup

### 1. Local Development
```bash
# Clone the repository
git clone https://github.com/abu-hammad07/push-notification.git
cd push-notification

# Install dependencies
npm install

# Start the server
node server.js
```

Open in your browser:
- **Client Subscription Page:** [http://localhost:4000](http://localhost:4000)
- **Admin Dashboard:** [http://localhost:4000/send.html](http://localhost:4000/send.html)

---

### 2. Production Deployment (VPS / HTTPS)

Apple iOS and Android production browsers require Web Push to run over **HTTPS**.

1. Clone on your server and create a `.env` file:
   ```env
   PORT=4000
   DATABASE_URL=postgres://postgres:PASSWORD@72.60.40.218:5434/postgres
   APP_URL=https://pushnotification.yourdomain.com
   DEFAULT_COUNTRY_CODE=92

   # Meta WhatsApp Cloud API Credentials
   PHONE_NUMBER_ID=12345********
   WABA_ID=12345********
   BUSINESS_ACCOUNT_ID=12345********
   SYSTEM_TOKEN=EAA...
   WHATSAPP_VERIFY_TOKEN=12345********
   WHATSAPP_DISPLAY_PHONE_NUMBER=12345********

   # Optional: Forward Meta webhooks to example.com
   WEBHOOK_FORWARD_URLS=https://api.example.com/api/whatsapp/webhook/20
   ```

2. Run with PM2 or systemd:
   ```bash
   pm2 start server.js --name "push-notification"
   pm2 save
   ```

---

## ⚙️ Meta Cloud API & Webhook Configuration

1. In your **Meta for Developers** console:
   - Go to **WhatsApp** ➔ **Configuration**.
   - Set **Callback URL**: `https://<your-domain>/api/whatsapp/webhook`
   - Set **Verify Token**: `agentifire_push_webhook_verify_2026`
   - Subscribe to the **`messages`** webhook field.
2. If your WABA is shared with another platform (like Talkloo), click the **"Route to this server"** button in **Tab 3** of the dashboard to apply a phone-level override so incoming messages hit this server, while setting `WEBHOOK_FORWARD_URLS` in `.env` so other platforms continue receiving forwarded copies.

---

## 📡 API Endpoints Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/config` | Returns public VAPID key and WhatsApp deep-link |
| `POST` | `/api/subscribe` | Registers device subscription with normalized phone number |
| `POST` | `/api/unsubscribe` | Removes a device subscription token |
| `GET` | `/api/subscriptions` | Lists all subscribers with live 24h countdown and phone details |
| `POST` | `/api/send-notification` | Broadcasts push notification to audience segments |
| `POST` | `/api/send-24h-reopen` | Sends targeted push to re-activate expired 24h WhatsApp window |
| `GET` | `/api/whatsapp/webhook` | Meta verification handshake (`hub.challenge`) |
| `POST` | `/api/whatsapp/webhook` | Meta incoming message & status webhook processor |
| `GET` | `/api/whatsapp/window/:phone` | Calculates active 24h window status for any phone number |
| `GET` | `/api/whatsapp/webhook-health` | Diagnostic endpoint checking where Meta routes incoming webhooks |
| `POST` | `/api/whatsapp/webhook-override`| Binds phone number webhooks to this server via Graph API |
| `GET` | `/api/whatsapp/messages` | Returns inbound & outbound message logs |
| `POST` | `/api/whatsapp/send-message` | Sends direct Meta Cloud API WhatsApp text message |
| `POST` | `/api/whatsapp/messages/clear`| Clears WhatsApp message logs |
| `GET` | `/api/auto-config` | Returns auto welcome and recurring triggers configuration |
| `POST` | `/api/auto-config` | Updates auto triggers configuration with live hot-reloading |
| `GET` | `/api/errors` | Returns system error logs |
| `POST` | `/api/errors/clear` | Clears system error logs |

---

## 📄 License
MIT License. Developed for Agentifire Push Notification & WhatsApp Automation.
