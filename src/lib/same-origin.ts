// Where a request to the API came from, as the browser says. A session cookie rides along on
// requests other sites make (a form post, a link, a popup), so anything that changes something
// has to come from the app's own pages.

type Request = { headers: Headers };

function sameHost(origin: string, request: Request): boolean {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** From the app's own pages (or typed in), by the browser's word: what a write needs. */
export function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return fetchSite === "same-origin";
  return sameHost(origin, request);
}

/**
 * Marked by the browser as coming from another site. For a GET that changes something anyway
 * (one that charges voice time, say): a same-origin GET can carry neither Sec-Fetch-Site nor
 * Origin (older Safari), so only what the browser marks as from elsewhere is refused.
 */
export function isCrossSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = request.headers.get("origin");
  return origin !== null && !sameHost(origin, request);
}
