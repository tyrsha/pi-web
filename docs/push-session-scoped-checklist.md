# 세션별 Web Push 분리 작업 체크리스트

> PR #194를 최신 `main` 기준으로 리베이스한 뒤, 현재 저장소 버전의 PI WEB 개발 인스턴스에서 Web Push를 검증한 작업 기록입니다.

## 1. 요청사항

- [x] PR #194를 최신 `origin/main` 기준으로 리베이스
- [x] 현재 저장소 버전의 PI WEB 개발 인스턴스 실행
- [x] `pi-web.cindercopper.com` HTTPS 및 Traefik 경로에서 Web Push 확인
- [x] 세션별로 Web Push 수신 대상 분리
- [x] 정상 종료 알림 중복 방지
- [x] Web/API 종료 시 자동 재시작
- [x] 기존 미커밋 Push 변경 보존
- [x] v1 legacy 전체 세션 fallback 제거

## 2. 구현 내용

### 저장소 및 서버

- [x] Push subscription 저장 파일 버전을 v1에서 v2로 변경
- [x] `instanceId`와 `foreground`가 없는 구독을 유효한 레코드로 허용하지 않음
- [x] v1 파일과 세션 매핑이 없는 legacy 구독을 로드하거나 브로드캐스트하지 않음
- [x] 같은 endpoint가 다시 등록되면 PWA instance/session 매핑을 갱신
- [x] Push 전송 시 현재 이벤트의 `sessionId`와 구독의 세션 매핑을 비교
- [x] foreground 상태인 PWA에는 백그라운드 알림을 보내지 않도록 필터링
- [x] 반복된 `agent.end` 이벤트는 실행당 한 번만 종료 알림 전송
- [x] run 안의 중간 assistant `message.end`는 Push로 보내지 않고 마지막 응답만 보류
- [x] 새 메시지로 다음 run이 즉시 시작되면 대기 중인 완료 알림 취소
- [x] `agent.start` 이벤트에서 해당 세션의 종료 알림 상태 초기화

### 클라이언트 및 설정 UI

- [x] 브라우저/PWA storage partition별 안정적인 `instanceId` 생성 및 보관
- [x] Push subscription 등록 payload에 `instanceId`, `sessionId`, `projectId`, `workspaceId`, `foreground` 포함
- [x] 기존 브라우저 subscription을 현재 선택 세션에 매핑하는 `PushSubscriptionBinding` 추가
- [x] 세션 변경 및 foreground/background 전환 시 서버 매핑 동기화
- [x] Push 활성화·비활성화 후 매핑을 즉시 갱신
- [x] Push 비활성 PWA는 복귀 시 service worker/PushManager API를 조회하지 않음
- [x] iOS PWA 복귀 시 selected-session/global WebSocket을 교체하고 HTTP snapshot과 합류
- [x] `pageshow`, `online`, hidden→visible에서 유실된 resume frame을 폐기하고 새 refresh 예약
- [x] hidden 상태의 iOS `pageshow`/`online`은 무시하고 실제 visible 전환 뒤에만 socket·HTTP refresh 실행
- [x] iOS PWA resume의 단계별 content-free 진단 breadcrumb를 서버 journal에 기록
- [x] HTTPS, 브라우저 권한, service worker 조건에 맞는 오류 메시지 제공

### 운영 환경

- [x] 개발용 sessiond, Web/API, client 서비스를 별도 systemd user service로 운영
- [x] 개발 Web/API 서비스에 `Restart=always` 적용
- [x] VAPID 설정을 개발 인스턴스 전용 설정 파일에 저장
- [x] Traefik/Flux GitOps 라우팅 추가 및 배포
- [x] HTTPS endpoint와 Authentik 보호 동작 확인

## 3. 확인 결과

### 자동 검증

- [x] `npm run typecheck`
- [x] 변경 영역 ESLint
- [x] Push 관련 Vitest 및 설정 UI 테스트: **5개 파일, 50개 테스트 통과**
- [x] `git diff --check`

검증한 주요 범위:

- Push route payload 검증
- v2 subscription store 저장·재로드·legacy 거부
- 세션별 Push 대상 필터링
- 반복 종료 이벤트 중복 방지
- run 완료 전 중간 assistant 응답 Push 억제 및 queued follow-up 취소
- Push 설정 UI의 등록·롤백·비활성화
- Push 비활성 복귀 시 Web Push 조회 차단
- iOS foreground 복귀 시 stale WebSocket 교체 및 resume lifecycle 신호 복구
- hidden `pageshow`가 premature refresh를 일으키지 않는지 및 resume diagnostic endpoint 검증

### 개발 런타임

- [x] 개발 sessiond 재시작 완료
- [x] 개발 sessiond/Web/API/client 서비스 모두 active 상태
- [x] sessiond socket 정상 listen
- [x] 현재 subscription 파일이 v2 형식인지 확인
- [x] 현재 저장된 구독에 `instanceId`, `sessionId`, `foreground` 매핑이 존재함
- [x] Web Push 전송 요청이 Push 서비스에서 `201 Accepted` 응답을 받는 것 확인

현재 개발 subscription 저장 상태는 v2이며, 두 PWA instance의 scoped subscription이 저장되어 있습니다. 기존 v1 구독은 더 이상 전체 세션 fallback으로 사용되지 않습니다.

## 4. 남은 확인 및 제한사항

- [ ] 서로 다른 두 PWA/browser instance에서 각각 다른 세션을 구독한 뒤 교차 Push가 차단되는지 수동 확인
- [ ] 실제 PWA를 foreground로 둔 상태에서 해당 PWA에 백그라운드 Push가 오지 않는지 확인
- [ ] PR fork에 rebased branch를 force-push
  - 현재 `tyrsha` 계정이 `hoeflechner/pi-web` fork에 push할 권한이 없어 HTTP 403으로 보류됨

## 5. 기준 정보

- 작업 브랜치: `feat/pwa-instance-scoped-push`
- 리베이스 기준: `origin/main` / `eb60068d`
- 개발 도메인: `https://pi-web.cindercopper.com`
- 개발 Web/API 포트: `8505`, `8506`
- 변경은 아직 별도 운영 데몬이 아니라 개발용 인스턴스에만 적용
