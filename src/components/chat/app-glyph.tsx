import {
  BookMarked,
  Box,
  Calculator,
  CalendarDays,
  Camera,
  Compass,
  CreditCard,
  FileText,
  Globe,
  HardDrive,
  Hash,
  Mail,
  NotebookText,
  Receipt,
  Sheet,
  ShoppingBag,
  SquareTerminal,
  Table2,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { appName } from "@/lib/apps";

// Small app marks for agent steps. Quiet tints, one per app family, so a run reads at a
// glance as "Gmail → Sheets → Web" without becoming colorful.

const GLYPHS: Record<string, { icon: LucideIcon; tint: string }> = {
  gmail: { icon: Mail, tint: "text-[#c5432f] bg-[#c5432f]/10" },
  outlook: { icon: Mail, tint: "text-[#2f6cc5] bg-[#2f6cc5]/10" },
  sheets: { icon: Sheet, tint: "text-[#2f7a4c] bg-[#2f7a4c]/10" },
  docs: { icon: FileText, tint: "text-[#3a64a8] bg-[#3a64a8]/10" },
  drive: { icon: HardDrive, tint: "text-[#b0862a] bg-[#b0862a]/10" },
  calendar: { icon: CalendarDays, tint: "text-[#3a64a8] bg-[#3a64a8]/10" },
  shopify: { icon: ShoppingBag, tint: "text-[#5e8e3e] bg-[#5e8e3e]/10" },
  slack: { icon: Hash, tint: "text-[#7a3f7a] bg-[#7a3f7a]/10" },
  notion: { icon: NotebookText, tint: "text-fg-2 bg-subtle" },
  airtable: { icon: Table2, tint: "text-[#b0702a] bg-[#b0702a]/10" },
  hubspot: { icon: Users, tint: "text-[#c5602f] bg-[#c5602f]/10" },
  quickbooks: { icon: Receipt, tint: "text-[#2f7a4c] bg-[#2f7a4c]/10" },
  stripe: { icon: CreditCard, tint: "text-[#5b4fc4] bg-[#5b4fc4]/10" },
  instagram: { icon: Camera, tint: "text-[#b03a7a] bg-[#b03a7a]/10" },
  web: { icon: Globe, tint: "text-[#3a64a8] bg-[#3a64a8]/10" },
  browser: { icon: Compass, tint: "text-[#3a7a8a] bg-[#3a7a8a]/10" },
  memory: { icon: BookMarked, tint: "text-accent bg-accent-soft" },
  code: { icon: SquareTerminal, tint: "text-fg-2 bg-subtle" },
  calculator: { icon: Calculator, tint: "text-fg-2 bg-subtle" },
  agent: { icon: Wrench, tint: "text-fg-3 bg-subtle" },
};

export function AppGlyph({ app, size = 18, className = "" }: { app?: string; size?: number; className?: string }) {
  const glyph = (app && GLYPHS[app]) || { icon: Box, tint: "text-fg-3 bg-subtle" };
  const Icon = glyph.icon;
  return (
    <span
      title={appName(app)}
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] ${glyph.tint} ${className}`}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.62)} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}
