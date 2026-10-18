# Voice calls (preview)

A call puts a fast voice in front of the agent. The voice (ElevenLabs Agents) listens, talks, and
handles being talked over; the agent (the worker, Langflow) does all the thinking and work, as in
the chat. The voice may only reflect the member's words back, say what the agent reported, ask
them to clarify, and say a holding line. Everything else goes to the agent in the member's exact
words. Phase 1 is the Setup Call: "Talk it through" beside "Start" on the setup banner.

## How it fits together

- `POST /api/voice/session` (member's session): checks the voice preview, claims the call against
  the member's daily voice time (`claim_voice`), mints a one-time ElevenLabs conversation token,
  and seals the call's voice context (guardrail first, persona) with `VOICE_SEAL_SECRET`, bound
  to ElevenLabs' conversation id.
- The browser joins with the token and passes the sealed context as the dynamic variable
  `secret__studio_voice_ctx`. Nothing else about the member is set from the browser.
- ElevenLabs calls Studio's voice front, `POST /api/voice/llm/v1/chat/completions`, for every
  turn. It has no member session: it checks `VOICE_LLM_SECRET`, opens the sealed context, checks
  it against the conversation id header, ignores ElevenLabs' own prompt, and builds its own.
  Studio's lines (progress, the reply's gist, card contents, cues) arrive as marked user messages
  and are said word for word without a model; only the member's speech goes to the model.
- The model's tools are client tools the browser runs: `fill_card`, `answer_question`,
  `send_card`, `send_message`, `stop_work`. Each checks the member's own speech-to-text
  transcript first: a card is sent only on a clear "send", the work stops only on a clear "stop",
  and talking over a running job is held until it lands unless it's a clear "actually…".
- `POST /api/voice/session/<id>/end` records the call's length.

Studio stores no audio. The member's words become their messages, labeled "On a call".

## Turning it on

1. **ElevenLabs:** an account on a paid plan (calls are billed per minute) and an API key
   with access to ElevenLabs Agents (Developers → API Keys).
2. **Two random secrets**, each from `openssl rand -hex 32`: `VOICE_SEAL_SECRET` (signs each
   call's context) and `VOICE_LLM_SECRET` (the key ElevenLabs sends Studio's voice front).
3. **The voice's model:** any OpenAI-compatible chat-completions endpoint with streaming and
   tool calls: `VOICE_LLM_BASE_URL` (up to `/v1`, without `/chat/completions`),
   `VOICE_LLM_API_KEY`, `VOICE_LLM_MODEL`. It only speaks, so a fast model fits.
4. **The agent:** run `scripts/voice-agent.mjs` from your own terminal. It creates the one shared
   agent: custom LLM pointed at the voice front, the two request headers, Studio's client tools,
   patient turn taking with backchannels ignored, signed tokens only, overrides off except the
   voice, no audio recording, 30-day retention. It prints the agent id and what ElevenLabs stored.

   ```bash
   ELEVENLABS_API_KEY=… VOICE_LLM_SECRET=… APP_URL=https://<app> node scripts/voice-agent.mjs
   ```

   Run it again with `ELEVENLABS_AGENT_ID` set to update that agent instead of making another.
5. **Vercel (Production):** set `VOICE_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`,
   `ELEVENLABS_AGENT_ID`, `VOICE_SEAL_SECRET`, `VOICE_LLM_SECRET`, `VOICE_LLM_BASE_URL`,
   `VOICE_LLM_API_KEY`, `VOICE_LLM_MODEL`, and `PREVIEW_VOICE_EMAILS` for anyone not already in
   `PREVIEW_FEATURE_EMAILS`. Redeploy so they take effect. If any are missing, calls stay off
   and the server logs which.
6. **Voices:** each template's default voice id is in `src/lib/voice/persona.ts`; check they exist
   on the account.

**Check on the first real call** (the docs don't confirm these yet): that `system__` and
`secret__` variables arrive as custom-LLM headers, that `sendUserMessage` triggers a turn and
`sendContextualUpdate` shows up in the request's messages, the header size limit for the sealed
context, and the Authorization header format of the custom-LLM key. If the request headers come
back empty from the script, set them in the dashboard: Agent → LLM → Custom LLM → Request
headers → Add header, Type: Variable.

## Testing

`npm run qa:serve` runs the mock voice: "Talk it through" opens the call with a labeled mock that
takes typed speech and shows captions, and runs the real voice front with scripted replies (see
`src/lib/voice/mock.ts` for what it understands). `tests/integration/api-voice.test.ts` and
`rls-voice.test.ts` cover isolation; `npm run test:audit` checks the narration for every tool in
the flow's history.
