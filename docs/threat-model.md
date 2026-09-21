# Threat model

## Scope and assumptions

**In scope:** the path from a private object store to a browser, the authorization around
it, and the destruction of content at end of life.

**Assumed, not provided by us:** TLS is correctly terminated; the host application's own
authentication is sound; the operator's cloud credentials are not already compromised; the
viewer's device is not attacker-controlled *with respect to the viewer* — in several
threats below the viewer **is** the potential adversary, and that is the defining
assumption of the model.

**Out of scope:** attacks on your application's login, on the viewer's OS, on the CDN
vendor's infrastructure, and cryptanalysis of AES.

## What is actually at risk

Obscura's original driving use case is video that is **somebody's personal data** —
recordings of identifiable people, viewed by a small number of authorized staff. That
shapes the whole model, and it is worth being explicit that this is a **privacy** threat
model more than an anti-piracy one.

| Asset | Sensitivity |
|---|---|
| The original source file | Highest — for personal-data video, losing it is a reportable breach |
| Storage credentials / master key | Highest |
| Content encryption keys | High — and destroying them is itself a deletion control (see T11) |
| Token signing key | High |
| Encrypted rendition segments | Medium — useless without a key, but not nothing |
| Session records and access logs | Medium — they are themselves personal data |
| Integrity and deletion records | Low confidentiality, high integrity |

## Threat matrix

