# Deployment

Covers local testing first, then a single-instance AWS EC2 deployment. Obscura runs as
ordinary containers with health endpoints and no orchestrator-specific assumptions, so
Kubernetes and ECS work too — they are just not the starting point.

---

## Part 1 — Test it locally

```bash
git clone <repo> && cd obscura
cp .env.example .env
docker compose up -d
```

Wait for health, then open <http://localhost:3000>.

```bash
# Mint the first API key. ALLOW_CLIENT_BOOTSTRAP=true only in development.
curl -sX POST localhost:3001/api/v1/admin/clients \
  -H 'Content-Type: application/json' -d '{"name":"local"}'
```

Paste the `api_key` into the player's **Connection** panel, upload a video, wait for
`READY`, press **Play**.

### Run the test suite

```bash
npm install
npm test
```

71 tests. The end-to-end suite runs against the live stack and skips itself automatically
when the stack is down, so `npm test` stays useful offline. It uses real FFmpeg, real
MinIO and real PostgreSQL — nothing about the media path is mocked.

### Check the claims yourself

Do not take the README's word for any of this.

```bash
ASSET=<asset-id>   # from the player or `curl localhost:3001/api/v1/assets -H "Authorization: Bearer $KEY"`

# 1. The original is not reachable, with or without knowing the path
curl -o /dev/null -w '%{http_code}\n' \
  "http://localhost:9000/obscura-source/videos/$ASSET/source/original.mp4"       # 403

# 2. No API response mentions it
curl -s localhost:3001/api/v1/assets/$ASSET -H "Authorization: Bearer $KEY" | grep -i source
                                                                                # only source_sha256

# 3. What the browser receives is ciphertext
curl -s "http://localhost:3002/stream/$SID/seg/720p/seg_00001.m4s?t=$TOK" | xxd | head -2

# 4. Revoking a session cuts off key access immediately, while the token is still valid
curl -X DELETE localhost:3001/api/v1/playback/$SID -H "Authorization: Bearer $KEY"
curl -o /dev/null -w '%{http_code}\n' "http://localhost:3002/stream/$SID/key/$KID?t=$TOK"  # 401

# 5. Deletion is verified, and the proof outlives the asset
curl -X DELETE localhost:3001/api/v1/assets/$ASSET -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"reason":"data_subject_request"}'
curl -s localhost:3001/api/v1/assets/$ASSET/deletion-record -H "Authorization: Bearer $KEY"
curl -o /dev/null -w '%{http_code}\n' localhost:3001/api/v1/assets/$ASSET       # 410
```

### Test that it survives a restart and a failure

```bash
docker compose restart worker          # mid-transcode: the job resumes, does not restart
docker compose logs -f worker

docker compose stop redis              # the API keeps serving; new jobs queue on recovery
docker compose start redis
```

---

## Part 2 — Deploy on EC2

### What you need

| | |
|---|---|
| Instance | `c7i.xlarge` (4 vCPU / 8 GB) is a sensible start. Transcoding is the only expensive thing Obscura does, and it is CPU-bound. `t3.medium` works for testing but will crawl on anything longer than a few minutes. |
| Storage | 40 GB gp3 root. Media lives in S3; the disk only holds container images and transcode scratch space. |
| Buckets | Two: source and delivery. Never one. |
| DNS | One A record, e.g. `video.example.com` → the instance's Elastic IP |
| Ports | 80 and 443 inbound. **Nothing else.** Not 3001, not 3002, not 5432. |

### Sizing note, because it is the thing people get wrong

A worker uses every core it can. On a 4-vCPU instance the default
`WORKER_CONCURRENCY=2` transcodes two renditions at once and will starve the API if you
raise it. Scale by adding instances or raising `WORKER_CPUS`, not by raising concurrency
past the core count. Workers are stateless and jobs are resumable, so spot instances are
appropriate for them.

### 1. Buckets and IAM

Create two buckets — never one — and lock both down:

```bash
REGION=ap-south-1
for B in obscura-source-acme obscura-delivery-acme; do
  aws s3api create-bucket --bucket "$B" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Suspended
done
```

**CORS on the delivery bucket only**, and only when using `presigned` delivery — hls.js
fetches segments by XHR, so without it the browser blocks every segment and playback fails
with an opaque network error:

```bash
aws s3api put-bucket-cors --bucket obscura-delivery-acme --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["https://video.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 3000
  }]
}'
```

> **Versioning is suspended deliberately.** With versioning on, deleting an object leaves
> prior versions behind, and "verified deletion" becomes a false claim — the purge would
> report success while the content still exists. If you need versioning, add a lifecycle
> rule that permanently expires noncurrent versions well inside your deletion SLA.

Then give the instance a role scoped to those two buckets and nothing else. Use a role
rather than access keys: the AWS SDK picks it up automatically and there is no long-lived
credential to leak.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload"],
      "Resource": ["arn:aws:s3:::obscura-source-acme/videos/*",
                   "arn:aws:s3:::obscura-delivery-acme/videos/*"] },
    { "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": ["arn:aws:s3:::obscura-source-acme",
                   "arn:aws:s3:::obscura-delivery-acme"],
      "Condition": { "StringLike": { "s3:prefix": "videos/*" } } }
  ]
}
```

`s3:ListBucket` is required, not optional: the deletion job enumerates storage rather than
trusting the database, so that it finds objects a failed job orphaned.

### 2. Instance setup

```bash
sudo dnf install -y docker git            # Amazon Linux 2023
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -sSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
# log out and back in so the docker group applies
```

### 3. Configure

```bash
git clone <repo> && cd obscura
cp .env.example .env
./scripts/generate-secrets.sh >> .env     # then DELETE the placeholder lines above them
chmod 600 .env
```

Edit `.env`:

```bash
NODE_ENV=production
DOMAIN=video.example.com
EDGE_PUBLIC_URL=https://video.example.com
CORS_ORIGINS=https://yourapp.example.com

