#!/usr/bin/env bash
# List assets. The CLI has `status` and `inspect` for a single asset but no way to see
# them all, which is what you want when you are looking for an id to play or delete.
#
#   OBSCURA_API=https://video.example.com OBSCURA_KEY=obs_... ./scripts/list-assets.sh
#   ./scripts/list-assets.sh --status READY
#   ./scripts/list-assets.sh --limit 100
#   ./scripts/list-assets.sh --json | jq '.data[].asset_id'
set -uo pipefail
API=${OBSCURA_API:?set OBSCURA_API}
KEY=${OBSCURA_KEY:?set OBSCURA_KEY}

LIMIT=50; FILTER=""; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --limit)  LIMIT=$2; shift 2;;
    --status) FILTER=$2; shift 2;;
    --json)   JSON=1; shift;;
    -h|--help) sed -n '2,9p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
HTTP=$(curl -s -o "$TMP" -w '%{http_code}' "$API/api/v1/assets?limit=$LIMIT" \
  -H "Authorization: Bearer $KEY")
if [ "$HTTP" != "200" ]; then
  echo "list failed (HTTP $HTTP)" >&2
  [ "$HTTP" = "401" ] && echo "  OBSCURA_KEY is missing or wrong" >&2
  exit 1
fi
if [ "$JSON" = 1 ]; then cat "$TMP"; exit 0; fi

COLS=$( (tput cols 2>/dev/null) || echo 100 )
python3 - "$TMP" "$FILTER" "$COLS" <<'PY'
import sys, json

rows = json.load(open(sys.argv[1])).get("data", [])
flt, cols = sys.argv[2].upper(), int(sys.argv[3])
if flt:
    rows = [a for a in rows if a["status"] == flt]
if not rows:
    print("no assets" + (" with status " + flt if flt else ""))
    raise SystemExit(0)

def dur(ms):
    if not ms:
        return "-"
    s = ms // 1000
    return "%d:%02d" % (s // 60, s % 60)

def size(b):
    if not b:
        return "-"
    v = float(b)
    for u in ("B", "K", "M", "G"):
        if v < 1024:
            return "%.0f%s" % (v, u)
        v /= 1024
    return "%.1fT" % v

avail = max(20, cols - 66)
print("%-38s%-10s%>7s%>8s  %s".replace("%>", "%") % ("ASSET ID", "STATUS", "DUR", "SIZE", "TITLE"))
for a in rows:
    title = a.get("title") or a.get("original_filename") or ""
    if len(title) > avail:
        title = title[:avail - 1] + "…"
    line = "%-38s%-10s%7s%8s  %s" % (
        a["asset_id"], a["status"], dur(a.get("duration_ms")), size(a.get("size")), title)
    if a.get("error_code"):
        line += "  [%s]" % a["error_code"]
    print(line)

print("\n%d asset(s)%s" % (len(rows), " with status " + flt if flt else ""))
PY
