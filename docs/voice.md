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

## Setting up the ElevenLabs agent

One shared agent serves every member. In the ElevenLabs dashboard (or API):

1. **LLM:** Custom LLM, chat completions, URL `https://<app>/api/voice/llm/v1/chat/completions`,
   API key = a new ElevenLabs secret holding `VOICE_LLM_SECRET`. Temperature unset.
2. **Custom LLM request headers:**
   - `X-Studio-Conversation` → dynamic variable `system__conversation_id`
   - `X-Studio-Voice-Ctx` → dynamic variable `secret__studio_voice_ctx`
3. **First message:** empty. The browser cues the greeting; a short `initial_wait_time` works too.
4. **Client tools** (`expects_response: true`, timeout 10 s, pre-tool speech off), each with no
   required parameters on the ElevenLabs side (Studio sends the model its own schemas):
   `fill_card` (params `field`, `value`, `sure`), `answer_question` (`answers`), `send_card`,
   `send_message`, `stop_work`. Add the system tools `skip_turn` and `end_call`.
5. **Turn taking:** `turn_eagerness: patient`, `turn_timeout: 20`, `interruption_ignore_terms`
   with the usual backchannels ("mm-hm", "yeah", "okay", "right", …) and
   `merge_with_default_ignore_terms: true`. Leave "yes" out of the list.
6. **Client events:** `user_transcript`, `agent_response`, `interruption`, `client_tool_call`,
   `agent_response_correction`, `vad_score`.
7. **Security and privacy:** authentication required (signed tokens only). Overrides off except
   `tts.voice_id`. `custom_llm_extra_body` off. `record_voice: false`, short retention.
8. **Voices:** each template's default voice id is in `src/lib/voice/persona.ts`; check they exist
   on the account.

Then set the `VOICE_*` and `ELEVENLABS_*` values from `.env.example` in Vercel and add the
members to `PREVIEW_VOICE_EMAILS` (or `PREVIEW_FEATURE_EMAILS`).

**Check on the first real call** (the docs don't confirm these yet): that `system__` and
`secret__` variables arrive as custom-LLM headers, that `sendUserMessage` triggers a turn and
`sendContextualUpdate` shows up in the request's messages, the header size limit for the sealed
context, and the Authorization header format of the custom-LLM key.

## Testing

`npm run qa:serve` runs the mock voice: "Talk it through" opens the call with a labeled mock that
takes typed speech and shows captions, and runs the real voice front with scripted replies (see
`src/lib/voice/mock.ts` for what it understands). `tests/integration/api-voice.test.ts` and
`rls-voice.test.ts` cover isolation; `npm run test:audit` checks the narration for every tool in
the flow's history.
