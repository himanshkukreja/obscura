# Using it

How to get video in, and how to get a playable URL out — from the UI, the CLI, or the API.

Everything here has been run against a live deployment. Where something does not work the
way you would expect, it says so and says why.

---

## 0. The one thing to understand first

**There is no permanent stream URL, and that is the point.**

A stream URL is minted per viewer, carries a token that expires in minutes, is watermarked
with that viewer's identity, and can be revoked while it is playing. An asset does not
*have* a URL; you generate one at the moment someone is authorized to watch.

Equally: **Obscura does not serve videos that already exist in a bucket.** The source key
is generated per asset, and there is no pass-through mode, because every video has to be
transcoded, encrypted and hashed before it can be delivered. A bucket of existing
recordings is a library you ingest *from*, not something Obscura can point at.

---

## 1. Credentials

Two different secrets, easily confused:

| | What it is | Who holds it |
|---|---|---|
| **API key** (`obs_…`) | Operator credential. Mints sessions, ingests, deletes. | Your **backend**. Never a browser. |
| **Playback token** (`v1.…`) | One viewer, one session, minutes long. | The browser, in the URL. |

```bash
export OBSCURA_API=https://video.example.com
export OBSCURA_KEY=obs_...
```

In production `ALLOW_CLIENT_BOOTSTRAP=false`, so the reference player's **Generate API
Key** button is deliberately dead and the endpoint 404s. This is correct: that endpoint has
no authentication of its own, and an open key-minting endpoint on a public host hands
anyone an operator key. Mint keys server-side ([DEPLOY.md §5](../DEPLOY.md)) and paste them
in.

---

## 2. Getting video in

### CLI

```bash
obscura upload interview.mp4 --title "Interview 4821"
obscura status <asset-id>          # poll until READY
```

### API

Three calls. The API never carries upload bytes — the browser or your backend PUTs
straight to storage with a short-lived presigned URL, and `commit` is the trust boundary
where the API independently `HEAD`s the object.

```bash
# 1. create - returns a presigned PUT
R=$(curl -s -X POST "$OBSCURA_API/api/v1/assets" \
  -H "Authorization: Bearer $OBSCURA_KEY" -H 'Content-Type: application/json' \
  -d '{"original_filename":"interview.mp4","content_type":"video/mp4","size":12345678}')
ID=$(echo "$R" | jq -r .asset_id)

# 2. upload the bytes directly to storage
curl -f -X PUT --upload-file interview.mp4 -H 'Content-Type: video/mp4' \
  "$(echo "$R" | jq -r .upload.url)"

# 3. commit - nothing is processed before this
curl -s -X POST "$OBSCURA_API/api/v1/assets/$ID/commit" -H "Authorization: Bearer $OBSCURA_KEY"

# then poll
curl -s "$OBSCURA_API/api/v1/assets/$ID/status" -H "Authorization: Bearer $OBSCURA_KEY" | jq
```

`READY` is a promise: every rendition exists, every hash verifies, the manifest is signed.
It never appears on partial output.

### From another bucket

There is no server-side adopt. Pull, then push:

```bash
aws s3 cp s3://recordings/interview.mp4 - | obscura upload /dev/stdin --title "Interview"
```

Be aware this leaves **two copies** of the source: yours and Obscura's. After `READY`
nothing reads Obscura's copy — not playback, not deletion, not `obscura verify`, which only
re-hashes the delivery bucket — so it can be lifecycle-expired. Before doing that, read
[privacy.md §5](privacy.md): a copy outside Obscura is a copy outside its deletion
guarantee, and cryptographic erasure only covers what Obscura encrypted.

---

## 2b. Finding an asset

```bash
./scripts/list-assets.sh                 # id, status, duration, size, title
./scripts/list-assets.sh --status FAILED # just the ones that went wrong
./scripts/list-assets.sh --limit 100
./scripts/list-assets.sh --json | jq -r '.data[].asset_id'
```

The CLI has `status` and `inspect` for a single asset but no way to enumerate, which is
what you want when you are hunting for an id to play or delete. The two scripts compose:

```bash
./scripts/watch-url.sh "$(./scripts/list-assets.sh --json | jq -r '.data[0].asset_id')"
```

Or skip the id entirely — `watch-url.sh` accepts a fragment of a title or filename and
resolves it, erroring rather than guessing when a fragment matches more than one asset.

```bash
./scripts/watch-url.sh "Interview 4821"
```

The raw endpoint is `GET /api/v1/assets?limit=N`, cursor-paginated via `next_cursor`. It
deliberately returns no `source_key`, `source_bucket`, or any URL to the original.

---

## 3. Getting a playable URL out

### The short version

```bash
./scripts/watch-url.sh <asset-id> recruiter@example.com
```

Prints a `/watch?s=…&t=…` URL that plays **in any browser on any OS**. Open it, send it,
embed it.

### Why not just use the manifest URL

Because `.m3u8` only plays natively in Safari and on iOS. Chrome, Firefox and Edge have no
HLS support at all — paste a manifest URL into Chrome and it downloads a text file. That is
a browser limitation; no server-side change fixes it.

The `/watch` page loads [hls.js](https://github.com/video-dev/hls.js), which implements HLS
over Media Source Extensions, and falls back to native HLS on Safari. It also keeps the
session alive, which a pasted URL cannot do.

If you want the raw manifest anyway — for VLC, ffplay, or your own hls.js integration:

```bash
./scripts/watch-url.sh --manifest <asset-id>
ffplay "$(./scripts/watch-url.sh --manifest <asset-id>)"
```

### The API call underneath

One POST. Everything else is convenience around it.

```bash
curl -s -X POST "$OBSCURA_API/api/v1/assets/$ID/playback-session" \
  -H "Authorization: Bearer $OBSCURA_KEY" -H 'Content-Type: application/json' \
  -d '{"subject_ref":"user-42","subject_label":"recruiter@example.com"}' | jq
```

```json
{
  "session_id": "s_…",
  "token": "v1.…",
  "manifest_url": "https://…/stream/s_…/master.m3u8?t=v1.…",
  "expires_at": "…",           // session: hours
  "token_expires_at": "…",     // token: minutes
  "refresh_after": 108,        // call heartbeat after this many seconds
  "watermark": { "text": "recruiter@example.com · 01a0c3ca", … }
}
```

Every call mints a **new session** — separately logged, watermarked and revocable. Do not
loop it to "refresh" a URL; that accumulates sessions against the asset's access log. To
extend one session, use the heartbeat:

```bash
curl -s -X POST "$OBSCURA_API/api/v1/playback/$SID/heartbeat" | jq -r .token
```

The heartbeat endpoint takes **no API key** — it is authorized by the session id itself.
That is deliberate, and it is what lets a watch link be shared without leaking an operator
credential.

### From your own application

The shape that matters in production: your backend decides who may watch, mints the
session, and hands the browser something that cannot be escalated.

```ts
const r = await fetch(`${OBSCURA}/api/v1/assets/${assetId}/playback-session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OBSCURA_API_KEY}`,
             'Content-Type': 'application/json' },
  body: JSON.stringify({ subject_ref: user.id, subject_label: user.email }),
});
const session = await r.json();      // safe to hand to the browser
```

Then load `session.manifest_url` with hls.js and call the heartbeat every
`session.refresh_after` seconds. `apps/player/src/Player.tsx` is a complete reference; the
`/watch` page in `docker/watch/index.html` is a smaller one.

### The UI

The reference player at `/` lists assets and plays them, handling sessions and heartbeat
for you. It needs an API key pasted into its Connection panel, which means **it is an
operator tool, not something to put in front of viewers** — gate it (see
[DEPLOY.md](../DEPLOY.md)) and send viewers `/watch` links instead.

---

## 4. Timeouts, and the one that will catch you

Three independent clocks:

| Setting | Default | Governs |
|---|---|---|
| `PLAYBACK_TOKEN_TTL` | 180 s | How long a token authorizes manifest and key fetches |
| `PLAYBACK_SESSION_TTL` | 4 h | How long the session can be refreshed before dying |
| `DELIVERY_PRESIGN_TTL` | 600 s | How long presigned segment URLs stay valid (`presigned` mode) |

