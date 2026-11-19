FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && ffmpeg -version >/dev/null \
  && ffprobe -version >/dev/null \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.ts ./server.ts
COPY server ./server
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    STORAGE_ROOT=/data

EXPOSE 8080
CMD ["npm", "start"]
