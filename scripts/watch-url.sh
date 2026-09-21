#!/usr/bin/env bash
# Mint a playback session and print a URL you can open in any browser.
#
# The built-in CLI can ingest and verify but cannot mint a session, so this covers the
# gap. Accepts an asset id or a fragment of a title/filename.
#
#   OBSCURA_API=https://video.example.com OBSCURA_KEY=obs_... ./scripts/watch-url.sh <asset-id>
#   ./scripts/watch-url.sh "Interview 4821" recruiter@example.com
#   ./scripts/watch-url.sh --manifest <asset-id>     # raw .m3u8 instead of the watch page
#
# Default output is the /watch page, because a raw .m3u8 only plays in Safari.
set -uo pipefail
API=${OBSCURA_API:?set OBSCURA_API}
KEY=${OBSCURA_KEY:?set OBSCURA_KEY}

MODE=watch
if [ "${1:-}" = "--manifest" ]; then MODE=manifest; shift; fi
Q=${1:?usage: watch-url.sh [--manifest] <asset-id|title-fragment> [viewer]}
WHO=${2:-viewer@example.com}

if [[ ! "$Q" =~ ^[0-9a-f]{8}-[0-9a-f]{4}- ]]; then
  Q=$(curl -s "$API/api/v1/assets?limit=100" -H "Authorization: Bearer $KEY" | python3 -c "
import sys, json
frag = sys.argv[1].lower()
hits = [a for a in json.load(sys.stdin).get('data', [])
        if a['status'] == 'READY'
        and frag in ((a.get('title') or '') + ' ' + (a.get('original_filename') or '')).lower()]
if not hits:
    sys.stderr.write('no READY asset matching: ' + sys.argv[1] + '\n'); raise SystemExit(1)
if len(hits) > 1:
    sys.stderr.write('ambiguous, matches:\n' + '\n'.join(
        '  %s  %s' % (a['asset_id'], a.get('title') or a.get('original_filename')) for a in hits) + '\n')
    raise SystemExit(1)
print(hits[0]['asset_id'])" "$Q") || exit 1
fi

curl -s -X POST "$API/api/v1/assets/$Q/playback-session" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"subject_ref\":\"$WHO\",\"subject_label\":\"$WHO\"}" \
  | MODE="$MODE" API="$API" python3 -c "
import sys, os, json, urllib.parse
d = json.load(sys.stdin)
if 'session_id' not in d:
    sys.stderr.write(json.dumps(d, indent=2) + '\n'); raise SystemExit(1)
if os.environ['MODE'] == 'manifest':
    print(d['manifest_url'])
else:
    q = {'s': d['session_id'], 't': d['token']}
    wm = (d.get('watermark') or {}).get('text')
    if wm: q['w'] = wm
    print(os.environ['API'].rstrip('/') + '/watch?' + urllib.parse.urlencode(q))"
