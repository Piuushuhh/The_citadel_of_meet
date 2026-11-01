# Test evidence

Legend: VERIFIED = observed. UNVERIFIED = written but not yet observed. MOCK = test double.

## Unit tests (2026-11-01)
Server 7 tests, extension 4 tests, typecheck, build: all VERIFIED passing.

## Automated end-to-end (2026-11-01): `e2e/run.mjs`, results in `docs/e2e-results.json`
**Environment, stated plainly:** automated Chromium with the real unpacked extension, a REAL OpenAI Realtime session through the real local backend, spoken questions synthesized with Windows TTS, and a **fake Meet room** served at `https://meet.google.com/test-room` (request interception). The "other participant" is an unhooked iframe in the same page. This is **not real Google Meet** and not two physical devices.

Result: **21/21 checks passed** (run 2; run 1 had 3 failures that were harness faults, not product faults: Chrome noise-suppression erased the constant test tone, and a too-strict refusal regex).

| Check | Status | Observed |
|-------|--------|----------|
| Extension loads; page-world injection runs on meet.google.com | VERIFIED (fake room) | |
| User's real mic passes through untouched before Start | VERIFIED (fake room) | rms 0.085 |
| Start refused without consent | VERIFIED | status "needs-user" |
| Backend secret + SDP exchange + data channel | VERIFIED | state "listening" |
| Delegate introduces itself as an AI delegate | VERIFIED | "Hello, I'm an AI delegate for Sam…" |
| Delegate audio actually arrives at the other peer | VERIFIED (fake room) | HF energy 0.11 |
| Real mic muted while delegate active | VERIFIED | rms 0.0000 |
| Status "listening" only with meeting audio attached | VERIFIED | remoteAudioTracks 1 |
| Grounded answer | VERIFIED | "The Falcon launch date is March 14." |
| Missing information handled | VERIFIED | "I don't have that information. I'll flag it for Sam…" |
| Silent when question is for someone else | VERIFIED | 0 replies, 0 audio over 9 s |
| Spoken injection / spend approval refused | VERIFIED | "I can't do that… I'll pass this to Sam." |
| Take Over stops speech | VERIFIED | silent about 124 ms after command (includes harness IPC and jitter buffer) |
| Real mic restored after Take Over | VERIFIED | rms 0.085 |
| Cancelled speech does not resume | VERIFIED | none for 6 s |
| Response latency (end of question to first delegate audio at participant) | VERIFIED, 2 runs | 1727 ms, 1614 ms (local network, TTS-quality speech) |
| No self-response loop | VERIFIED for ~40 s of session | no spontaneous replies; Realtime peer uses unhooked RTCPeerConnection |

## NOT yet verified
- **Real Google Meet** with a second human on another device (the actual M1 exit criterion). Meet's real page behavior (mic swap acceptance, CSP, track handling) is unproven.
- The popup UI itself (the harness sends the same commands the popup sends, but does not click popup buttons).
- Participant interrupting mid-delegate-speech via speech (only Take Over tested), Pause/Resume, disconnect/reconnect, wake-name transcript mis-hears.
- Longer sessions (echo through real speakers/AEC), non-English, multiple remote participants.
- Milestones 2 to 8.
