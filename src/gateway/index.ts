/**
 * src/gateway/index.ts — barrel for the HTTP/Web gateway.
 */
export { fetchUrl, UA, DEFAULT_TIMEOUT_MS, MAX_REDIRECTS, MAX_BODY_BYTES } from "./http.js";
export type { FetchOpts, FetchResult } from "./http.js";
export { assertUrlAllowed, assertDnsAllowed, isBlockedIp, fenceWebContent, SsrfBlockedError } from "./security.js";
export { readCache, writeCache, cacheFile } from "./cache.js";
export type { CacheEntry } from "./cache.js";
export { fetchRobots, isDisallowed, RobotsBlockedError } from "./robots.js";
export { extractReadable, MAX_CHARS } from "./readability.js";
export type { ExtractedPage } from "./readability.js";
