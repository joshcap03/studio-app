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
- The call screen decides what Studio says and when (`src/lib/voice/narrator.ts`). Lines wait
  while the voice or the member has the floor. A sentence is said once per turn, whichever way it
  arrived: an opening line, the reply read as soon as it was written, or the same words again in
  the finished reply. The heads-up and time's-up cues each go once.
- `POST /api/voice/session/<id>/end` records the call's length.

Studio stores no audio. The member's words become their messages, labeled "On a call".

## Voices

Each agent speaks with a voice its member chose, from Studio's own catalog
(`src/lib/voice/voices.ts`): eight short keys (`steady`, `clear`, `easygoing`, `warm`, `bright`,
`grounded`, `casual`, `gentle`), each with Studio's label and a line on how it sounds. Only the
ElevenLabs adapter (`ELEVENLABS_VOICES` in `src/lib/voice/elevenlabs.ts`) maps a key to a
premade ElevenLabs voice; templates, proposals and stored choices never hold provider ids.

- Every template starts with its own name and voice (`persona` in `src/lib/templates/index.ts`):
  Rowan (steady) for Job search, June (clear) for Small business, Miles (casual) for Sales
  pipeline, Ada (gentle) for Inbox & calendar, Iris (bright) for Content & social, Sam
  (easygoing) for Start from scratch.
- The member's choice is per member, on their companion row (`agent_companions.voice`, with the
  manner). They pick it on the agent's page ("Voice") or from a setup proposal's "How I'll sound"
  options (`propose_agent` `sound`: up to three side by side, none preselected). Picking a voice
  never gives the agent a name; that still comes from "Say hello".
- `resolvePersona` (`src/lib/voice/persona.ts`) decides the name, voice and manner on the server
  for calls, the greeting, pushes and the agent's own context. The call grant carries the
  provider's voice id, which the browser applies as the agent's voice override; the browser never
  picks it. A new voice takes effect on the next call.
- `GET /api/voice/preview?voice=<key>` says a fixed, server-written line in that voice (the
  browser never sends words). The mock returns a short tone, labeled on screen wherever a preview
  can play. Nothing is stored; each server instance keeps the few clips in memory. Since it
  charges voice time, it refuses what the browser marks as coming from another site
  (`authorizeTenant(request, { writes: true })`), as writes do.

## Speech outside calls, and its metering

`src/lib/voice/speech.ts` says text (`speak`, ElevenLabs text to speech with
`eleven_flash_v2`, the model the call agent speaks with) and hears recordings (`transcribe`,
ElevenLabs speech to text with `scribe_v2`). Under the mock, speech is a tone and transcripts
are empty, so the browser asks for typed words. `VoiceStatus.speech` says what works.

Every clip is charged to the member's daily voice time before it's made, together with their
calls (`LIMIT_VOICE_SECONDS_PER_DAY`, per person, UTC): `claim_voice_clip` records it in
`voice_clips` (kind, a name for the clip, never its words, and seconds) under the same lock as
`claim_voice`, which counts clip seconds too. A call that's still open counts for all the time
it was granted, so a clip can't spend what the call may still use; ending it gives the rest back.
The same clip again the same day is free, so a replay or a second tab charges nothing. The ledger
keeps only a keyed hash of the app's name for a clip (`clipKey`, under `VOICE_SEAL_SECRET`), so a
row a member writes by calling `claim_voice_clip` directly never passes for one already paid.
Rows (and calls) outlast a deleted agent, so deleting one gives no time back. Text to speech
counts about 15 characters a second; speech to text counts to the last word's end (or estimates
from the recording's size).

## Turning it on

1. **ElevenLabs:** an account on a paid plan (calls are billed per minute) and an API key
   (Developers → API Keys) with access to ElevenLabs Agents, Text to Speech, Speech to Text, and
   Voices (read). Consider a credit quota on the key as a backstop.
2. **Two random secrets**, each from `openssl rand -hex 32`: `VOICE_SEAL_SECRET` (signs each
   call's context) and `VOICE_LLM_SECRET` (the key ElevenLabs sends Studio's voice front).
3. **The voice's model:** any OpenAI-compatible chat-completions endpoint with streaming and
   tool calls: `VOICE_LLM_BASE_URL` (up to `/v1`, without `/chat/completions`),
   `VOICE_LLM_API_KEY`, `VOICE_LLM_MODEL`. It only speaks, so a fast model fits, with thinking
   off: on OpenRouter set `VOICE_LLM_EXTRA_BODY` to `{"reasoning":{"enabled":false}}` (Claude
   Haiku 5.5 then answers in under a second; with thinking on, a short reply can spend its whole
   budget thinking and say nothing).
