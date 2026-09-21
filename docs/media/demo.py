"""
Scenes for the README GIFs.

Every output line here was captured from a running stack. Nothing is invented. If
behaviour changes, re-capture and regenerate rather than editing these strings.
"""

# ── 1. ingest → play ────────────────────────────────────────────────────────
QUICKSTART = [
    ("cmd", "docker compose up -d", 0),
    ("out", "{d} ✔ postgres   ✔ redis   ✔ minio   ✔ api   ✔ edge   ✔ worker   ✔ player{/}", 14),

    ("cmd", "obscura upload interview-4821.mp4", 0),
    ("out", "{d} uploading 12.4 MB straight to object storage…{/}", 8),
    ("out", "{d} the API never carries the bytes{/}", 10),
    ("out", ' {w}asset_id{/}  01a0c171-b759-7b2e-9e37-aa6251118218\n {w}status{/}    UPLOADED', 12),

    ("cmd", "obscura status 01a0c171 --watch", 0),
    ("out", "{d} VALIDATING   probe · validate · sha-256{/}", 7),
    ("out", "{d} PROCESSING   720p ▓▓▓▓▓▓▓▓▓▓ 480p ▓▓▓▓▓▓▓▓▓▓ 360p ▓▓▓▓▓▓▓▓▓▓{/}", 7),
    ("out", "{d} PACKAGING    master.m3u8 · merkle tree · ed25519 signature{/}", 7),
    ("out", " {g}READY{/}        3 renditions · AES-128 · integrity signed", 22),
]

# ── 2. what a viewer actually receives ──────────────────────────────────────
DELIVERY = [
    ("cmd", "curl -o /dev/null -w '%{http_code}' $S3/videos/$ID/source/original.mp4", 0),
    ("out", " {r}403{/}  {d}the original is not addressable. not by a link, not by anyone.{/}", 20),

    ("cmd", "curl $EDGE/stream/$SID/720p/playlist.m3u8?t=$TOKEN", 0),
    ("out", "{d}#EXTM3U{/}\n{d}#EXT-X-VERSION:7{/}\n{d}#EXT-X-TARGETDURATION:4{/}", 3),
    ("out", "{y}#EXT-X-KEY{/}:METHOD={g}AES-128{/},URI=\"…/key/81b9c628?t={m}«token»{/}\"", 4),
    ("out", "{y}#EXT-X-MAP{/}:URI=\"…/seg/720p/init.mp4?t={m}«token»{/}\"", 3),
    ("out", "{d}#EXTINF:4.000000,{/}", 16),

    ("cmd", "curl $EDGE/stream/$SID/seg/720p/seg_00001.m4s?t=$TOKEN | xxd | head -3", 0),
    ("out", "{d}00000000:{/} 902e f9d6 90e9 fd7a 92ee 524c 52ff e24e  {d}.......z..RLR..N{/}", 2),
    ("out", "{d}00000010:{/} 0468 96fa cd61 6251 0275 1c2d 0828 3c43  {d}.h...abQ.u.-.(<C{/}", 2),
    ("out", "{d}00000020:{/} 1a45 df68 2ddc 36b9 c320 490f 3df0 2480  {d}.E.h-.6.. I.=.$.{/}", 4),
    ("out", " {g}ciphertext{/} {d}— no styp, no moof. useless without a live session.{/}", 24),
]

# ── 3. revoke → delete → prove it ───────────────────────────────────────────
REVOKE_DELETE = [
    ("cmd", "curl -X DELETE $API/api/v1/playback/$SID", 0),
    ("out", ' {d}{"session_id":"s_aY6XOnWY…","revoked":{/}{g}true{/}{d}}{/}', 12),

    ("cmd", "curl -o /dev/null -w '%{http_code}' $EDGE/stream/$SID/key/81b9c628?t=$TOKEN", 0),
    ("out", " {r}401{/}  {d}the token is still signature-valid. the key endpoint is not.{/}", 22),

    ("cmd", "curl -X DELETE $API/api/v1/assets/$ID -d '{\"reason\":\"data_subject_request\"}'", 0),
    ("out", "{d} enumerating storage — not trusting the database…{/}", 8),
    ("out", "{d} destroying content key · invalidating cache · re-listing…{/}", 10),
    ("out", ' {w}objectsDeleted{/}          {g}19{/}   {d}(including 1 orphan no row referenced){/}', 3),
    ("out", ' {w}storageVerifiedEmpty{/}    {g}true{/}', 3),
    ("out", ' {w}contentKeysDestroyed{/}    {g}1{/}    {d}(every surviving copy is now unreadable){/}', 3),
    ("out", ' {w}signature{/}               {g}Ed25519{/}', 16),

    ("cmd", "curl -o /dev/null -w '%{http_code}' $API/api/v1/assets/$ID", 0),
    ("out", " {r}410{/}  {d}gone{/}", 10),
    ("cmd", "curl -o /dev/null -w '%{http_code}' $API/api/v1/assets/$ID/deletion-record", 0),
    ("out", " {g}200{/}  {d}the proof outlives the asset. that is the point of it.{/}", 26),
]

# ── 4. integrity ────────────────────────────────────────────────────────────
INTEGRITY = [
    ("cmd", "obscura verify 01a0c171", 0),
    ("out", "{d} fetching signed manifest · re-hashing every object in storage…{/}", 12),
    ("out", ' {w}assetRoot{/}      d7efb2dfb436602807022f5367adcfd620b039ac…', 2),
    ("out", ' {w}sourceSha256{/}   f852f3e08c6cd67c6236781a094bc73e87dd280f…', 2),
    ("out", ' {w}renditions{/}     720p·3  480p·3  360p·3   {d}all AES-128{/}', 2),
    ("out", ' {w}signature{/}      {g}valid{/}  {d}Ed25519 · obscura-integrity{/}', 3),
    ("out", " {g}OK{/}  {d}39 objects checked, all byte-identical{/}", 18),
    ("out", "", 1),
    ("out", "{d} a hash proves byte identity. it says nothing about whether a{/}", 3),
    ("out", "{d} re-encoded copy elsewhere came from this video.{/}", 26),
]
