#!/usr/bin/env bash
# Generate test media with ffmpeg. The repository carries this script, not binaries.
#
# Media is never mocked in the test suite: a mocked ffmpeg proves nothing about the part
# most likely to be wrong.
set -euo pipefail
cd "$(dirname "$0")"
FF=${FFMPEG_PATH:-ffmpeg}

gen() {
  local name=$1; shift
  [ -f "$name" ] && { echo "  $name (cached)"; return; }
  echo "  $name"
  "$FF" -y -v error "$@" "$name"
}

echo "generating fixtures..."

# Talking-head shaped: low motion, 720p, with audio. The primary happy path.
gen basic-720p.mp4 \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
  -f lavfi -i "sine=frequency=440:duration=12" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest

# Must NOT be upscaled by the ladder.
gen low-360p.mp4 \
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:duration=6" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest

# No audio stream at all.
gen no-audio.mp4 \
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=6" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p

# Portrait: aspect ratio must be preserved, dimensions must stay even.
gen portrait.mp4 \
  -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=440:duration=6" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest

# Container variety.
gen clip.mov -f lavfi -i "testsrc2=size=640x360:rate=25:duration=5" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p
gen clip.mkv -f lavfi -i "testsrc2=size=640x360:rate=25:duration=5" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p
gen clip.webm -f lavfi -i "testsrc2=size=640x360:rate=25:duration=5" \
  -c:v libvpx-vp9 -b:v 300k -cpu-used 8

# Audio with no video: must be rejected.
gen audio-only.m4a -f lavfi -i "sine=frequency=440:duration=5" -c:a aac

# Not a video at all: must be rejected without a crash.
printf 'this is not a video file' > corrupt.mp4
: > empty.mp4

echo "done"
