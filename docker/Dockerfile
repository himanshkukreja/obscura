# Single image for api, edge and worker; the command selects the role.
#
# LICENSING: this image installs a distro FFmpeg build. Practically every prebuilt FFmpeg
# is compiled with --enable-gpl (required for libx264), making that binary GPLv2+.
# Distributing this image therefore carries GPLv2 obligations FOR THAT COMPONENT: ship the
# licence texts and be able to point at corresponding source.
#
# Obscura's own code is unaffected because ffmpeg is invoked as a SEPARATE PROCESS over a
# command line - never linked. Do not replace the subprocess with a native binding: that
# would silently change the project's licence position. See docs/research.md.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json      packages/shared/
COPY packages/storage/package.json     packages/storage/
COPY packages/media/package.json       packages/media/
COPY packages/encryption/package.json  packages/encryption/
COPY packages/integrity/package.json   packages/integrity/
COPY packages/db/package.json          packages/db/
COPY packages/auth/package.json        packages/auth/
COPY packages/delivery/package.json    packages/delivery/
COPY apps/api/package.json             apps/api/
COPY apps/edge/package.json            apps/edge/
COPY apps/worker/package.json          apps/worker/
COPY apps/cli/package.json             apps/cli/
RUN npm ci --omit=optional --ignore-scripts || npm install --ignore-scripts

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/edge/ apps/edge/
COPY apps/worker/ apps/worker/
COPY apps/cli/ apps/cli/

RUN npx tsc --build && npm link ./apps/cli 2>/dev/null || true

ENV NODE_ENV=production MEDIA_WORK_DIR=/tmp/obscura
RUN mkdir -p /tmp/obscura && useradd -r -u 10001 obscura && chown -R obscura /tmp/obscura /app
USER obscura

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/index.js"]