S3_REGION=ap-south-1
S3_SOURCE_BUCKET=obscura-source-acme-prod
S3_DELIVERY_BUCKET=obscura-delivery-acme-prod
S3_ENDPOINT=
S3_PUBLIC_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_ACCESS_KEY_ID=            # leave EMPTY to use the instance role
S3_SECRET_ACCESS_KEY=

DELIVERY_STRATEGY=presigned
ALLOW_CLIENT_BOOTSTRAP=false
WORKER_CONCURRENCY=2
```

`EDGE_PUBLIC_URL` must be the URL a **browser** can reach. It is baked into every manifest
and key URI; get it wrong and playback fails with opaque errors.

### 4. Launch

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose logs -f caddy      # watch the certificate get issued
```

`NODE_ENV=production` makes the services **refuse to start** on placeholder or missing
secrets, so a misconfigured deploy fails loudly at boot rather than quietly running
insecure.

### 5. Mint the first API key

Bootstrap is disabled in production, so do it directly:

```bash
docker compose exec -T api node -e '
import("@obscura/auth").then(async (a) => {
  const { createDeps } = await import("/app/apps/api/dist/deps.js");
  const { uuidv7 } = await import("@obscura/shared");
  const d = createDeps();
  const k = await a.generateApiKey();
  await d.repos.clients.create({ id: uuidv7(), name: "production",
    keyPrefix: k.prefix, keyHash: k.hash, scopes: ["operator"] });
  console.log(k.full);
  await d.close();
})'
```

Store the output in your secrets manager. It is not recoverable — only the hash is kept.

### 6. Verify the deployment

```bash
curl https://video.example.com/healthz
curl https://video.example.com/.well-known/obscura-integrity-keys.json

# These must all fail from outside
curl --max-time 5 http://<elastic-ip>:3001/healthz     # refused
curl --max-time 5 http://<elastic-ip>:5432             # refused
curl https://obscura-source-acme-prod.s3.ap-south-1.amazonaws.com/  # AccessDenied
```

---

## Integrating your application

Your backend holds the API key and mints sessions server-to-server. **Never ship the API
key to a browser** — the reference player does so only to work without a second service,
and says so on screen.

```ts
// your backend, after YOUR authorization check
const r = await fetch(`https://video.example.com/api/v1/assets/${assetId}/playback-session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OBSCURA_API_KEY}`,
             'Content-Type': 'application/json' },
  body: JSON.stringify({ subject_ref: user.id, subject_label: user.email }),
});
const session = await r.json();   // safe to hand to the browser
```

The browser then loads `session.manifest_url` with hls.js and calls the heartbeat endpoint
every `session.refresh_after` seconds. See `apps/player/src/Player.tsx` for a complete
reference implementation.

---

## Operating it

### Backups — read this one carefully

```bash
docker compose exec -T postgres pg_dump -U obscura obscura | gzip > backup-$(date +%F).sql.gz
```

**A database backup contains `content_keys`.** Restoring a backup taken before a deletion
resurrects keys you attested were destroyed, silently undoing cryptographic erasure. Either
exclude that table from long-lived backups, or keep backup retention shorter than your
deletion SLA. This is an operator obligation the software cannot enforce for you — see
[privacy.md §5](privacy.md#5-cryptographic-erasure).

Equally: **`OBSCURA_MASTER_KEY` must be backed up separately and durably.** Lose it and
every asset becomes permanently unreadable.

### Scaling

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale worker=3
```

Workers scale independently and are the only expensive component. When one instance is not
enough, move PostgreSQL to RDS and Redis to ElastiCache, then run the API/edge and workers
on separate instances — they already share nothing but those two services and S3.

### Monitoring

`/healthz` (liveness), `/readyz` (database, storage, queue), `/metrics` (Prometheus:
assets by status, active sessions, queue depth).

### Costs

A small deployment is roughly one `c7i.xlarge`, 40 GB gp3, S3 storage and egress. Video
egress goes S3 → browser under `presigned`, so it is S3 egress, not EC2 egress. Put
CloudFront in front when that bill justifies the work — and note that per-viewer cache hit
ratios are low at small audience sizes, so measure before assuming it helps.

---

## What is not done yet

Honest list, from [roadmap.md](roadmap.md):

- **No CDN signer.** `cdn_signed` exists as a strategy but has no edge function behind it.
- **No CDN cache invalidation on delete.** The deletion record records
  `cdnInvalidation.requested: false` rather than claiming otherwise. Key destruction is
  what actually makes cached copies inert.
- **No KMS key provider.** The master key comes from the environment.
- **No JWT or callback authorization.** API keys only.
- **Subtitles are unencrypted** (still token-authorized).
- **Native HLS on Safari is unverified** with our AES-128 + fMP4 output. hls.js works;
  iOS below 17.1 has no MSE and is untested.
