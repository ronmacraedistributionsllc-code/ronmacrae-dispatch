# Android Native — Progress

Branch: `android-native` · tag: `pre-android-native` (from `master` 7283daf).
Goal: Capacitor shell (`native/`) wrapping https://orders.ronmacraedistributions.com + rider-only native push, background location, offline resilience. No Play submission in this pass.

## Phase table

| Phase | Status | Evidence |
|---|---|---|
| 0 Safety checkpoint + orientation | done | Branch `android-native`, tag `pre-android-native`; baseline below |
| 1 Toolchain check | in progress | — |
| 2 Capacitor shell scaffold | not started | — |
| 3 Web-side native bridge | not started | — |
| 4 Native push (FCM) end-to-end | not started | blocked on Firebase project (human) for device test |
| 5 Background location | not started | needs device (human) |
| 6 Offline resilience | not started | — |
| 7 Lock-screen actions (stretch) | not started | only if 4–6 green |
| 8 Build, sign, document | not started | unsigned/debug only until human supplies signing env vars |

## Baseline (Phase 0, 2026-10-09, Apple silicon, Node v26.8.1)

- `npm run typecheck` — PASS, 0 errors (all workspaces).
- `npm run lint` — PASS, 0 errors.
- Unit tests (vitest, per workspace):
  - `@ronmacrae/api`: 48 files, 358/358 PASS.
  - `@ronmacrae/web`: 4 files, 20/20 PASS.
  - `@ronmacrae/contracts`: 8/8 PASS.
  - `@ronmacrae/geo`: 21/21 PASS.
  - `@ronmacrae/money`: 8/8 PASS.
  - `@ronmacrae/notifications`: 7/7 PASS.
- `npm run build` — PASS (all workspaces; web PWA precache 23 entries).
- e2e (Playwright): NOT RUN in this baseline (runs serially with `--workers=1` per HANDOFF; will run at final gate if environment supports it).

## Machine notes (Phase 0)

- `java -version`: no Java runtime on PATH.
- `adb`: not on PATH.
- No Capacitor packages installed yet; no device/emulator attached.
- JDKs reportedly at `/opt/homebrew/opt/openjdk@{17,21,27}` and SDK at `/opt/homebrew/share/android-commandlinetools` — to verify in Phase 1.
