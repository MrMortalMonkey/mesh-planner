# Mesh Planner — zero-dependency Node app, no build step.
# Node 22+ required for the built-in node:sqlite (per-link SNR observations).
FROM node:22-alpine

WORKDIR /app
COPY server.js mqtt-live.js linkstore.js protolite.js localnode-tcp.js ./
COPY public ./public

ENV PORT=8620 \
    DATA_DIR=/data

# prepare the data dir BEFORE declaring it a volume (post-VOLUME changes are
# discarded at build time), and run unprivileged via the image's 'node' user
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8620
USER node

CMD ["node", "server.js"]
