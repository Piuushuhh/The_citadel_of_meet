# Stand-In Implementation Plan

Spec: `docs/superpowers/specs/2026-11-01-stand-in-design.md` (approved 2026-11-01).
Rule: each milestone ends with recorded evidence in `docs/test-evidence.md` before the next starts.

## Verified API facts (2026-11-01)
- Mint secret: `POST https://api.openai.com/v1/realtime/client_secrets`, auth = real key (backend only), body `{ expires_after?, session: { type: "realtime", model, audio, instructions, ... } }`, response `{ value: "ek_...", expires_at, session }`.
- Browser SDP exchange: `POST https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ek_...>`, `Content-Type: application/sdp`.
- Model name configurable (`REALTIME_MODEL`); docs show `gpt-realtime` and newer variants. Check against the account at runtime.
- Still to confirm against live API in M1: data-channel event names for `response.cancel`, `output_audio_buffer.clear`, `input_audio_buffer.speech_*`, `semantic_vad` settings.

## Layout
pnpm workspace: `apps/extension` (MV3 + React), `apps/server` (Node 22, Hono, SQLite), `packages/shared` (types, state machine).

## M1 Meet audio proof (blocking)
1. Server: `/session` mints secret; key read only from env.
2. Extension skeleton: manifest, service worker, content script, page-world script wrapping `getUserMedia` (pass-through by default).
3. Activation: user clicks Start; tab capture of meeting audio -> Realtime peer connection (input track).
4. Outgoing: Realtime remote track -> Web Audio -> MediaStreamDestination -> swapped into Meet's mic sender.
5. Grounded reply from a small test passage; gate node for Stop/Take Over; no loop (delegate tab output excluded from capture, input gated while speaking).
6. Real test with second participant on another device; log latency; record in evidence.
Exit: other participant hears reply; Stop silences within one audio frame/buffer; no self-response. Else switch to fallback (#2) and rerun.

## M2 Backend session + tool authorization
Tool endpoint with per-session allowlist; secrets never in client; tests.

## M3 Knowledge + grounding
Upload, chunk, embed, retrieve with citations; restricted-topic enforcement server-side; prompt-injection tests.

## M4 Turn-taking and state
Three decisions, modes, state machine, interruption/cancel with queue clearing.

## M5 Avatar and label
Canvas renderer, lip-sync, blink/idle, label as last draw step, injected camera.

## M6 Memory
Consent gate, transcript store, summaries/decisions/actions, search, export, deletion, retention.

## M7 UI
Setup checks, controls, live transcript, escalation, notes.

## M8 Validation and docs
Full matrix from spec section 12, latency table, data-flow doc, limitations.
