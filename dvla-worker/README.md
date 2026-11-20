# DVLA registration lookup Worker

Powers **Find vehicle by Reg** in `blocks/vehicle_finder.liquid`. The theme can't call DVLA
directly: the API key would be visible to every visitor, and DVLA blocks browser calls.
So the theme calls this tiny Cloudflare Worker, which keeps the key as a secret.

Shopify's GitHub sync ignores this folder. It is not part of the theme.

## Deploy (Cloudflare dashboard, no command line needed)

1. Sign up or log in at <https://dash.cloudflare.com>. The free plan is enough.
2. **Workers & Pages → Create → Create Worker** (start from "Hello World"), name it e.g. `v6-dvla-lookup`, **Deploy**.
3. **Edit code**, replace everything with the contents of `worker.js`, then **Deploy**.
4. **Settings → Variables and Secrets → Add**:
   - `DVLA_API_KEY`: type **Secret**, value = your DVLA key.
   - `DVLA_API_URL` (only if you use a *test* key): type Text,
     `https://uat.driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles`.
   - `ALLOWED_ORIGINS` (optional): defaults to `https://v6autoparts.com,https://www.v6autoparts.com`.
     Theme previews on `*.myshopify.com` and `*.shopifypreview.com` are always allowed.
5. Copy the Worker URL (e.g. `https://v6-dvla-lookup.<your-subdomain>.workers.dev`).
6. In Shopify, open **Online Store → Customize** → the *Vehicle parts finder* block (on the homepage and the
   product template) → paste it into **Registration lookup service URL** → Save.

## Check it

Opening `https://<worker-url>/?reg=AB12CDE` directly in a browser address bar returns
`{"error":"forbidden_origin"}`. That is expected, because only your shop's pages may use it.
Test from the shop's homepage instead.

## Responses

| Status | Body |
|---|---|
| 200 | `{ vehicle: { registration, make, year, firstRegistered, fuel, engineCc, engineLitres, colour, motStatus, taxStatus } }` |
| 400 | `{ error: "invalid_registration" }` |
| 404 | `{ error: "not_found" }` |
| 429 | `{ error: "busy" }` |
| 502 | `{ error: "lookup_failed" }` (see the Worker's logs) |
| 500 | `{ error: "not_configured" }` (the `DVLA_API_KEY` secret is missing) |
