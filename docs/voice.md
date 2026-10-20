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
A voice's preview again the same day is free (each server instance makes the clip once). A
voice note or a recording is charged every time the provider makes or hears it, so no loop on a
route is free: the browser keeps a played note for a day, so replaying it there costs nothing.
Time a recording already took is charged in full once it's heard, even past the day's limit,
which then refuses more (`claimVoiceClip(…, { spent: true })`). The ledger keeps only a keyed
hash of the app's name for a clip (`clipKey`, under `VOICE_SEAL_SECRET`), so a row a member writes
by calling `claim_voice_clip` directly never passes for one already paid. Rows (and calls)
outlast a deleted agent, so deleting one gives no time back. Text to speech counts about 15
characters a second; speech to text counts the length the provider measured (else the end of the
last thing it timed, else an estimate from the recording's size).

## The mic in the message box

Every message box (a chat, a new chat, a project) has a mic for members with voice whose speech
provider can hear (`VoiceStatus.speech.stt`). The rules are pure (`src/lib/voice/mic.ts`); the
recorder is `src/components/chat/mic.tsx`.

- **Hold it** (300 ms or more) to send a voice message: let go and it's sent, labeled "Voice
  message"; slide away or press Esc to drop it. A timer shows, and two minutes is the most (it's
  sent then). While the agent is working or waits on an approval, or with words already typed,
  the message goes into the draft instead, so sending it (and redirecting the work, or declining
  the approval) stays the member's call. Held into an empty draft, it's still sent as a voice
  message; joining typed words, it's typing. A hold the mic opened too late for (a slow headset)
  catches nothing and closes the mic, rather than dictating.
- **Tap it** to dictate: the words go into the draft where the caret is, and are never sent on
  their own. Tap again to stop. With the keyboard, Enter or Space on the mic does the same.
- Recording starts at the press (`MediaRecorder`: Opus in WebM or Ogg, AAC in MP4 on Safari, at
  32 kbit/s). The recording goes once to `POST /api/voice/transcribe` (the member's session, raw
  audio up to 4 MB, two minutes at any rate a browser records speech; recorders' types only),
  which charges it to the day's voice time by its size (up to two minutes, then the rest of the
  provider's own length), turns it into words, and drops it. One the provider says ran past two
  minutes gets no words back (413). Hiding the page while recording (a locked phone stops the mic)
  puts what was said into the draft; a call starting takes the mic, dropping the recording, and
  the mic waits until the call ends.
- Under the mock voice nothing is recorded: the mic opens a box labeled "Mock voice: type what
  you'd say", held or tapped the same way.

A voice message is sent with `modality: "voice_note"`, stored as the origin
`{kind: "voice", via: "note"}` (a plain `{kind: "voice"}` is a call). The agent is told the member
spoke it, and that the start of its reply is what they'll hear. A retry, an edit, or a decision on
an approval answers the latest message again, so it's said the way that one was: the server reads
it from that message's origin, not from the browser.

## Voice notes

Some replies come back as a voice note to tap and play, with the text underneath
(`src/lib/voice/notes.ts`, decided when the reply is saved, for members with voice):

- a reply to a voice message says its gist: the first two sentences, as a call would (a reply
  carried on after the member decided on an approval says what it went on to say, not what they
  read before deciding);
- a task run that reports `update` or `needs_you` says its `report_run` summary (the agent is told
  it's heard, so it writes two or three short spoken sentences), shown as the note's caption.

Calls, typed messages, and runs that found nothing, failed, stopped, or wait on an approval get
none. Only the words are saved (`messages.voice_note`, at most 600 characters). Playing one asks
`GET /api/conversations/<id>/messages/<reply>/speech`, which says the words in the voice this
member chose for the agent (`resolvePersona`) and sends the audio straight back, never stored.
Each play the server makes is charged (the browser keeps the clip for a day, so replays there are
free), and the route refuses what the browser marks as coming from another site. If the day's
voice time is used up, the note says so and the text stays.

One clip plays at a time across the app (`src/components/voice/player.tsx`, shared with voice
previews): it stops when the tab is hidden, when the member types or opens the mic, and when a call
starts. A run that ends while the member is away with a voice note sends "<Name> left you a voice
note", which opens the conversation at the note (`?play=<reply>`) with its play button pointed
out and focused. It never plays on its own: browsers need a tap first. With a Studio window
already open, the service worker asks it to go there without a reload (`studio:open`; the
conversation already on screen is loaded again in place); a window that doesn't answer within a
second (a page from before the latest build) is sent there instead.

## The journey and whose move it is

Any work with several steps has a plan the member sees above the chat: the rail, titled by what
done looks like ("Done means three caterers under $40 a head…"), which the agent says in one line
before it starts and passes as `update_plan`'s `goal` (`langflow/agent_instructions.md`). The plan
lives with the conversation's task, the owner's setup checklist, or the conversation itself
(`src/lib/journey.ts`), and each save streams to the browser, so the rail fills in as the agent
works, on a call as in the chat. On a call, the stage carries the journey's goal and whose plan it
is (`kind`: setup, task, or conversation): the voice says "Setup: …" for setup and "Done means …"
for anything else, in its greeting and its view of the stage. A page loaded before journeys had
kinds sends none, and only ever sent the setup's, so the voice reads a journey without one as setup.

Whose move it is comes from one place (`src/lib/chat/move.ts`): working, the member's call (an
approval, an open card or question, a task run that needs them), done, stuck, or idle. The call's
orb takes working, your call, and stuck from it and keeps its own floor states (listening,
speaking, on it, connecting); the rail marks "Your call" or "Stuck", held still; the sidebar marks
conversations working, waiting on the member, or stuck, and the agent's mark breathes while any run
is going, including one out of view; and a push for a reply that ends on a card or question says
"Needs you". An offer to talk (a later version's card) is never the member's call.

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
