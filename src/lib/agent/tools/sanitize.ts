// Helpers for turning raw tool input/output into safe, bounded preview data. Anything shown
// to the user passes through here: secrets are masked, links must be https, sizes are capped.

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|session[_-]?id|credential)/i;
const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|bearer)["']?\s*[:=]\s*["']?)([^\s"',;)]{6,})/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
const LONG_KEY = /\b(sk|pk|rk|xox[abp]|ghp|gho|ya29|AIza)[-_A-Za-z0-9]{16,}\b/g;

/** Masks credential-looking values inside free text (code, logs, tool output). */
export function maskSecrets(text: string): string {
  return text.replace(BEARER, "$1••••").replace(LONG_KEY, "••••").replace(SECRET_ASSIGNMENT, "$1••••");
}

export function clip(value: unknown, max: number): string {
  const text = maskSecrets(typeof value === "string" ? value : value == null ? "" : String(value)).trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Only absolute https URLs are ever turned into links. */
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return undefined;
    for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, "••••");
    return url.toString();
  } catch {
    return undefined;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a JSON string when it looks like JSON; otherwise returns the input unchanged. */
export function maybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Unwraps the common envelopes tool results arrive in: LangChain ToolMessage dicts
 * ({ content }), MCP content arrays ([{ type: "text", text }]), and JSON strings.
 */
export function unwrapResult(output: unknown): unknown {
  let value = output;
  for (let depth = 0; depth < 4; depth++) {
    value = maybeJson(value);
    if (isRecord(value) && "content" in value && ("tool_call_id" in value || "type" in value || "artifact" in value)) {
      value = value.content;
      continue;
    }
    if (Array.isArray(value) && value.length > 0 && value.every((v) => isRecord(v) && v.type === "text" && "text" in v)) {
      const texts = value.map((v) => (v as { text: unknown }).text);
      value = texts.length === 1 ? texts[0] : texts.join("\n");
      continue;
    }
    break;
  }
  return value;
}

/** A Composio-style envelope ({ successful, data, error }) if the result is one. */
export function composioEnvelope(result: unknown): { successful: boolean; data: unknown; error: unknown } | null {
  if (isRecord(result) && typeof result.successful === "boolean") {
    return { successful: result.successful, data: result.data, error: result.error };
  }
  return null;
}

export function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Caps a preview's serialized size by trimming its list, keeping the true total. */
export function capList<T>(items: T[], max: number): { items: T[]; total?: number } {
  return items.length > max ? { items: items.slice(0, max), total: items.length } : { items };
}
