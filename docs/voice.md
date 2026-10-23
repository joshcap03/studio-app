# Voice calls (preview)

A call puts a fast voice in front of the agent. The voice (ElevenLabs Agents) listens, talks, and
handles being talked over; the agent (the worker, Langflow) does all the thinking and work, as in
the chat. The voice may only reflect the member's words back, say what the agent reported, ask
them to clarify, and say a holding line. Everything else goes to the agent in the member's exact
words. A call can start from any conversation or a new chat ("Call Rowan" beside the message box's
mic), from the setup banner ("Talk it through"), or from the agent's own offer under a reply.

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
- A hello, "how are you?", or "can you hear me?" on its own (`greetingKind`) is talk between
  people, not a request: the voice says a fixed word back and where things stand ("Hey! What's on
  your mind?", "Yes, I can hear you. I'm still working on it."), or its greeting if it hasn't said
  it yet (`greetingBack`). It never goes to the agent or into the chat, nor along with what they
  say next. Said with anything more ("hi, find me jobs in Austin"), it goes to the agent as usual.
- The model's tools are client tools the browser runs: `fill_card`, `answer_question`,
  `send_card`, `send_message`, `stop_work`. Each checks the member's own speech-to-text
  transcript first: a card is sent only on a clear "send", the work stops only on a clear "stop",
  and talking over a running job is held until it lands unless it's a clear "actually…".
- The call screen decides what Studio says and when (`src/lib/voice/narrator.ts`). Lines wait
  while the voice or the member has the floor. A sentence is said once per turn, whichever way it
  arrived: an opening line, the reply read as soon as it was written, or the same words again in
  the finished reply. A reply that ends on a card is handed over as a person would: its
  opening line, then the paragraph right above the card (`leadIn` in `relay.ts`), and a name the
  agent offers is "Keep it on screen, or tell me the name you'd like." A call never says "The rest
  is on screen": the member is looking at it. The heads-up and time's-up cues each go once.
- `POST /api/voice/session/<id>/end` records the call's length.

Every Studio voice speaks a little slower than ElevenLabs' default, and steadier (speed 0.9,
stability 0.6: `ELEVENLABS_VOICE_SETTINGS`), on calls, previews and voice notes alike. The call
agent's copy is set by `scripts/voice-agent.mjs`; after changing it, update the live agent alone
with `ELEVENLABS_API_KEY=… ELEVENLABS_AGENT_ID=… node scripts/voice-agent.mjs --voice-only`.

Studio stores no audio. The member's words become their messages, labeled "On a call", each with
the call's `voice_sessions` id in its origin once the server has checked the call is the member's
own in this agent (`src/lib/voice/calls.ts`; the browser sends `voiceSessionId`, and someone
else's call, or one ended more than two minutes before, leaves the words plain "voice").

## Calls from any conversation

- **Where it is.** The call is bound to a conversation in the browser only, and the binding moves:
  "Do the first one now" on the stage runs the task and the call follows its run into the task's
  conversation. Everything the stage does (sending, stopping, approving, applying, Retry) acts on
  the call's conversation, not the one on screen. The stage carries `purpose` (setup, task, or
  chat) for the voice's bearings, and the journey is the call's own conversation's (the setup's
  only for the setup interview).
- **Runs this tab didn't start.** A task's run, the worker's, or a stream let go of while the tab
  was hidden is followed by loading the conversation every 1.5 seconds; what each load changed is
  told to the call as the stream would have (`src/lib/chat/follow.ts`: start, steps, text, end), so
  the narration, held words, and the reply's gist work the same. When the call follows a task's
  run, the first load of its conversation tells the run from its start (`joinedEvents`), so one
  that's already over (it failed at once, or reached an approval) is still read out.
- **Joining.** A call reads the last reply out only when it waits on the member (a question, a
  card, or an approval); an older answer isn't news.
