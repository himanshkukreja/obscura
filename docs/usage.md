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

### Every way, shortest first

```bash
# by asset id
./scripts/watch-url.sh 01a0c3ca-bdc5-7354-878b-6ce6af292578

# by a fragment of the title or filename - errors if it matches more than one
./scripts/watch-url.sh "Interview 4821"

# name the viewer: this is what the watermark shows and what the access log records
./scripts/watch-url.sh "Interview 4821" recruiter@example.com

# the raw .m3u8 instead of the watch page, for VLC / ffplay / your own hls.js
./scripts/watch-url.sh --manifest 01a0c3ca-bdc5-7354-878b-6ce6af292578

# open it immediately
open "$(./scripts/watch-url.sh 'Interview 4821')"          # macOS
xdg-open "$(./scripts/watch-url.sh 'Interview 4821')"      # Linux

# onto the clipboard
./scripts/watch-url.sh "Interview 4821" | pbcopy           # macOS
./scripts/watch-url.sh "Interview 4821" | xclip -sel clip  # Linux

# newest asset, no id needed
./scripts/watch-url.sh "$(./scripts/list-assets.sh --json | jq -r '.data[0].asset_id')"
```

### Playing it

| Where | Command |
|---|---|
| Any browser, any OS | Open the `/watch` URL |
| VLC | `vlc "$(./scripts/watch-url.sh --manifest <id>)"` |
| ffplay | `ffplay "$(./scripts/watch-url.sh --manifest <id>)"` |
| mpv | `mpv "$(./scripts/watch-url.sh --manifest <id>)"` |
| Safari only | The `--manifest` URL opens directly |

**A raw `.m3u8` will not play in Chrome, Firefox or Edge.** None of them have native
HLS; the URL downloads a text file. That is a browser limitation, not a deployment
fault, and it is the reason `/watch` exists — it loads hls.js, so one link works
everywhere. Use `--manifest` only for desktop players and your own integration.

### The API call underneath

Everything above wraps one POST:

```bash
curl -s -X POST "$OBSCURA_API/api/v1/assets/$ID/playback-session" \
  -H "Authorization: Bearer $OBSCURA_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"subject_ref":"user-42","subject_label":"recruiter@example.com"}' | jq
```

```json
{
  "session_id": "s_…",
  "token": "v1.…",
  "manifest_url": "https://…/stream/s_…/master.m3u8?t=v1.…",
  "expires_at": "…",           // session: hours
  "token_expires_at": "…",     // token: minutes
  "refresh_after": 108,        // heartbeat after this many seconds
  "watermark": { "text": "recruiter@example.com · 01a0c3ca", … }
}
```

Optional fields on the request:

```bash
-d '{
  "subject_ref": "user-42",            # required. who is watching, for the access log
  "subject_label": "recruiter@x.com",  # shown in the watermark; defaults to subject_ref
  "ttl_seconds": 3600,                 # session lifetime, capped at 86400
  "client_binding": "<opaque>",        # stored as a salted hash
  "watermark": { "enabled": true, "text_template": "{{user.label}}" }
}'
```

Build a `/watch` URL from that response yourself:

```bash
S=$(curl -s -X POST "$OBSCURA_API/api/v1/assets/$ID/playback-session" \
  -H "Authorization: Bearer $OBSCURA_KEY" -H 'Content-Type: application/json' \
  -d '{"subject_ref":"user-42"}')
echo "$OBSCURA_API/watch?s=$(echo "$S" | jq -r .session_id)&t=$(echo "$S" | jq -r .token)"
```

Every call mints a **new session** — separately logged, watermarked and revocable. Do not
loop it to refresh a URL; that fills the access log with sessions nobody watched. Extend a
session instead:

```bash
curl -s -X POST "$OBSCURA_API/api/v1/playback/$SID/heartbeat" | jq -r .token
```

The heartbeat takes **no API key** — it is authorized by the session id itself. That is
what lets a watch link be shared without leaking an operator credential, and what lets the
`/watch` page refresh its own token.

