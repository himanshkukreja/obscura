# Obscura

**Private video delivery without handing out the original file.**

The open-source video delivery layer for S3-compatible storage.

> **Status: working MVP.** Ingest, transcode, encrypt, authorize, play, verify and
> provably delete all run end to end. 70 tests pass against real FFmpeg, MinIO, PostgreSQL
> and Redis. Not yet hardened for production — see [docs/roadmap.md](docs/roadmap.md).

---

## What is this?

A self-hostable service that sits between private object storage (AWS S3, Cloudflare R2,
MinIO, any S3-compatible store) and a web browser. You give it a source video; it produces
an adaptive-bitrate HLS rendition set, keeps the original private, and serves playback
only to viewers your application has explicitly authorized — for a limited time, through a
revocable session, over encrypted segments, with a full access trail and a signed record
of everything it produced and everything it destroyed.

It is a **primitive you embed**, not a video platform. Your application decides *who may
watch what*. Obscura decides *how those bytes reach the browser safely* — and how they
stop existing when you say so.

## Why does it exist?

Obscura was built for a case that turns out to be common: **video that is somebody's
personal data.** It came out of an AI interview platform, where every recording is a
candidate's face and voice, viewed by a handful of recruiters, and subject to deletion
rights that have to actually work.

The default answers are all wrong for that. Making the object public hands out the
original permanently. A long-lived presigned URL does the same thing more slowly. The
commercial platforms that solve it properly (Mux, Cloudflare Stream, DRM vendors) are
closed, priced per minute, and hold your media — which is exactly the wrong shape when the
media is regulated personal data you're accountable for.

If your video is medical, legal, educational, HR, financial, or otherwise about a person,
this is aimed at you.

## What it protects against

| | |
|---|---|
| The original file leaking | The source object is never addressable by a browser. Nothing served references it. |
| Link sharing | Playback is bound to a short-lived, revocable session — not a URL that lives forever. |
| Bucket enumeration / hotlinking | Storage stays private. Delivery URLs are signed and expire in minutes. |
| Cached or at-rest segment theft | Segments are AES-encrypted; keys come only from an authenticated, live session. |
| "Who watched this, and when?" | Every session is recorded with a full access trail. |
| "Prove you deleted it." | Verified purge with a signed deletion record — including cryptographic erasure of the content key, which makes any copy you *couldn't* reach permanently unreadable. |
| "Is this the file you produced?" | Every artifact is SHA-256 hashed into a Merkle tree and signed by the pipeline. |

## What it does NOT protect against

**If a browser can decrypt and display the content, a sufficiently capable viewer can
capture it.** That is a property of the medium, not a gap in this project. Obscura cannot
stop:

- **Screen recording.** Any authorized viewer can record their own screen. Only
  hardware-backed DRM raises that cost, and even then a camera pointed at a display wins.
- **An authorized viewer keeping a copy.** The decryption key necessarily reaches the
  player. Standard HLS encryption is **not** DRM — see [docs/encryption.md](docs/encryption.md).
- **Segment reassembly.** Someone who can watch can script the same requests and re-mux
  the result, for as long as their session is valid.
- **Compromise of your own storage credentials.** See [docs/threat-model.md](docs/threat-model.md), T5.

We will never claim video "cannot be downloaded." The goal is that the original never
leaves, access is always accounted for, every grant is small and short-lived, and deletion
is provable. The full accounting is in [docs/threat-model.md](docs/threat-model.md).

## How does it work?

```
                     ┌───────────────────────────┐
                     │      Your application     │
                     │   users, auth, business   │
                     └─────────────┬─────────────┘
                                   │ 1. "may this user watch asset X?"  (your call)
                                   │ 2. POST /playback-session          (server-to-server)
                                   ▼
                     ┌───────────────────────────┐
                     │      Obscura API          │   sessions · tokens · keys
                     │    (stateless, small)     │   manifests · integrity · deletion
                     └──────┬─────────────┬──────┘
            session-scoped  │             │ enqueue
            manifest + key  │             ▼
                            │      ┌─────────────┐      ┌──────────────┐
                            │      │   Worker    │─────▶│  FFmpeg /    │
                            │      │  (queue)    │◀─────│  FFprobe     │
                            │      └──────┬──────┘      └──────────────┘
                            │             │ writes HLS + integrity
                            ▼             ▼
                     ┌───────────┐  ┌──────────────────┐
                     │  Browser  │  │  Object storage  │  private buckets
                     │  hls.js   │  │  S3 / R2 / MinIO │  source + renditions
                     └─────┬─────┘  └────────▲─────────┘
                           │                 │ origin
                           │   ┌─────────────┴─────────────┐
                           └──▶│         CDN (optional)    │  media bytes only
                               └───────────────────────────┘
```

