# venue-autofill

Server-side venue-page reader for the static app: fetches a venue URL, extracts
structured fields with the Anthropic API, and imports selected photos into the
`venue-images` bucket. The browser never fetches other sites or holds a key.

## One-time setup

```powershell
# 1. Install the CLI (Windows / Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# 2. Log in (opens a browser)
supabase login

# 3. From the repo root
cd C:\Users\acsti\wedding
supabase init                                   # creates supabase/ (first time only)
supabase link --project-ref zcyomgflbojqplxuilre
```

## Secrets

Set once (or in Dashboard → Edge Functions → Secrets):

```powershell
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...     # required
supabase secrets set EXTRACT_MODEL=claude-haiku-4-5-20251001   # optional; use claude-sonnet-5 if results are thin
supabase secrets list                                  # verify
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do not set them.

## Deploy

```powershell
supabase functions deploy venue-autofill
```

Live at `https://zcyomgflbojqplxuilre.supabase.co/functions/v1/venue-autofill`.
JWT verification stays ON, so only your logged-in app can call it. Redeploy after
any edit to `index.ts`.

## Actions (POST JSON, `Authorization: Bearer <supabase session token>`)

- `{ "action": "extract", "url": "..." }`
  → `{ ok, fields, missing:[{key,label}], images:[{url}], source }`
  or `{ ok:false, error, message }` with error one of
  `blocked | js_required | timeout | fetch_failed | extract_failed | config`.
- `{ "action": "import-photos", "urls": [...] }`
  → `{ ok, photos:[{url}], skipped:[{url,reason}] }` (downloads, filters logos/
  icons/small images, uploads survivors to `venue-images`).
