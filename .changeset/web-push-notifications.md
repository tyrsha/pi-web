---
"@jmfederico/pi-web": patch
---

PI WEB can now send operating-system push notifications when an assistant message with visible text completes or a session errors, even while the app is closed. Operators opt in with VAPID credentials (`push.vapidPublicKey`, `push.vapidPrivateKey`, and `push.subjectEmail` in the global config, or the `PI_WEB_PUSH_VAPID_*` environment variables); without a complete credential set push stays off and the browser endpoints answer 503. Browsers enable push from Settings → General → Push notifications, and tapping a notification focuses or opens PI WEB and routes into the session that produced it.
