# Stand-In

An AI delegate for Google Meet (desktop Chrome, Windows). It only participates after you explicitly start it, always identifies itself as an AI delegate, and answers from material you approved. **Status: Milestone 1 (audio proof) in progress; see `docs/test-evidence.md` for what is verified.**

## Setup
1. Node 22 and pnpm. `pnpm install`
2. Copy `.env.example` to `.env`. Set `OPENAI_API_KEY` (an `sk-` key from platform.openai.com; Realtime API access and billing required) and a random `STANDIN_LOCAL_TOKEN` (16+ chars). The project `.env` overrides any system-level variable.
3. Start the backend: `cd apps/server && pnpm dev` (listens on 127.0.0.1:8787 only).
4. Build the extension: `cd apps/extension && pnpm build`. In Chrome open `chrome://extensions`, enable Developer mode, **Load unpacked**, choose `apps/extension/dist`.
5. Reload any open Meet tab.

## Using it (M1)
1. Join a Meet with another person. Turn your Meet mic **on** (unmuted); Meet's mute also mutes the delegate.
2. Open the Stand-In popup on the Meet tab. Enter your name, the name it answers to, paste the local token, tick the consent box (participants have agreed), press **Start**.
3. Ask: "<name>, when is the Falcon launch?" The test knowledge is in `apps/server/knowledge.test.md`.
4. **Pause** or **Take Over** stops the delegate instantly and returns your real mic.

## Data flow
Leaves your device: the meeting's incoming audio (to OpenAI Realtime while the delegate is active), prompts/approved knowledge in session instructions. Stays local: settings, token, (later) transcripts and notes. Raw audio is not stored. Nothing is captured before you press Start. This is a cloud-backed system, not a local one.

## Known limitations
- Depends on Meet's page behavior (mic swap by wrapping `getUserMedia`); Meet updates could break it. Fallback: virtual audio cable plus OBS virtual camera.
- Audio only so far: no avatar or camera yet (Milestone 5).
