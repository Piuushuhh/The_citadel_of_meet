# Stand-In

An AI delegate for Google Meet (desktop Chrome, Windows). It only participates after you explicitly start it, always identifies itself as an AI delegate, and answers from material you approved. **Status: Milestone 1 (audio proof) in progress; see `docs/test-evidence.md` for what is verified.**

## Setup
1. Node 22 and pnpm. `pnpm install`
2. Copy `.env.example` to `.env`. Set `OPENAI_API_KEY` (an `sk-` key from platform.openai.com; Realtime API access and billing required) and a random `STANDIN_LOCAL_TOKEN` (16+ chars). The project `.env` overrides any system-level variable.
3. Start the backend: `cd apps/server && pnpm dev` (listens on 127.0.0.1:8787 only).
4. Build the extension: `cd apps/extension && pnpm build`. In Chrome open `chrome://extensions`, enable Developer mode, **Load unpacked**, choose `apps/extension/dist`.
5. Reload any open Meet tab.

## Using it
1. Join a Meet with another person. Turn your Meet mic **on** (unmuted); Meet's mute also mutes the delegate. Meet must be in English (captions and the "You" label).
2. Open the Stand-In popup on the Meet tab. Enter your name, the name it answers to, paste the local token, optionally fill **About you**, tick the consent box (participants have agreed), press **Start**. It turns on Meet's captions: that is how it hears the meeting.
3. It replies automatically: always when its name is said; to everything the other person says in a one-to-one meeting; to quick follow-ups from whoever it just answered; otherwise when an AI check judges the line is meant for it. **Answer now** makes it reply to the last thing said.
4. Someone talking over it stops it. **Pause** stops it replying and recording; **Take Over** stops it completely and returns your real mic.
5. **Meeting memory** in the popup shows the running notes and a to-do list of what it promised to pass on to you. The test knowledge is in `apps/server/knowledge.test.md`.

## Data flow
Leaves your device: the text of Google Meet's live captions while the delegate is active (no meeting audio is sent: it hears through captions), prompts/approved knowledge and your "About you" text (typed, or extracted from an uploaded PDF/Markdown file) in session instructions. Uploaded PDFs are converted to text by your local backend and are not stored; the extracted text is kept in the extension's local storage until you clear it. Meeting memory: what is said while the delegate runs (captions/transcripts, its replies) is kept in the extension's local storage per meeting code (max 2000 lines, deleted after 30 days or with "Forget this meeting"); every 15 lines the new lines are sent through your local backend to OpenAI (SUMMARY_MODEL, default gpt-4.1-mini) to update the running notes. Nothing carries over to other meetings unless you press "Save to About you". Stays local: settings, token. Raw audio is not stored. Nothing is captured before you press Start. This is a cloud-backed system, not a local one.

## Known limitations
- Depends on Meet's page behavior (mic swap by wrapping `getUserMedia`; captions and the People count read from the page); Meet updates could break it. Fallback: virtual audio cable plus OBS virtual camera.
- Audio only so far: no avatar or camera yet (Milestone 5).
