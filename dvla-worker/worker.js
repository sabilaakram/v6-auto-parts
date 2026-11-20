/**
 * V6 Auto Parts -- DVLA registration lookup proxy (Cloudflare Worker).
 *
 * Why this exists: DVLA's Vehicle Enquiry API needs a secret API key and does not
 * allow calls from browsers, so the theme calls this Worker instead, and the Worker
 * calls DVLA with the key stored as a Cloudflare secret (never in theme code).
 *
 *   GET https://<your-worker>.workers.dev/?reg=AB12CDE
 *   -> 200 { vehicle: { registration, make, year, firstRegistered, fuel, engineCc,
 *                       engineLitres, colour, motStatus, taxStatus } }
 *   -> 400 { error: "invalid_registration" }   bad format
 *   -> 404 { error: "not_found" }              DVLA has no such vehicle
 *   -> 429 { error: "busy" }                   DVLA rate limit hit
 *   -> 502 { error: "lookup_failed" }          anything else from DVLA
 *
 * Settings (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets):
 *   DVLA_API_KEY     (Secret, required)   your DVLA key
 *   ALLOWED_ORIGINS  (Text, optional)     comma list, default "https://v6autoparts.com,https://www.v6autoparts.com"
 *                                         (*.myshopify.com and *.shopifypreview.com are always allowed, for theme previews)
 *   DVLA_API_URL     (Text, optional)     defaults to the live DVLA endpoint; set to the uat. URL for a test key
 */

const DEFAULT_DVLA_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const DEFAULT_ORIGINS = 'https://v6autoparts.com,https://www.v6autoparts.com';
const CACHE_SECONDS = 60 * 60 * 24; // a reg's DVLA record rarely changes; saves API calls

function allowedOrigin(origin, env) {
  if (!origin) return '';
  const list = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.(myshopify\.com|shopifypreview\.com)$/i.test(origin)) return origin;
  return '';
}

function respond(body, status, origin, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    ...(extraHeaders || {}),
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function slimVehicle(d) {
  const cc = Number(d.engineCapacity) || null;
  return {
    registration: d.registrationNumber || null,
    make: d.make || null,
    year: Number(d.yearOfManufacture) || null,
    firstRegistered: d.monthOfFirstRegistration || null,
    fuel: d.fuelType || null,
    engineCc: cc,
    engineLitres: cc ? (Math.round(cc / 100) / 10).toFixed(1) : null,
    colour: d.colour || null,
    motStatus: d.motStatus || null,
    taxStatus: d.taxStatus || null,
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request.headers.get('Origin') || '', env);

    if (request.method === 'OPTIONS') return respond(null, 204, origin);
    if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405, origin);
    // Browsers on other websites are refused. (Not a hard security boundary -- a script
    // can fake Origin -- but it stops other sites using your DVLA quota from their pages.)
    if (!origin) return respond({ error: 'forbidden_origin' }, 403, '');
    if (!env.DVLA_API_KEY) return respond({ error: 'not_configured' }, 500, origin);

    const url = new URL(request.url);
    const reg = (url.searchParams.get('reg') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{2,8}$/.test(reg)) return respond({ error: 'invalid_registration' }, 400, origin);

    // Edge cache per registration (works on a custom domain; a no-op on *.workers.dev).
    const cache = caches.default;
    const cacheKey = new Request(new URL('/__vehicle/' + reg, url.origin).toString());
    const cached = await cache.match(cacheKey);
    if (cached) return respond(await cached.json(), 200, origin);

    let upstream;
    try {
      upstream = await fetch(env.DVLA_API_URL || DEFAULT_DVLA_URL, {
        method: 'POST',
        headers: { 'x-api-key': env.DVLA_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ registrationNumber: reg }),
      });
    } catch (err) {
      return respond({ error: 'lookup_failed' }, 502, origin);
    }

    if (upstream.status === 200) {
      const body = { vehicle: slimVehicle(await upstream.json()) };
      ctx.waitUntil(
        cache.put(cacheKey, new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + CACHE_SECONDS },
        }))
      );
      return respond(body, 200, origin);
    }
    if (upstream.status === 404) return respond({ error: 'not_found' }, 404, origin);
    if (upstream.status === 400) return respond({ error: 'invalid_registration' }, 400, origin);
    if (upstream.status === 429) return respond({ error: 'busy' }, 429, origin);

    console.log('DVLA error', upstream.status, await upstream.text().catch(() => ''));
    return respond({ error: 'lookup_failed' }, 502, origin);
  },
};
