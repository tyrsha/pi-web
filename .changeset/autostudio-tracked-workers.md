---
"@jmfederico/pi-web": patch
---

Create Autostudio workers as tracked subsessions nested under their manager, preserving the parent relationship and completion notifications. Route the configured Autostudio worker, reviewer, and researcher roles through the same visible-session provider for direct subagent workflows, not only slash commands. Existing native jobs continue unchanged; update existing role definitions and reload the extension for new launches. Keep chat progress links clickable under nested deployments. Upgrading from independent workers requires a manual session-daemon restart.
