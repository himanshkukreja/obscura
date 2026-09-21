#!/usr/bin/env bash
# Render the overlay watermark exactly as the reference player positions it.
#
# The cycle (bottom-right → top-left → center → bottom-left → top-right) and the
# session-seeded offset match Watermark.tsx. Interval is compressed from the default 15s
# to 1.6s so a short loop shows the whole schedule.
#
# The background is heavily blurred test media, not a person: this demonstrates the
# watermark, and using stock footage of a real face to advertise an interview-recording
# tool would be its own small dishonesty.
set -euo pipefail
OUT=${1:-docs/media/watermark.gif}
TXT=${2:-"recruiter@acme.com · 01a0c171"}
W=680; H=383; DUR=8; I=1.6
F="/System/Library/Fonts/Menlo.ttc"
[ -f "$F" ] || F=$(fc-match -f '%{file}' mono 2>/dev/null || echo "")

pos() { # $1 = slot index -> x:y expression for that corner
  case $1 in
    0) echo "w-tw-28:h-th-34" ;;   # bottom-right
    1) echo "28:30" ;;             # top-left
    2) echo "(w-tw)/2:(h-th)/2" ;; # center
    3) echo "28:h-th-34" ;;        # bottom-left
    4) echo "w-tw-28:30" ;;        # top-right
  esac
}

# A calm, dark, slowly drifting gradient. Colour bars would be louder than the thing the
# GIF is meant to show, and the watermark is the subject.
# The background is a STILL frame on purpose. A drifting gradient changes every pixel on
# every frame, which GIF cannot compress - it took the file from ~200 KB to 3.3 MB for
# motion nobody is looking at. Only the watermark moves, so only the watermark costs bytes.
FILTER="[0:v]scale=${W}:${H}[bg]"
PREV="bg"
for i in 0 1 2 3 4; do
  FROM=$(echo "$i * $I" | bc); TO=$(echo "($i + 1) * $I" | bc)
  XY=$(pos $i)
  FILTER="${FILTER};[${PREV}]drawtext=fontfile='${F}':text='${TXT}':fontsize=19:fontcolor=white@0.62:shadowcolor=black@0.85:shadowx=1:shadowy=1:x=${XY%%:*}:y=${XY##*:}:enable='between(t,${FROM},${TO})'[s${i}]"
  PREV="s${i}"
done
FILTER="${FILTER};[${PREV}]fps=10[out]"

BASE=$(mktemp -t obscura-wm).png
ffmpeg -y -v error -f lavfi \
  -i "gradients=size=960x540:rate=1:duration=1:c0=0x101722:c1=0x22314a:c2=0x161d2b:c3=0x0c0f15:speed=0:nb_colors=4" \
  -frames:v 1 -vf "gblur=sigma=24,eq=brightness=-0.05:contrast=1.06" "$BASE"

ffmpeg -y -v error -loop 1 -t ${DUR} -i "$BASE" \
  -filter_complex "$FILTER" -map "[out]" -f rawvideo -pix_fmt rgb24 - 2>/dev/null \
| ffmpeg -y -v error -f rawvideo -pix_fmt rgb24 -s ${W}x${H} -r 10 -i - \
    -vf "split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
    -loop 0 "$OUT"
rm -f "$BASE"

echo "$OUT  $(du -h "$OUT" | cut -f1)"
