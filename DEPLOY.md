# Deploying Obscura on a fresh EC2 instance

Self-contained. Assumes nothing but an AWS account and a domain you control. Roughly
45 minutes end to end, most of it waiting for Docker to build.

Everything below has been run. Where something is untested, it says so.

---

## 0. What you need before starting

| | |
|---|---|
| An EC2 instance | See sizing below. **Dedicated to Obscura** — don't share it with an existing service. |
| A domain | e.g. `video.example.com`. Needed for TLS. Without it, playback tokens travel in plaintext. |
| Two S3 buckets | Created in step 2. Never one. |
| An IAM instance role | Created in step 2. |
| SSH access | Key pair for the instance. |

### Instance sizing — the thing people get wrong

Transcoding is the only expensive thing Obscura does, and it is CPU-bound. It will use
every core it is given.

| Instance | Verdict |
|---|---|
| `t3.small` / `t3.medium` | **No.** Burstable: you get ~20% of a vCPU as baseline and burn credits above it. A transcode drains the balance in minutes, then the whole box throttles. Fine for clicking around with a 10-second clip, useless for real work. |
| `c7i.large` — 2 vCPU, 4 GB | Minimum for real use. One transcode at a time. |
| **`c7i.xlarge` — 4 vCPU, 8 GB** | **Recommended start.** Comfortable for interview-length video with `WORKER_CONCURRENCY=2`. |
| `c7i.2xlarge` — 8 vCPU, 16 GB | When the queue backs up. Or add a second instance running only workers. |

Storage: **40 GB gp3**. Media lives in S3; the disk holds container images (~2 GB) and
transcode scratch — roughly 3× the largest source file, transiently.

Expect about **13 MB of stored renditions per minute of 720p video**, measured on a real
interview. If you also retain the source, add its own bitrate on top — though nothing reads
it once an asset is READY, so a lifecycle rule expiring it is usually right. See
[docs/scaling-and-cost.md](docs/scaling-and-cost.md).

OS: Amazon Linux 2023 or Ubuntu 22.04+. Commands below cover both.

### Security group

Inbound: **22** (your IP only), **80**, **443**. Nothing else.

Not 3001, not 3002, not 5432, not 6379. Under the production compose overlay those ports
are not published at all, but the security group is the layer that must hold if something
is ever misconfigured. If your account's `default` group allows `0.0.0.0/0` on all ports —
a common default — make a new group rather than using it.

---

## 1. Prepare the instance

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<instance-ip>     # or ubuntu@ on Ubuntu
```

**Amazon Linux 2023:**
```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -sSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

**Ubuntu:**
```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"
```

**Log out and back in** so the `docker` group applies, then check:

```bash
docker run --rm hello-world
nproc && free -m | head -2 && df -h / | tail -1
```

---

## 2. Storage and IAM

From your laptop, with credentials that can create buckets and roles.

### Buckets

```bash
REGION=ap-south-1
SUFFIX=acme-prod                      # must be globally unique
SRC="obscura-source-$SUFFIX"
DEL="obscura-delivery-$SUFFIX"

for B in "$SRC" "$DEL"; do
  aws s3api create-bucket --bucket "$B" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Suspended
done
```

> **Versioning is suspended deliberately.** With versioning on, deleting an object leaves
> prior versions behind, and Obscura's "verified deletion" becomes a false claim: the purge
> reports success while the content still exists. If you need versioning for other reasons,
> add a lifecycle rule that permanently expires noncurrent versions well inside your
> deletion SLA.

**Two buckets, not one.** With a single bucket, one CDN or origin-access misconfiguration
exposes the *original* file. With two, the same mistake exposes only encrypted derivatives.

### CORS — skip this and playback fails silently

Required because `DELIVERY_STRATEGY=presigned` has hls.js fetch segments **directly from
S3** via XHR. Without CORS headers the browser blocks every segment and you get an opaque
network error that looks like a bug in Obscura.

```bash
aws s3api put-bucket-cors --bucket "$DEL" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["https://video.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 3000
  }]
}'
```

`AllowedOrigins` must list every origin that will embed the player.

### Instance role

Use a role, not access keys: the SDK finds it automatically and no long-lived credential
sits on the box.

