# Test evidence

Legend: VERIFIED = observed. UNVERIFIED = written but not yet observed live. MOCK = test double.

## Milestone 1: Meet audio proof

| Check | Status | Notes |
|-------|--------|-------|
| Server unit tests (token, validation, no key leakage, 502 hides upstream detail, env override) | VERIFIED | 7 tests pass (2026-11-01) |
| Extension unit tests (wake-name matching) | VERIFIED | 4 tests pass |
| Typecheck, extension build | VERIFIED | |
| Live: `POST /v1/realtime/client_secrets` accepts our session config (model `gpt-realtime`, `semantic_vad` with `create_response:false`, `gpt-4o-mini-transcribe`, voice `marin`) | VERIFIED | Returned `ek_…` secret, 2026-11-01 |
| Key handling: real key only in backend; response never contains it | VERIFIED (unit) | |
| Stale system `OPENAI_API_KEY` no longer overrides project `.env` | VERIFIED | Found because the machine env held a non-OpenAI key |
| SDP exchange at `/v1/realtime/calls` from the extension | UNVERIFIED | needs live Meet run |
| Incoming Meet audio reaches Realtime | UNVERIFIED | |
| Delegate reply audible to a second participant | UNVERIFIED | |
| No self-response loop | UNVERIFIED | by design the Realtime peer uses the unhooked RTCPeerConnection |
| Pause / Take Over silence output immediately | UNVERIFIED | cancel event names (`response.cancel`, `output_audio_buffer.clear`) to confirm live |
| Response latency | UNVERIFIED | |
