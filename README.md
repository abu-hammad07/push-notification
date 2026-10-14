# 🔔 Web Push Notification System (Android & iOS)

A complete, modern Web Push Notification system built with **Node.js, Express, and standard W3C Web Push**.

---

## 📁 File Structure

| File / Folder | Purpose |
|---|---|
| [`server.js`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/server.js) | Node.js Express server handling VAPID keys, subscriptions, and push sending |
| [`auto-config.json`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/auto-config.json) | Automatic push configuration (Welcome alert toggle, delays, recurring intervals) |
| [`subscriptions.json`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/subscriptions.json) | Stores registered subscribers (Device name, platform, endpoint, keys, dates) |
| [`vapid-keys.json`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/vapid-keys.json) | Auto-generated VAPID public & private keys for Web Push security |
| [`public/index.html`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/public/index.html) | **Client Subscription Page** — Auto-detects Android/iOS, handles permission & 1-click subscription |
| [`public/send.html`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/public/send.html) | **Send Dashboard** — Send alerts to All, iOS only, Android only, or specific subscriber with Live Phone Mockup preview |
| [`public/sw.js`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/public/sw.js) | Service Worker that displays notifications and handles click-to-open actions |
| [`public/manifest.json`](file:///d:/laragon/www/elevenlabs/agentifire/vapi-agetifire/push-notification/public/manifest.json) | Web App Manifest required for iOS PWA and Android install banners |

---

## 🚀 How to Run

1. Open your terminal in this directory:
   ```bash
   cd d:\laragon\www\elevenlabs\agentifire\vapi-agetifire\push-notification
   node server.js
   ```

2. Open in your browser:
   - **Subscribe Page:** [http://localhost:4000](http://localhost:4000)
   - **Sender Dashboard:** [http://localhost:4000/send.html](http://localhost:4000/send.html)

---

## 📱 Testing on Real Android & iPhone

### 🤖 Android:
- Open `http://<your-pc-ip>:4000` (e.g. `http://192.168.1.x:4000`) or via HTTPS tunnel.
- Tap **Enable Notifications** -> Allow -> Done!

### 🍎 iOS (iPhone / iPad with iOS 16.4+):
Apple requires Web Push notifications to run via **HTTPS** and to be **Added to Home Screen**:
1. Run a free HTTPS tunnel on your PC:
   ```bash
   npx localtunnel --port 4000
   # OR:
   ngrok http 4000
   ```
2. Open the generated HTTPS URL on your iPhone Safari.
3. Tap the Safari **Share button** (bottom bar) -> **"Add to Home Screen"** (`+`).
4. Open the installed app from your iPhone Home Screen.
5. Tap **Enable Notifications** -> Allow -> Done!

---

## 📤 Sending Notifications

Go to [http://localhost:4000/send.html](http://localhost:4000/send.html):
1. Choose Audience: **All Devices**, **iOS Only**, **Android Only**, or **Specific Subscriber**.
2. Type Title & Message (see live preview update in real-time!).
3. Click **"Send Push Notification Now"**.
4. Dead / uninstalled device tokens are automatically cleaned up from `subscriptions.json`.
