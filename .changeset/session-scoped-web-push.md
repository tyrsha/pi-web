---
"@jmfederico/pi-web": patch
---

분리된 PWA·세션 매핑을 사용해 Web Push 알림이 올바른 세션에만 전달하고, agent run이 완료되기 전의 중간 응답은 알리지 않으며, iOS PWA가 실제 foreground가 된 뒤에만 중단된 실시간 연결을 복구하도록 수정합니다.
