import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export type FeedValidators = { etag?: string; lastModified?: string };
export type FeedFetchResult = { status: 200; text: string; etag?: string; lastModified?: string } | { status: 304 };
export function normalizeFeedUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim().replace(/^webcal:/i, "https:")); } catch { throw new Error("Enter a valid HTTPS calendar URL."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash || url.hostname.length > 253 || input.length > 4096) throw new Error("Calendar URLs must use HTTPS without credentials, fragments, or custom ports.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (!isIP(host) && !host.includes(".")) || (isIP(host) && !isPublicAddress(host))) throw new Error("Calendar host must be a public internet address.");
  return url.toString();
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes("%")) return false;
  // Only global unicast; exclude transition, protocol-assignment and documentation ranges.
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1,-1);
  const first = parseInt(canonical.split(":")[0],16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  return !(canonical.startsWith("2001:") && parseInt(canonical.split(":")[1] || "0",16) < 0x200) && !canonical.startsWith("2001:db8:") && !canonical.startsWith("2002:") && !canonical.startsWith("3fff:");
}
type Response = { status: number; headers: Record<string,string | undefined>; body: Buffer };
export type FeedFetchDependencies = {
  resolve: (hostname: string) => Promise<Array<{address:string;family:number}>>;
  transport: (url: URL, address: {address:string;family:number}, headers: Record<string,string>, signal: AbortSignal) => Promise<Response>;
};
const dependencies: FeedFetchDependencies = {
  resolve: hostname => lookup(hostname, {all:true, verbatim:true}),
  transport: (url, address, headers, signal) => new Promise((resolve,reject) => {
    const req = request(url, { method:"GET", headers, signal, agent:false, family:address.family, lookup: (_host,_options,callback) => { callback(null,address.address,address.family); } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("error",reject);
      response.on("data", (chunk:Buffer) => { size += chunk.length; if(size > MAX_FEED_BYTES) { response.destroy(new Error("Calendar exceeds the 2 MB limit.")); } else chunks.push(chunk); });
      response.on("end", () => resolve({status:response.statusCode ?? 0, headers:Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k,Array.isArray(v)?v[0]:v])), body:Buffer.concat(chunks)}));
    });
    req.on("error",reject); req.end();
  }),
};
export async function fetchFeed(input: string, validators: FeedValidators = {}, injected: FeedFetchDependencies = dependencies): Promise<FeedFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),10_000);
  const aborted = new Promise<never>((_, reject)=>controller.signal.addEventListener("abort",()=>reject(new Error("Calendar request timed out.")),{once:true}));
  try {
    return await Promise.race([aborted, (async () => {
      let url = new URL(normalizeFeedUrl(input));
      const originalOrigin = url.origin;
      for(let redirects=0; redirects<=3; redirects++) {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await injected.resolve(host);
        if(controller.signal.aborted) throw new Error("Calendar request timed out.");
        if(!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) throw new Error("Calendar host must resolve only to public internet addresses.");
        const headers: Record<string,string> = {accept:"text/calendar", "accept-encoding":"identity", "user-agent":"Quasar-Calendar/1.0"};
        if(url.origin === originalOrigin) {
          if(validators.etag && !/[\r\n]/.test(validators.etag)) headers["if-none-match"] = validators.etag;
          if(validators.lastModified && !/[\r\n]/.test(validators.lastModified)) headers["if-modified-since"] = validators.lastModified;
        }
        const result = await injected.transport(url,addresses[0],headers,controller.signal);
        if([301,302,303,307,308].includes(result.status)) {
          if(redirects === 3 || !result.headers.location) throw new Error("Calendar redirected too many times or without a destination.");
          url = new URL(normalizeFeedUrl(new URL(result.headers.location,url).toString())); continue;
        }
        if(result.status === 304) return {status:304} as const;
        if(result.status !== 200) throw new Error(`Calendar server returned HTTP ${result.status}.`);
        // Request uncompressed content and reject servers that ignore that request.
        if(result.headers["content-encoding"] && result.headers["content-encoding"] !== "identity") throw new Error("Calendar server must return uncompressed content.");
        if(result.body.length > MAX_FEED_BYTES) throw new Error("Calendar exceeds the 2 MB limit.");
        return {status:200,text:result.body.toString("utf8"),etag:result.headers.etag,lastModified:result.headers["last-modified"]} as const;
      }
      throw new Error("Calendar redirect failed.");
    })()]);
  } finally {clearTimeout(timeout); controller.abort();}
}
