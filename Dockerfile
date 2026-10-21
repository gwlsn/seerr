# hotio's Seerr image with the app rebuilt from patched source. Everything
# hotio sets up (s6, PUID/PGID, UMASK, /config) is kept as is.
#
# Build context: a Seerr checkout at the release tag with the patch applied.
ARG BASE_IMAGE=ghcr.io/hotio/seerr:release

FROM node:22-alpine AS builder
RUN npm install -g pnpm@10
COPY . /build
WORKDIR /build
RUN CYPRESS_INSTALL_BINARY=0 pnpm install --frozen-lockfile && \
    pnpm build && \
    pnpm cache delete && \
    rm -rf config .next/cache

FROM ${BASE_IMAGE}
ARG VERSION
# /app/config is hotio's symlink to /config, so it is left alone.
RUN find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name config -exec rm -rf {} +
COPY --from=builder /build/ "${APP_DIR}/"
RUN echo '{"commitTag": "'"${VERSION}"'"}' > "${APP_DIR}/committag.json" && \
    chmod -R u=rwX,go=rX "${APP_DIR}"