### From your own application

Your backend decides who may watch and mints the session; the browser never sees the key.

```ts
const r = await fetch(`${OBSCURA}/api/v1/assets/${assetId}/playback-session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OBSCURA_API_KEY}`,
             'Content-Type': 'application/json' },
  body: JSON.stringify({ subject_ref: user.id, subject_label: user.email }),
});
const session = await r.json();     // safe to hand to the browser
```

In the browser, two things are non-negotiable, and both are easy to miss:

```js
// 1. rewrite the token on EVERY request, not just the first. A token lives ~3 minutes;
//    hls.js keeps fetching variant playlists and keys long after that.
const hls = new Hls({
  xhrSetup: (xhr, url) => {
    const u = new URL(url, location.origin);
    if (u.searchParams.has('t')) { u.searchParams.set('t', currentToken); xhr.open('GET', u.toString(), true); }
  },
});

// 2. heartbeat before refresh_after elapses, and keep currentToken updated from it
setInterval(async () => {
  const r = await fetch(`${OBSCURA}/api/v1/playback/${sid}/heartbeat`, { method: 'POST' });
  if (r.ok) currentToken = (await r.json()).token;
}, session.refresh_after * 1000);
```

`apps/player/src/Player.tsx` is the full reference; `docker/watch/index.html` is a smaller
one in plain JavaScript.

### The reference player UI

`/` lists assets and plays them, handling sessions and heartbeat for you. It needs an API
key pasted into its Connection panel, which makes it an **operator tool, not a viewer-facing
page** — gate it (see [DEPLOY.md](../DEPLOY.md)) and send viewers `/watch` links.

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
per segment, and a VOD playlist is never reloaded. Once those URLs expire playback stops
partway through, with a 403 that reads as a server fault.

At the 600 s default, **anything longer than ten minutes dies around the ten-minute mark.**
For interview-length content, match it to the session:

```
DELIVERY_PRESIGN_TTL=14400
```

Check what a deployment is actually issuing:

```bash
M=$(./scripts/watch-url.sh --manifest $ID)
V=$(curl -s "$M" | grep -m1 '^https')
curl -s "$V" | grep -m1 '^https' | tr '&' '\n' | grep X-Amz-Expires
```

The tradeoff is mild: a leaked segment URL stays valid longer, but segments are AES-128
ciphertext and useless without the content key, which stays session-gated and instantly
revocable. You extend the life of unreadable bytes, not of access.

---

## 5. Sessions: inspecting and revoking

```bash
# who watched this asset, and when
curl -s "$OBSCURA_API/api/v1/assets/$ID/access-log" \
  -H "Authorization: Bearer $OBSCURA_KEY" | jq

# kill one session
curl -s -X DELETE "$OBSCURA_API/api/v1/playback/$SID" \
  -H "Authorization: Bearer $OBSCURA_KEY" | jq

# kill every session for one person - what you reach for when someone leaves
curl -s -X DELETE "$OBSCURA_API/api/v1/playback/sessions?subject_ref=user-42" \
  -H "Authorization: Bearer $OBSCURA_KEY" | jq
```

Revocation bites at the key endpoint immediately, even while the token is still
signature-valid. Under `presigned` delivery, already-issued segment URLs keep resolving
until they expire — but they return ciphertext and the key is gone.

Watch time in the access log is **estimated** from heartbeat counts. Precise position
tracking would be behavioural profiling of the person on camera, so it is deliberately
not collected.

A watch link is a **bearer credential**: whoever holds it can watch, under the original
viewer's watermark, until it expires or is revoked. Mint one per viewer — that is what
makes the watermark and the access log mean anything.

---

## 6. Testing a deployment

A full pass, top to bottom. Every command here has been run against a live deployment.

### Setup

```bash
export OBSCURA_API=https://video.example.com
export OBSCURA_KEY=obs_...
```

### Reachability