**`DELIVERY_PRESIGN_TTL` must exceed the duration of your longest video.** Under
`DELIVERY_STRATEGY=presigned` the media playlist is generated once, with a presigned URL
per segment. A VOD playlist is not reloaded, so once those URLs expire, playback stops —
partway through, with a 403 that looks like a server fault.

At the 600 s default, **anything longer than ten minutes dies around the ten-minute mark.**
For interview-length content set it to match the session:

```
DELIVERY_PRESIGN_TTL=14400
```

The tradeoff is mild: a leaked segment URL stays valid longer, but segments are AES-128
ciphertext and useless without the content key, which stays session-gated and instantly
revocable. You are extending the life of unreadable bytes, not of access.

---

## 5. Revoking

```bash
curl -X DELETE "$OBSCURA_API/api/v1/playback/$SID" -H "Authorization: Bearer $OBSCURA_KEY"
curl -X DELETE "$OBSCURA_API/api/v1/playback/sessions?subject_ref=user-42" \
  -H "Authorization: Bearer $OBSCURA_KEY"     # everything for one person
```

Revocation bites at the key endpoint immediately, even while the token is still
signature-valid. Under `presigned` delivery, already-issued segment URLs keep resolving
until they expire — but they return ciphertext, and the key is gone.

A watch link is a **bearer credential**: whoever holds it can watch, under the original
viewer's watermark, until it expires or is revoked. Mint one per viewer.

---

## 6. Testing a deployment

```bash
curl "$OBSCURA_API/healthz"                                    # {"ok":true}
curl "$OBSCURA_API/.well-known/obscura-integrity-keys.json"    # public verification key
```

These must **fail**:

```bash
curl -o /dev/null -w '%{http_code}\n' \
  "https://<source-bucket>.s3.<region>.amazonaws.com/videos/$ID/source/original.mp4"   # 403
curl -o /dev/null -w '%{http_code}\n' "$OBSCURA_API/api/v1/assets"                     # 401
```

Then walk the properties that matter:

```bash
# segments on the wire are ciphertext - no styp, no moof
curl -s "<segment url from the variant playlist>" | xxd | head -2

# the key endpoint returns exactly 16 bytes and is never cached
curl -sI "<key uri>" | grep -i cache-control        # no-store

# revocation is immediate
curl -X DELETE "$OBSCURA_API/api/v1/playback/$SID" -H "Authorization: Bearer $OBSCURA_KEY"
curl -o /dev/null -w '%{http_code}\n' "<key uri>"   # 401

# every artifact matches the signed manifest
obscura verify $ID

# deletion is verified, and the proof outlives the asset
obscura delete $ID --reason data_subject_request
curl -s "$OBSCURA_API/api/v1/assets/$ID/deletion-record" -H "Authorization: Bearer $OBSCURA_KEY"
curl -o /dev/null -w '%{http_code}\n' "$OBSCURA_API/api/v1/assets/$ID"    # 410
```

---

## 7. When it does not work

| Symptom | Cause |
|---|---|
| Manifest URL downloads a file / blank page in Chrome | `.m3u8` has no native support outside Safari. Use a `/watch` link. |
| Playback stops partway through a long video, 403 on segments | `DELIVERY_PRESIGN_TTL` is shorter than the video. See §4. |
| Everything 401s | `EDGE_PUBLIC_URL` does not match the URL the browser is using. |
| Key endpoint 401 but the token has not expired | The session was revoked. That is the design working. |
| **Generate API Key** does nothing | `ALLOW_CLIENT_BOOTSTRAP=false`. Correct in production — mint server-side. |
| CORS errors on segments | The delivery bucket's `AllowedOrigins` omits the page's origin. |
| `READY` never arrives | `docker compose logs worker`. Transcode scratch needs ~3× the source file. |
| Ladder has fewer rungs than expected | `max_bitrate_ratio` drops rungs targeting more bits than the source has. Working as intended — a low-bitrate source cannot yield a high-quality rendition. |
