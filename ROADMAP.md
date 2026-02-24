# Eppu Roadmap

Last updated: 2026-02-24

## Product Direction

Build the best possible Raspberry Pi frontend experience first, then add controlled internet access, then layer voice and AI features.

## Ranked Priorities

1. Pi-first frontend rebuild
2. Controlled internet access (ngrok/Cloudflare Tunnel)
3. Wake word + voice control
4. Suno AI auto-song generation

## Why This Order

1. Frontend quality and performance on constrained hardware is the foundation for everything else.
2. Internet exposure should be deliberate and hardened after core UX is stable.
3. Wake-word control depends on stable control APIs and clear playback state handling.
4. Suno integration has the highest complexity (product flow, quota/cost, policy handling) and is not critical for core control UX.

## Milestone 1: Frontend Rebuild (Pi-First)

### Goal

Deliver a fast, polished, mobile-friendly web UI that runs well on Raspberry Pi.

### Scope

1. Replace current single-file UI with a cleaner, maintainable local-first interface.
2. Improve interaction quality and visual hierarchy for mobile + desktop.
3. Keep JS/CSS lightweight for Pi CPU and memory constraints.
4. Validate on phone + desktop in the same network.

### Non-Goals

1. Internet exposure setup and security hardening.
2. Voice wake-word pipeline.
3. Suno generation flow.

### Acceptance Criteria

1. UI is responsive and works smoothly on Raspberry Pi hardware.
2. Core controls (play, pause, skip, queue, volume) remain reliable.
3. Queue management interactions are clear and stable on mobile and desktop.
4. Frontend is ready for internet hardening work in Milestone 2.

### Implementation Plan

1. Frontend redesign
   - Introduce design tokens (color/spacing/radius/motion).
   - Improve hierarchy, readability, and touch interactions.
   - Keep JS/CSS lightweight for Pi performance.
2. Runtime optimization
   - Reduce unnecessary re-renders and polling work.
   - Keep payloads and UI update logic efficient.
3. Validation
   - Test on Raspberry Pi + mobile browser.
   - Verify low CPU/memory overhead during long sessions.

## Milestone 2: Controlled Internet Access

1. Add optional tunnel setup guide (ngrok/Cloudflare Tunnel).
2. Keep disabled by default.
3. Add explicit warning, rate limits, and auth gate for exposed mode.
4. Define safe defaults for exposed deployments (headers, origin policy, request limits).

## Milestone 3: Wake Word + Voice Control

1. Evaluate wake-word engines for Pi (accuracy vs CPU usage).
2. Define command grammar (play/pause/skip/volume/queue).
3. Implement local speech pipeline and fallback behavior.
4. Add observability for false positives/negatives.

## Milestone 4: Suno AI Auto-Song

1. Define user flow (prompt -> generate -> queue).
2. Validate API limits/cost controls and moderation boundaries.
3. Add async job handling and status updates in UI.
4. Add safety controls (quotas, cooldowns, failure states).

## Immediate Next Step

Start Milestone 1 with frontend architecture cleanup and UI rebuild.