| # | Actor / attack | Mitigation | Residual risk |
|---|---|---|---|
| **T1** | **Normal user** tries to download the source file — right-click, "save as", devtools rummaging | Source is a private object in a bucket with no public policy and, in the recommended two-bucket layout, no CDN path at all. Nothing served to the browser references it. The player exposes no download affordance. The only media in the network tab is a stream of encrypted segments. | **Effectively none.** Fully addressed. |
| **T2** | **Technical user** inspects requests, reads the manifest, fetches the key, scripts the rest | Segments are encrypted; the key comes from an authenticated, rate-limited, revocable endpoint; tokens expire in minutes; the source stays unreachable. | **High, and unavoidable.** An authorized viewer holds everything needed to decrypt what they are watching. They cannot reach the *original*, only a derivative, and the session that did it is logged. **For the personal-data use case this is a low-priority threat** — the viewer already has legitimate access to the content, so retaining a copy is a policy and contract problem for the operator, not something a delivery layer can solve. |
| **T3** | **Authorized user shares a link** with someone who should not see it | **This is the threat that matters most for personal-data video, because it is an accidental disclosure, not an attack.** Tokens expire in ~180 s, so a forwarded URL is dead almost immediately — a pasted link in a chat is useless by the time anyone clicks it. Sessions are revocable. Concurrent-session limits cap one identity's streams. Optional client binding means a copied URL alone is insufficient. | **Medium.** Credential sharing still works, bounded by concurrency limits and attributable to an account. Real-time re-streaming (a screen share in a video call) is not addressed by anything here. |
| **T4** | **Token thief** obtains a valid token — from a CDN log, a screenshot, a compromised extension | Short TTL. `jti` replay tracking at the key endpoint. Optional client and IP binding. Instant revocation, effective immediately at the key endpoint. Tokens are scoped to one asset and one session, never to an account. | **Low–medium.** A token used within its window grants playback of one asset until it expires. Never API access, never other assets, never the source. |
| **T5** | **Storage compromise** — an attacker obtains credentials or direct object URLs | Two-bucket separation, so a leaked delivery-bucket credential yields only *encrypted* derivatives. Content keys live in PostgreSQL wrapped by a master key, never in a bucket — so the delivery bucket alone cannot be decrypted. Least-privilege IAM; short-lived, rotated credentials. | **Critical if the *source* bucket credential leaks** — the originals are then fully exposed and nothing here prevents it. For personal-data video that is a reportable breach. Obscura's contribution is limiting blast radius and making the source credential a separate, rarely used one. Bucket security is an infrastructure problem; treat that credential accordingly. |
| **T6** | **Screen recorder** captures the rendered video | Nothing prevents this. Overlay watermarking means a recording carries the viewer's identity, which deters people who can be held accountable. | **High by design, low in priority here.** The viewers are authorized staff with a legitimate reason to see the content. Only hardware DRM raises the cost, and a camera pointed at a screen defeats that too. |
| **T7** | **Media extractor** reassembles video from segments | Requires a live, valid session (T2). Captured segments without a key are useless. The result is a derivative carrying our encoding artifacts, not the master. | **High during an active session, low afterwards.** Same reasoning as T2: this is an insider-policy concern, not a delivery-layer one. |
| **T8** | **Malicious or misconfigured CDN / cache poisoning** | Manifests are served over TLS from our edge, not the bucket; key responses are `no-store`. Signed integrity manifests let a client or auditor confirm delivered bytes match what the pipeline produced. Cache keys never include a token. | **Low.** We do not yet sign manifests for in-player verification; that is a candidate hardening. A CDN that can rewrite TLS-terminated content can still misbehave — inherent to using one. |
| **T9** | **Insider / operator** with database and server access | Content keys are wrapped by a master key held outside the database. Administrative actions are audit-logged. With KMS, key use is logged and revocable independently of database access. | **High.** An operator with both the database and the master key has everything. Inherent; the mitigation is organisational (separation of duties, KMS with independent access control), not technical. Stated plainly. |
| **T10** | **Automated abuse at scale** — scripted sessions, key-endpoint hammering, library scraping | Per-client session-creation limits, per-session key and manifest rate limits, concurrency caps, heartbeats, anomaly events. Scraping a library needs many sessions, which is visible in the access log. | **Medium.** Patient, low-rate scraping across many legitimate accounts is indistinguishable from legitimate use by anything we can observe. |
| **T11** | **Content survives a deletion request** — in a bucket replica, a backup, a CDN edge cache, or an orphaned object from a failed job | The delete job **lists storage rather than trusting the database**, so orphans are caught; re-lists to verify empty; invalidates CDN paths; and **destroys the content key**. Key destruction is the decisive control: any copy in a replica, snapshot or edge cache that we cannot physically reach becomes **permanently unreadable**. A signed deletion record attests to what was destroyed and when. | **Low, and this is Obscura's strongest deletion property.** Residual: an operator who exported plaintext media before deletion, or who backed up the *database* (holding wrapped keys) alongside the bucket. Backup policy is an operator responsibility and is called out in [privacy.md](privacy.md). |
| **T12** | **Access logs become the leak** — session records reveal who viewed whose recording, or tokens land in CDN logs | IP and user-agent default to salted hashes, not raw values. `subject_ref` is opaque. Retention is enforced by partition drops, not left to grow. Tokens are never written to our logs; `pino` redaction covers the query parameter and all credential fields. | **Medium.** Tokens will still appear in *CDN* access logs, which we do not control — bounded by a 180 s TTL and flagged to operators as sensitive. The access log is itself personal data with its own retention obligation. |

## What the matrix says

Obscura is **strong against outsiders, against the original leaking, and against content
surviving deletion** — T1, T3, T4, T5-partial, T8 and T11. For video that is personal
data, those are precisely the threats that carry legal and ethical weight.

It is **structurally weak against the authorized viewer** — T2, T6, T7. That is not a gap
to close in a later phase; it is a property of delivering decryptable video to a
general-purpose browser. **For this use case it is also the least important weakness**,
because the authorized viewer is a staff member with a legitimate reason to see the
content. The controls that matter there are contractual and organisational, and the thing
a delivery layer can usefully contribute is a complete record of who accessed what.

Any feature proposal claiming to close T6 or T7 without hardware DRM should be treated as
incorrect.

## Non-mitigations we will not ship

Disabling right-click or blocking devtools · obfuscating player JavaScript as "security" ·
blurring video on window blur · calling a metadata field a forensic watermark · any claim
that video "cannot be downloaded."

## Review cadence

Revisited whenever a delivery strategy, watermarking provider or authentication mode is
added, and at every minor release. `SECURITY.md` carries the disclosure process and
supported-version policy.
