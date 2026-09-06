---
"@jmfederico/pi-web": patch
---

Prevent failed PWA push subscription synchronization from continuously retrying and starving browser input and rendering. Retry on a subsequent synchronization signal and report failures in the browser console.