```bash
curl -s "$OBSCURA_API/healthz"                                 # {"ok":true}
curl -s "$OBSCURA_API/.well-known/obscura-integrity-keys.json" # the public verification key
curl -sI "$OBSCURA_API" | grep -i strict-transport             # HSTS present
```

### Nothing is exposed that should not be

Each of these must fail:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$OBSCURA_API/api/v1/assets"          # 401
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://<source-bucket>.s3.<region>.amazonaws.com/"                          # 403

for p in 3001 3002 5432 6379; do                                                # all refused
  timeout 5 bash -c "echo > /dev/tcp/<instance-ip>/$p" 2>/dev/null \
    && echo "$p OPEN - PROBLEM" || echo "$p refused"
done
```

### Ingest and play

```bash
./scripts/list-assets.sh
ID=$(./scripts/list-assets.sh --json | jq -r '.data[0].asset_id')
./scripts/watch-url.sh "$ID"          # open it; it should play in any browser
```

### The security properties

```bash
# set up a session to poke at
M=$(./scripts/watch-url.sh --manifest "$ID")
SID=$(echo "$M" | sed -E 's#.*/stream/([^/]+)/.*#\1#')
V=$(curl -s "$M" | grep -m1 '^https')
KEY_URI=$(curl -s "$V" | grep -m1 'EXT-X-KEY' | sed -E 's/.*URI="([^"]+)".*/\1/')
SEG=$(curl -s "$V" | grep -m1 '^https')

# 1. the original is unreachable, with or without a link
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://<source-bucket>.s3.<region>.amazonaws.com/videos/$ID/source/original.mp4"
#    expect 403

# 2. no API response leaks the source object
curl -s "$OBSCURA_API/api/v1/assets/$ID" -H "Authorization: Bearer $OBSCURA_KEY" \
  | grep -iE 'original\.mp4|source_key|s3\.amazonaws'
#    expect no matches - only source_sha256 is exposed

# 3. segments on the wire are ciphertext
curl -s "$SEG" | head -c 64 | xxd
#    expect no 'styp', 'moof' or 'mdat'

# 4. the key endpoint returns exactly 16 bytes and is never cached
curl -s -o /dev/null -w '%{http_code} %{size_download} bytes\n' "$KEY_URI"   # 200 16 bytes
curl -sI "$KEY_URI" | grep -i cache-control                                  # no-store

# 5. revocation is immediate, while the token is still signature-valid
curl -s -X DELETE "$OBSCURA_API/api/v1/playback/$SID" -H "Authorization: Bearer $OBSCURA_KEY"
curl -s -o /dev/null -w '%{http_code}\n' "$KEY_URI"                          # 401

# 6. every artifact matches the signed manifest
obscura verify "$ID"

# 7. the integrity manifest is signed and every rendition encrypted
curl -s "$OBSCURA_API/api/v1/assets/$ID/integrity" -H "Authorization: Bearer $OBSCURA_KEY" \
  | jq '{assetRoot, signature: .signature.algorithm,
         renditions: [.renditions[] | {name, encryption: .encryption.method}]}'
```

### Verified deletion

Destructive — use a throwaway asset:

```bash
curl -s -X DELETE "$OBSCURA_API/api/v1/assets/$ID" \
  -H "Authorization: Bearer $OBSCURA_KEY" \
  -H 'Content-Type: application/json' -d '{"reason":"data_subject_request"}'

sleep 15

curl -s "$OBSCURA_API/api/v1/assets/$ID/deletion-record" \
  -H "Authorization: Bearer $OBSCURA_KEY" | jq
#    storageVerifiedEmpty: true, contentKeysDestroyed: 1, and a signature

curl -s -o /dev/null -w '%{http_code}\n' "$OBSCURA_API/api/v1/assets/$ID"    # 410
```

The deletion record outlives the asset. That is deliberate: erasing the proof of erasure
would defeat its purpose, so `deletion_records` has no retention policy.

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