The API authorizes and issues short-lived, session-scoped manifests and keys. **Media
bytes never flow through the API** in the recommended configurations. See
[docs/architecture.md](docs/architecture.md).

### Processing pipeline

```
source → ffprobe → validate → SHA-256 → ladder decision → FFmpeg transcode
       → HLS/CMAF packaging → AES encryption → per-artifact hashing
       → Merkle root → signed integrity manifest → upload → READY
```

## Quickstart

No AWS account, no R2 account, no CDN. MinIO stands in for object storage.

```bash
git clone <repo> && cd obscura
cp .env.example .env
docker compose up -d
```

Then open <http://localhost:3000>, mint an API key, upload a video and watch it play:

```bash
# Mint the first API key (demo only - ALLOW_CLIENT_BOOTSTRAP=true in .env)
curl -sX POST localhost:3001/api/v1/admin/clients \
  -H 'Content-Type: application/json' -d '{"name":"local"}'
```

Paste the returned `api_key` into the player's Connection panel.

### Or drive it from the CLI

```bash
export OBSCURA_API=http://localhost:3001 OBSCURA_KEY=obs_...

obscura upload interview.mp4 --title "Interview 4821"
obscura status  <asset-id>          # poll until READY
obscura verify  <asset-id>          # re-hash every object against the signed manifest
obscura delete  <asset-id> --reason data_subject_request
```

### What you can check for yourself

```bash
# The original is not reachable, with or without a link
curl -o /dev/null -w '%{http_code}\n' \
  http://localhost:9000/obscura-source/videos/<asset-id>/source/original.mp4   # 403

# Segments on the wire are real ciphertext
curl -s "http://localhost:3002/stream/<sid>/seg/720p/seg_00001.m4s?t=<token>" | xxd | head -1

# Revoke a session; the key endpoint refuses immediately, token still signature-valid
curl -X DELETE localhost:3001/api/v1/playback/<sid> -H "Authorization: Bearer $OBSCURA_KEY"

# Delete, then read the signed record - it outlives the asset
curl localhost:3001/api/v1/assets/<asset-id>/deletion-record -H "Authorization: Bearer $OBSCURA_KEY"
```

## Repository layout

```
apps/
  api/      control plane   - assets, sessions, integrity, deletion
  edge/     data plane      - session manifests, content keys, byte proxy
  worker/   processing      - probe, transcode, encrypt, hash, purge
  player/   reference player - React + hls.js
  cli/      obscura
packages/
  shared/ storage/ media/ encryption/ integrity/ db/ auth/ delivery/
```

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Stack, components, request flows, pipeline, storage layout, deployment |
| [docs/research.md](docs/research.md) | Open-source survey, standards research, license analysis |
| [docs/security-model.md](docs/security-model.md) | Tokens, sessions, delivery authorization, CDN integration |
| [docs/threat-model.md](docs/threat-model.md) | Threat actors, mitigation/residual-risk matrix |
| [docs/privacy.md](docs/privacy.md) | Data inventory, retention, verified deletion, controller/processor split |
| [docs/encryption.md](docs/encryption.md) | AES-128 vs SAMPLE-AES vs CENC vs DRM; key management; crypto-shredding |
| [docs/watermarking.md](docs/watermarking.md) | Overlay watermarking, and why burn-in is not the default |
| [docs/integrity.md](docs/integrity.md) | Hashing, Merkle trees, signed provenance; what a hash does and does not prove |
| [docs/data-model.md](docs/data-model.md) | PostgreSQL schema proposal |
| [docs/api.md](docs/api.md) | REST API design |
| [docs/roadmap.md](docs/roadmap.md) | MVP definition and post-MVP phases |
| [docs/testing.md](docs/testing.md) | Test strategy, fixture matrix, required tests |
| [docs/deployment.md](docs/deployment.md) | Local testing, EC2 deployment, operating it |
| [docs/adr/](docs/adr/README.md) | Architecture decision records (12) |

## Non-goals

Live streaming. User management. A web CMS. Proprietary DRM in the core. Anything that
turns this into "a giant video platform."

## License

Apache-2.0 (planned). See [docs/research.md](docs/research.md#6-license-analysis) for why,
and for the FFmpeg licensing rules contributors must follow.