```bash
cat > /tmp/trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

cat > /tmp/perms.json <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow",
  "Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload"],
  "Resource":["arn:aws:s3:::$SRC/videos/*","arn:aws:s3:::$DEL/videos/*"]},
 {"Effect":"Allow","Action":"s3:ListBucket",
  "Resource":["arn:aws:s3:::$SRC","arn:aws:s3:::$DEL"],
  "Condition":{"StringLike":{"s3:prefix":"videos/*"}}}]}
EOF

aws iam create-role --role-name obscura-instance \
  --assume-role-policy-document file:///tmp/trust.json
aws iam put-role-policy --role-name obscura-instance \
  --policy-name ObscuraStorage --policy-document file:///tmp/perms.json
aws iam create-instance-profile --instance-profile-name obscura-instance
aws iam add-role-to-instance-profile --instance-profile-name obscura-instance \
  --role-name obscura-instance

sleep 10   # instance profiles take a moment to propagate
aws ec2 associate-iam-instance-profile --instance-id <instance-id> \
  --iam-instance-profile Name=obscura-instance
```

`s3:ListBucket` is **required, not optional**: the deletion job enumerates storage rather
than trusting the database, so it finds objects that failed jobs orphaned.

---

## 3. DNS

Point an A record at the instance's public IP. Use an **Elastic IP** — a plain public IP
changes on stop/start and silently breaks TLS renewal.

```
video.example.com.   A   <elastic-ip>
```

Confirm it has propagated before continuing. Caddy will fail to get a certificate
otherwise:

```bash
dig +short video.example.com
```

---

## 4. Configure and launch

On the instance:

```bash
git clone https://github.com/himanshkukreja/obscura.git && cd obscura
cp .env.example .env
./scripts/generate-secrets.sh >> .env     # then delete the placeholder lines above them
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
S3_ENDPOINT=                 # empty: real AWS S3
S3_PUBLIC_ENDPOINT=          # empty
S3_FORCE_PATH_STYLE=false
S3_ACCESS_KEY_ID=            # empty: use the instance role
S3_SECRET_ACCESS_KEY=

DELIVERY_STRATEGY=presigned
ALLOW_CLIENT_BOOTSTRAP=false
WORKER_CONCURRENCY=2
POSTGRES_PASSWORD=<from generate-secrets.sh>
```

`EDGE_PUBLIC_URL` must be the URL a **browser** can reach. It is baked into every manifest
and key URI. Get it wrong and playback fails with errors that point nowhere useful.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose logs -f caddy          # watch the certificate get issued
```

`NODE_ENV=production` makes the services **refuse to start** on placeholder or missing
secrets, so a misconfigured deploy fails loudly at boot rather than quietly running
insecure.

---

## 5. Mint the first API key

Bootstrap is disabled in production, so create it directly:

```bash
docker compose exec -T api node -e '
(async () => {
  const a = await import("@obscura/auth");
  const { createDeps } = await import("/app/apps/api/dist/deps.js");
  const { uuidv7 } = await import("@obscura/shared");
  const d = createDeps();
  const k = await a.generateApiKey();
  await d.repos.clients.create({ id: uuidv7(), name: "production",
    keyPrefix: k.prefix, keyHash: k.hash, scopes: ["operator"] });
  console.log(k.full);
  await d.close();
})()'
```

Store it in your secrets manager. Only the hash is kept — it is not recoverable.

---

## 6. Verify

### Reachability

```bash
curl https://video.example.com/healthz                              # {"ok":true}
curl https://video.example.com/.well-known/obscura-integrity-keys.json
curl -sI https://video.example.com | grep -i strict-transport
```

### Nothing is exposed that should not be

All of these must **fail**:

```bash
curl --max-time 5 http://<ip>:3001/healthz          # connection refused
curl --max-time 5 http://<ip>:5432                  # connection refused
curl --max-time 5 http://<ip>:6379                  # connection refused
curl https://obscura-source-acme-prod.s3.ap-south-1.amazonaws.com/   # AccessDenied
```

### End to end

```bash
export API=https://video.example.com KEY=obs_...

# upload
SZ=$(stat -c%s interview.mp4)     # stat -f%z on macOS
R=$(curl -s -X POST $API/api/v1/assets -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"original_filename\":\"interview.mp4\",\"content_type\":\"video/mp4\",\"size\":$SZ}")
ID=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["asset_id"])')
URL=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["upload"]["url"])')

curl -f -X PUT --upload-file interview.mp4 -H 'Content-Type: video/mp4' "$URL"
curl -s -X POST $API/api/v1/assets/$ID/commit -H "Authorization: Bearer $KEY"

# wait for READY
watch -n3 "curl -s $API/api/v1/assets/$ID/status -H 'Authorization: Bearer $KEY'"

