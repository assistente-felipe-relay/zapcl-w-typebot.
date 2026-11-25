FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY relay.mjs media.mjs controls.mjs ./
USER node
CMD ["node", "relay.mjs"]