4. **The agent:** run `scripts/voice-agent.mjs` from your own terminal. It creates the one shared
   agent: custom LLM pointed at the voice front (the base URL, `https://<app>/api/voice/llm/v1`;
   ElevenLabs adds `/chat/completions` itself), the two request headers, Studio's client tools,
   the speech model previews use, patient turn taking with backchannels ignored, signed tokens
   only, overrides off except the voice, no audio recording, 30-day retention. It prints the
   agent id and what ElevenLabs stored, then checks (read-only) that each of Studio's voices is
   on the account.

   ```bash
   ELEVENLABS_API_KEY=… VOICE_LLM_SECRET=… APP_URL=https://<app> node scripts/voice-agent.mjs
   ```

   Run it again with `ELEVENLABS_AGENT_ID` set to update that agent instead of making another.
5. **Vercel (Production):** set `VOICE_PROVIDER=elevenlabs`, `ELEVENLABS_API_KEY`,
   `ELEVENLABS_AGENT_ID`, `VOICE_SEAL_SECRET`, `VOICE_LLM_SECRET`, `VOICE_LLM_BASE_URL`,
   `VOICE_LLM_API_KEY`, `VOICE_LLM_MODEL`, and `PREVIEW_VOICE_EMAILS` for anyone not already in
   `PREVIEW_FEATURE_EMAILS`. Redeploy so they take effect. If any are missing, calls stay off
   and the server logs which.
6. **Voices:** the script's last lines say whether each catalog voice is on the account. They're
   ElevenLabs premade voices; if one is missing, add it under My Voices or map that key to
   another premade voice in `src/lib/voice/elevenlabs.ts` and the script.

**Check on the first real call** (the docs don't confirm these yet): that `system__` and
`secret__` variables arrive as custom-LLM headers, that `sendUserMessage` triggers a turn and
`sendContextualUpdate` shows up in the request's messages, the header size limit for the sealed
context, and the Authorization header format of the custom-LLM key. If the request headers come
back empty from the script, set them in the dashboard: Agent → LLM → Custom LLM → Request
headers → Add header, Type: Variable.

## Measuring calls

`scripts/voice-call-metrics.mjs` scores recent real calls from ElevenLabs' own records against
the spec's targets:
- how fast the voice answers once the member stops (target under 0.8s);
- dead air over 4s;
- the voice getting cut off;
- backchannels ignored;
- failed calls;
- how it talked: words said before the member's next turn, turns that ask more than one question,
  turns that hand back the floor, and monologues over 60 words.

```bash
ELEVENLABS_API_KEY=… ELEVENLABS_AGENT_ID=… node scripts/voice-call-metrics.mjs --calls 20
```

Real calls are few, so `tests/integration/setup-call.eval.test.ts` scores the same "how it talked"
numbers without audio or voice minutes. Made-up callers (one rambles, one answers in a few words,
one changes their mind) run a setup interview on a call against a live eval flow. Each turn is
scored from what the voice would say (`relayReply`) and when it could start saying it. The
scorecard also covers greetings, books kept before the reply, replies written again after the
books, and replies too long to say whole. The test fails only on the call's plain rules: at most
two questions at once, and every turn hands back the floor. Run it like the setup evals
(`SETUP_EVAL_LOG` keeps the transcripts, each turn's scores, and the scorecard), and compare
prompt changes by the scorecard over several runs.

On a call the setup interview opens with just its first question: the voice has already greeted
the member, so the setup skill is sent without its "Hey!" and its line on how setup goes
(`setupSkill(…, { call: true })`). The voice says the question the reply's last paragraph ends
on, with a short hint after it when there's room (`closingQuestion` in `relay.ts`).

Sesame's TurnBench (end-of-turn and interruption detection) scores the provider's turn-taking.
Its dataset is licensed for non-commercial use only, so running it for Studio needs Sesame's
written permission. The dev set is about 890 call minutes (roughly $70). Its MIT-licensed scorer
can be used on our own recordings.

## Testing

`npm run qa:serve` runs the mock voice: "Talk it through" opens the call with a labeled mock that
takes typed speech and shows captions, and runs the real voice front with scripted replies (see
`src/lib/voice/mock.ts` for what it understands). Previews on the agent page play the mock's
tone; with the mock agent, "propose how you'll sound" shows a proposal with three ways to
sound. `tests/integration/api-voice.test.ts` and `rls-voice.test.ts` cover isolation and the
daily voice time (calls and clips); `npm run test:audit` checks the narration for every tool in
the flow's history.