# play
curl -s -X POST $API/api/v1/assets/$ID/playback-session -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"subject_ref":"u1","subject_label":"you@example.com"}'
```

Open `manifest_url` from that response in [hls.js's demo player](https://hlsjs.video-dev.org/demo/)
to confirm playback outside your own app.

### The security properties

```bash
# 1. the original is unreachable
curl -o /dev/null -w '%{http_code}\n' \
  "https://obscura-source-acme-prod.s3.ap-south-1.amazonaws.com/videos/$ID/source/original.mp4"
#    expect 403

# 2. no API response leaks it
curl -s $API/api/v1/assets/$ID -H "Authorization: Bearer $KEY" | grep -i 'source\|original'
#    expect only source_sha256

# 3. segments on the wire are ciphertext
curl -s "<segment url from the variant playlist>" | xxd | head -2
#    expect no 'styp' or 'moof'

# 4. revocation is immediate at the key endpoint
curl -X DELETE $API/api/v1/playback/$SID -H "Authorization: Bearer $KEY"
curl -o /dev/null -w '%{http_code}\n' "$EDGE/stream/$SID/key/$KID?t=$TOK"
#    expect 401, even though the token is still signature-valid

# 5. deletion is verified and the proof outlives the asset
curl -X DELETE $API/api/v1/assets/$ID -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"reason":"data_subject_request"}'
sleep 10
curl -s $API/api/v1/assets/$ID/deletion-record -H "Authorization: Bearer $KEY"
#    storageVerifiedEmpty: true, contentKeysDestroyed: 1
curl -o /dev/null -w '%{http_code}\n' $API/api/v1/assets/$ID       # 410
```

---

## 7. Integrating your application

**Never ship the API key to a browser.** Your backend mints sessions server-to-server:

```ts
const r = await fetch(`https://video.example.com/api/v1/assets/${assetId}/playback-session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OBSCURA_API_KEY}`,
             'Content-Type': 'application/json' },
  body: JSON.stringify({ subject_ref: user.id, subject_label: user.email }),
});
const session = await r.json();     // safe to hand to the browser
```

The browser loads `session.manifest_url` with hls.js and calls the heartbeat endpoint every
`session.refresh_after` seconds. `apps/player/src/Player.tsx` is a complete reference.

---

## 8. Operating it

### Backups — read this one carefully

```bash
docker compose exec -T postgres pg_dump -U obscura obscura | gzip > backup-$(date +%F).sql.gz
```

**A database backup contains `content_keys`.** Restoring one taken before a deletion
resurrects keys you attested were destroyed, silently undoing cryptographic erasure. Either
exclude that table from long-lived backups, or keep backup retention shorter than your
deletion SLA. The software cannot enforce this for you.

Equally: **back up `OBSCURA_MASTER_KEY` separately and durably.** Lose it and every asset
becomes permanently unreadable — the same property that makes deletion final, working
against you.

### Scaling and monitoring

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale worker=3
```

Workers are stateless and jobs are resumable, so spot instances suit them. `/healthz`,
`/readyz` and `/metrics` (Prometheus: assets by status, active sessions, queue depth).

### Upgrades

```bash
git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations run automatically on API start. Take a database dump first.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Caddy cannot get a certificate | DNS not propagated, or port 80 blocked. Caddy needs 80 reachable for the ACME challenge, even though traffic ends up on 443. |
| Playback fails, console shows CORS errors | The delivery bucket's CORS `AllowedOrigins` does not include the page's origin. |
| Manifest loads, segments 403 | Presigned URLs expired mid-playback. Raise `DELIVERY_PRESIGN_TTL`. |
| Everything 401s | `EDGE_PUBLIC_URL` does not match the URL the browser is using. |
| Services exit at boot | Placeholder secrets left in `.env`. This is the production guard doing its job — read the log line, it names the variable. |
| Transcodes crawl | Burstable instance out of CPU credits, or `WORKER_CONCURRENCY` above the core count. |
| `READY` never arrives | `docker compose logs worker`. Check disk: transcode scratch needs ~3× the source file. |

---

## Known gaps

- **Audio is stored once per rendition, not once per asset.** HLS supports a separate
  audio rendition group; the packager does not use it, so a three-rung ladder stores three
  copies of the same 128k track. Roughly 15% of a short asset's bytes, less on a long one.
- **No CDN.** `cdn_signed` exists as a strategy with no edge function behind it.
- **No CDN cache invalidation on delete.** The record honestly says `requested: false`;
  key destruction is what makes cached copies inert.
- **No KMS.** The master key comes from the environment.
- **API keys only** — no JWT or authorization-callback provider yet.
- **Subtitles are unencrypted** (still token-authorized).
- **Safari native HLS is unverified** against our AES-128 + fMP4 output. hls.js works; iOS
  below 17.1 has no MSE and is untested.
