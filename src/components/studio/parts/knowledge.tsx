"use client";

import { useEffect, useState } from "react";
import { BusinessBrain } from "@/components/settings/business-brain";
import { api } from "@/lib/client/api";
import type { StudioData } from "@/lib/client/studio";
import { ASKS, knowledge, knowledgeLine } from "@/lib/studio";
import type { MemoryPromotion, MessageSkill } from "@/lib/types";
import { DescribeBar, quietLink } from "../ask-link";
import { PartHead, Unread } from "./shared";

// What the agent remembers (the Brain, as it is everywhere else), and what else it has to go on.

const count = (n: number, noun: string) => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`);

export function KnowledgePart({ data, owner, onGo, onDescribe }: { data: StudioData; owner: boolean; onGo: (path: string) => void; onDescribe: (text: string | null, skill?: MessageSkill | null) => void }) {
  const [promotions, setPromotions] = useState<MemoryPromotion[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.listPromotions(controller.signal).then(
      ({ promotions: list }) => setPromotions(list),
      () => setPromotions([]),
    );
    return () => controller.abort();
  }, []);

  return (
    <>
      <PartHead title="Knowledge" hint={data.memories ? knowledgeLine(knowledge(data.memories)) : "What it remembers and has to go on."} />
      <div className="mb-4">
        <DescribeBar lead={ASKS.remember} placeholder="Tell it something to remember" onDescribe={onDescribe} />
      </div>
      <ul className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-3">
        {data.files ? <li>{count(data.files.length, "file")} you gave it</li> : null}
        {data.library ? (
          <li>
            <button type="button" onClick={() => onGo("/library")} className={quietLink}>
              {count(data.library.items.length, "thing")} in the Library
            </button>
          </li>
        ) : null}
        {data.library ? (
          <li>
            <button type="button" onClick={() => onGo("/library")} className={quietLink}>
              {count(data.library.trackers.length, "list")} it keeps
            </button>
          </li>
        ) : null}
        <li>
          <a href="/agent" className={quietLink}>
            Files and more
          </a>
        </li>
      </ul>
      {data.memories === null ? <Unread>Its notes couldn&apos;t be read just now.</Unread> : promotions ? <BusinessBrain initialMemories={data.memories} initialPromotions={promotions} isOwner={owner} /> : null}
    </>
  );
}
