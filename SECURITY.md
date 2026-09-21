# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on this
repository, or email the maintainer address listed in `README.md`.

Please include: what you found, how to reproduce it, what an attacker gains, and any
suggested fix. We aim to acknowledge within 3 working days and to ship a fix or a
mitigation plan within 30 days for anything rated high or critical.

## What is in scope

- Unauthorized access to source objects, renditions, content keys or playback tokens.
- Authentication or authorization bypass on any `/api/v1` or `/stream` route.
- Token forgery, replay beyond the documented bounds, or session-revocation bypass.
- Integrity or deletion records that verify when they should not.
- A verified deletion that leaves recoverable content behind.
- Secrets reaching logs, API responses, or object storage.

## What is NOT a vulnerability

These are documented properties of the system, explained in
[docs/threat-model.md](docs/threat-model.md). Reports about them will be closed with a
pointer here.

- **An authorized viewer capturing content they are authorized to watch.** Screen
  recording, devtools inspection, or scripting the same requests the player makes. HLS
  encryption is not DRM; the key necessarily reaches the player. This is a property of
  delivering decryptable video to a general-purpose browser.
- **The overlay watermark being removable via devtools.** It is deterrence, not
  prevention, and is labelled as such throughout.
- **Playback tokens appearing in CDN access logs.** A constraint of native HLS, which
  cannot attach request headers. Bounded by a short TTL and documented in
  [docs/security-model.md](docs/security-model.md).
- **An operator with both the database and the master key having full access.** Inherent;
  mitigated organisationally, not technically.

## Supported versions

Pre-1.0: only the latest release receives fixes.

## Hard rules this project holds itself to

Never log tokens, keys or credentials · never put encryption keys in object storage ·
never expose source object URLs · never use MD5 or SHA-1 for integrity · never accept
`alg: none` or symmetric JWTs from external issuers · never link FFmpeg into our process ·
never fail **open** on an authorization callback timeout.