- **A long job.** After 45 seconds with nothing new, the call asks once, in fixed words (cue
  `long_job`): "This takes a few minutes. Want to hang on, or should I send you a voice note when
  it's done?" It asks only when the running reply really can come back as a note (`noteCanCome`
  in `src/lib/voice/notes.ts`: it answers words said on this call, a voice message, or a task's
  run), never for one started by typing. Their answer is read strictly from their own transcript:
  `isVoiceNoteIntent` and `isHangOnIntent` take the answer and nothing more ("no, a voice note is
  fine", "no voice note, I'll wait"), so a request said with it, or one that mentions a note
  ("send a note to Sarah"), goes to the worker as usual. A voice note ends the call once the voice
  has said so; hanging on carries on. A reply to words said on a call that finishes after the call
  ended comes back as a voice note. If the job comes back before the call has hung up, or just as
  they answer, the voice says "Actually, it just came back." and reads it instead (no note comes:
  the call was still on). Hanging up while the job goes, the orb shows "Out on it" for a moment,
  and the sidebar's mark keeps breathing by its name. Words still held for that job go into its
  message box, never lost.
- **Retry.** A failed or cut-off reply shows Retry on the stage, and a plain "try again"
  (`isRetryIntent`) retries it rather than sending the words.
- **The agent's offer.** `offer_call` (gateway) puts a "Hop on a call?" card under a reply: why,
  with Not now and Call. It changes nothing and never rings anyone (no push). The app keeps it only
  where the member could take a call (voice on, not on a call, no Not now to an offer in this
  conversation; `TurnDeps.offerCalls`), and tells the agent so in its context (a plain fact that
  names no tool, so a flow from before `offer_call` reads nothing it can't act on). Offers reach
  only pages that know them: a turn's page says so (`offers: true`) and a load asks
  (`?offers=1`), since a tab still on older code would break on the card. Call starts the
  call first, then records the offer as taken with the call's id (checked to be the member's own
  call, still going); Not now is stored, and no more offers come in that conversation. A reply
  keeps two cards plus one offer, last.
- **The recap.** After a call, a card under its last message says what the member asked (their
  words only: a card's picks are decisions, and words held while it worked are quoted apart),
  what got done (steps and files), what they decided (cards sent, questions answered, proposals
  applied, approvals answered while it was on), and what's still out. It's built in the browser
  from the records (`src/lib/voice/recap.ts`) and the calls the conversation's messages were said
  on (`GET /api/conversations/<id>` returns them as `calls`), so it stays true as a job lands;
  nothing is written to the reply. A call that followed a task's run has a recap in the run's
  conversation too (from the run's start), and the one where it was says it started the run and,
  by the run's sidebar mark, whether it's still out. Where a call went is known only to the tab
  it was on, so those parts aren't there after a reload.

## Talking while you use Studio

A call docks over the app as a bar under the page's header (`CallBar` in
`src/components/voice/call.tsx`), so the member keeps using Studio while they talk: the orb, the
latest caption, mute, Type instead, Expand, and End. The thread shows the replies and the cards; a
request waiting on their OK is held and read back there as on the stage
(`src/components/voice/call-approvals.ts`). Expand brings back the full call screen with its stage
(screen sharing and the agent's browser live there), and "Keep using Studio" docks it again. The
setup interview, and a call arriving from onboarding, open full screen.

- **It follows the screen.** Opening a chat moves the call into it, and a new chat starts one;
  on Tasks, the Library, or a project it stays with the chat it was in, and the bar offers "Back
  to …". Settings, the agent's page, and Skills open in their own tab during a call, since a page
  load would end it.
- **Going somewhere: `open`.** "Open my tasks", "show me the job tracker", "go back to the Ramp
  chat", "new chat", "go back". Only the member's own words count (`isOpenIntent`: the whole of
  what they said, so "open my tasks and run the first one" goes to the worker). The voice front
  asks its model for the place and name (the mock reads them with `parseOpen`); the browser
  matches the name against their chats, tasks, trackers, projects, and Library docs
  (`src/lib/voice/places.ts`), and goes there. Two that fit: "Did you mean A or B?", and a bare
  answer picks one. Nothing by that name: it was a request after all, and their words go to the
  worker. Settings and the agent's page are a tap on the bar (a new tab needs one). It changes
  nothing.
- **Pressing a button: `press`.** The page on screen registers the buttons a call may press
  (`useScreenButtons` in `src/components/voice/screen.tsx`, the same handlers its buttons call):
  a task's Run now, Pause or Resume, and Open conversation; a chat's Results. The stage tells the
  voice where they are and which buttons are there (`screen`). Which one is pressed is decided by
  fixed rules on their words (`pressIntent`), never by the model, and only if it's on that page.
  Run now, Pause and Resume change Studio state, so they wait out a visible three-second hold on
  the bar that anything they say, typing, or Cancel stops. Apply, files, connecting apps, setup's
  "Do the first one now", and approvals keep their own rules.
- **What the agent is looking at.** Words said on a call carry the page they were on by id
  (`screen` on the send: a task or a tracker); the server loads it under their session and tells
  the agent ("On the member's screen as they said this: their task …"), so "this one" means
  something. An id that isn't theirs is ignored.
- **Showing what the agent made.** When the agent saves a tracker row (the `saved` stream event,
  sent only once it's saved) or files a doc (`artifact`) while the member watches the call's chat,
  the app shows where it landed, once a reply, unless they've moved around since the reply began.
  If the reply then waits on them, the chat comes back.

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
  options (`propose_agent` `sound`: up to three side by side, none preselected). They can also
  just ask, typed or on a call ("I don't like your voice"): every run's context says which voice
  it speaks with and lists the others (`selfContext`), so the agent offers two or three as a
  sound-only proposal, and a call says "They're on screen: tap one to hear it, then Apply." Picking a voice
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
"Needs you". An offer to call is never the member's call.

## Spoken approvals

A request the agent pauses on (`take_action`) can be approved by voice on a call, where it's safe
to. Each layer checks on its own, and anything out of order fails closed (the request just waits
for a tap):

- **When the agent asks.** `src/lib/approvals/spoken.ts` classifies the request from what
  approving it would run (the adapter's `actions`, the gateway's own routing of the call), never
  from the agent's summary. Voice-ok: one email, reply or forward to at most five people (Gmail,
  Outlook), a draft, or a new calendar event, each with a read-back built from its arguments
  ("I'll email jo@acme.example, subject “March invoice”, saying “…”"). Who it reaches counts
  every address in the arguments: under any recipient or invitee key (`attendees_info`,
  `attendee_emails`…), and an address anywhere else but the sender's fields and the quoted text
  makes it a tap. An event is said whole or not at all: its start, its zone ("New York time"),
  and its end or length; a repeat, a start with a Z or an offset, two zones, another calendar, or
  any argument Studio wouldn't say (a meeting room, visibility) makes it a tap. Everything else is a tap,
  with its reason: `money` (payment apps, or pay/refund/invoice/order… in the action), `deletion`,
  `bulk_send` (more than five people, campaigns, posts, channel messages), or `unsupported`
  (the browser, code, connecting apps, several actions at once, a reply with nobody named, a
  name with no address, anything Studio can't read back plainly). Stored on the request:
  `approvals.voice_ok`, `tap_only`, `read_back`, `tools`; the raw arguments aren't kept.
- **On the call** (`src/components/voice/call.tsx`, guarded by `src/lib/voice/approval-guard.ts`).
  A voice-ok request is read back word for word, then "Say “send it” to go ahead, or tap." A yes
  counts only if the read-back was said in full (its words reached the voice, it spoke, and
  stopped, with nothing talking over it, the voice not muted, the tab not hidden), it's the
  member's first words after it (agreement aside), it came from the speech-to-text (typed words,
  and the provider's echo of them, never count), and it's a clear action phrase (`isApproveIntent`:
  "send it", "go ahead", "yes, do it"; never a bare "yes"). Then a visible 3-second "Approving ·
  Cancel" hold runs on the card; anything said or typed, a tap, the tab hiding, hanging up, muting
  the voice, or the request leaving pending stops it ("wait", "cancel that": the request keeps
  waiting), and it doesn't finish while they may still be talking. If it hears no pause within 5
  seconds of running out, it stops and says so: nothing is sent, and it takes a new "send it".
  Only then is it sent, once; one the server refuses is a tap from then on, on the card and
  aloud. A clear no ("don't send it", `isDeclineIntent`) declines any request.
- **The voice front** routes a yes to the existing `send_card` client tool and a no to `stop_work`
  by fixed rules on the member's own words (`routeSpeech`/`quickRoute`), never the model's call;
  the model's own `send_card`/`stop_work` are dropped while a request waits. Whether the call may
  approve by voice at all is sealed into the call's context when it starts. No new ElevenLabs
  client tools: `scripts/voice-agent.mjs` needn't be run again.
- **The server** (`src/lib/voice/approvals.ts`) checks the decision again: `VOICE_SPOKEN_APPROVALS`
  not "off", the member's voice preview, the trip wire not tripped, the request voice-ok, the
  words a clear yes (or no), and the member's own call in this agent still open. The mock voice's
  "speech" is typed, so under it spoken approvals are on only in front of the mock agent, and
  never approve another provider's request. Only the database records a spoken decision
  (`settle_spoken_approval`: the member's own pending request, their own open call in that agent,
  voice-ok to approve); members can't write `decided_words` or `decided_call` themselves. It
  stores how it was decided (`decided_via` `tap` or `voice`), the words (`decided_words`), and the
  call (`decided_call`); the card says
  "You approved this by voice: “send it”", and the call's recap quotes them.

**The kill switch.** "That's not what I said" under a spoken approval reports it
(`POST /api/conversations/<id>/approvals/<approvalId>/report`, `report_spoken_approval`), which
turns spoken approval off for everyone: every call after says approvals are taps. Only a spoken
approval the database recorded on one of the reporter's own calls can be reported, so a row
written by hand can't trip it. Only SQL turns
it back on, after looking into the report (the request keeps its words, read-back and tools):

```sql
select * from public.spoken_approval_reports;          -- what was reported, and when
delete from public.spoken_approval_reports;            -- spoken approvals back on
```

`VOICE_SPOKEN_APPROVALS=off` turns them off without a report.

## Showing the call your screen or camera

On a call, "Show my screen" or "Show camera" starts a share with a tap (the browser asks which
screen; screen sharing isn't available on phones, the camera is). The stream stays on the member's
device and a small preview shows what the agent would see. Nothing is sent until they ask: a clear
"look at this" in their own speech-to-text (`isLookIntent`), or a tap on Snap. Then one frame,
downscaled to a JPEG of at most 1600 px, is uploaded like any attachment and goes with their words
(the voice says "Let me look."). Said while the agent works, the words and the snapshot wait
together like any talk-over; Snap holds the frame for whatever they say next. While sharing,
leaving the tab doesn't mute the call, since showing another window is the point. The plain line
under the share says a snapshot catches whatever's in view, including other people. The mock voice
shares a labeled drawing instead, so QA needs no picker or camera.

### Watching the agent's browser

When the agent uses its browser in a call's conversation, the stage shows what that browser
shows, as a picture refreshed every two seconds while the page is visible: "My browser · view
only". It's view only by construction. Studio Browser tags each browser result with the
conversation's session id. The turn keeps it on the conversation, sealed with a MAC made with the
app's own Browserbase key, since the member can write that column. `GET
/api/conversations/<id>/browser` then asks Browserbase for that session (only while it's running),
connects to it over CDP server-side, takes one JPEG of the page the agent is on, and disconnects.
The page only ever gets pictures: no connection URL or debugger link leaves the server, and
nothing is stored. (Taking over the browser, outside calls too, is the agent's `hand_browser`
card: see `src/components/chat/browser-handoff.tsx`.)

To turn it on, set `BROWSERBASE_API_KEY` in Vercel to the raw API key of the same Browserbase
project the flow's Studio Browser uses, and reinstall the flow (Studio Browser's tagging). It
needs Browserbase minutes. Check on the first real use that taking a picture doesn't disturb the
agent's own connection to the browser.

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

`npm run qa:serve` runs the mock voice: "Talk it through", or the call button in any chat, opens the call with a labeled mock that
takes typed speech and shows captions, and runs the real voice front with scripted replies (see
`src/lib/voice/mock.ts` for what it understands). Previews on the agent page play the mock's
tone; with the mock agent, "propose how you'll sound" shows a proposal with three ways to
sound; "hop on a call" shows an offer to call; "a very slow job" runs for over a minute with
nothing new, so a call asks whether to hang on or leave a voice note. `tests/integration/api-voice.test.ts`
and `rls-voice.test.ts` cover isolation and the daily voice time (calls and clips), and
`api-calls.test.ts` the call a message was said on, a conversation's calls, the voice note after
hanging up, and the offer; `api-spoken-approvals.test.ts` and `rls-approvals-attachments.test.ts`
spoken approvals and the kill switch; `npm run test:audit` checks the narration, and the spoken
approval class of every `take_action`, across the flow's history.

Spoken approvals on the mock: "email Casting Co about the duplicate payment" asks for a reply to
one person (voice-ok), "pay the Casting Co invoice" for a payment (a tap). On the call, Send types
the words (so "send it" sent that way is refused, as typed); **Say it (mock)** takes them as
spoken, standing in for the speech-to-text, so "send it" said after the read-back starts the hold.
