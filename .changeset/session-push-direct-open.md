---
"@jmfederico/pi-web": patch
---

Open session notification links directly instead of waiting for navigation or focus of a suspended client, which can leave the click pending. Non-session notification behavior is unchanged. This removes that wait; it does not establish the root cause of iOS freezes or guarantee that the browser creates or reuses a window.
