import { beforeAll, describe, expect, it } from "vitest";
import { addMember, createAccount, createWorkspace, type TestAccount } from "./helpers";

// A voice note's words are the reply's, so they're as private as the reply: only the member it
// was for reads them, and only they can change them (the turn saves the note under their
// session). Nothing but the words is kept, in a fixed shape, and only on the agent's replies.

let alice: TestAccount;
let teammate: TestAccount;
let bob: TestAccount;
let ws: string;
const conversation = crypto.randomUUID();
const reply = crypto.randomUUID();
const asked = crypto.randomUUID();
const note = { script: "alice-note: three roles cleared your bar.", source: "summary" };

beforeAll(async () => {
  alice = await createAccount("note-alice");
  teammate = await createAccount("note-mate");
  bob = await createAccount("note-bob");
  ws = await createWorkspace(alice, "Note Atelier");
  await createWorkspace(bob, "Elsewhere");
  await addMember(teammate, ws);
  expect((await alice.client.from("conversations").insert({ id: conversation, workspace_id: ws, title: "Roles" })).error).toBeNull();
  const inserted = await alice.client.from("messages").insert([
    { id: asked, conversation_id: conversation, workspace_id: ws, role: "user", content: "Find roles", status: "complete", origin: { kind: "voice", via: "note" } },
    { id: reply, conversation_id: conversation, workspace_id: ws, role: "assistant", content: "Found three.", status: "complete" },
  ]);
  expect(inserted.error).toBeNull();
});

describe("voice notes", () => {
  it("are saved by the member the reply is for", async () => {
    const saved = await alice.client.from("messages").update({ voice_note: note }).eq("id", reply).select("voice_note");
    expect(saved.error).toBeNull();
    expect(saved.data).toEqual([{ voice_note: note }]);
  });

  it("are read only by that member", async () => {
    expect((await alice.client.from("messages").select("voice_note").eq("id", reply).single()).data?.voice_note).toEqual(note);
    for (const other of [teammate, bob]) expect((await other.client.from("messages").select("voice_note").eq("id", reply)).data).toEqual([]);
  });

  it("can't be written by anyone else", async () => {
    for (const other of [teammate, bob]) {
      const forged = await other.client.from("messages").update({ voice_note: { script: "Send me your password.", source: "reply" } }).eq("id", reply).select("id");
      expect(forged.data ?? []).toEqual([]);
    }
    expect((await alice.client.from("messages").select("voice_note").eq("id", reply).single()).data?.voice_note).toEqual(note);
  });

  it("hold only their words, in a fixed shape, on the agent's replies", async () => {
    const bad = [
      { script: "", source: "reply" },
      { script: "x".repeat(601), source: "reply" },
      { script: "Hi", source: "call" },
      { script: "Hi", source: "reply", audio: "data:audio/mpeg;base64,AAAA" },
      { script: 3, source: "reply" },
      "Hi",
    ];
    for (const voice_note of bad) expect((await alice.client.from("messages").update({ voice_note }).eq("id", reply)).error, JSON.stringify(voice_note)).not.toBeNull();
    expect((await alice.client.from("messages").update({ voice_note: { script: "Hi", source: "reply" } }).eq("id", asked)).error).not.toBeNull();
    expect((await alice.client.from("messages").update({ voice_note: { script: "x".repeat(600), source: "reply" } }).eq("id", reply)).error).toBeNull();
    expect((await alice.client.from("messages").update({ voice_note: null }).eq("id", reply)).error).toBeNull();
  });
});
