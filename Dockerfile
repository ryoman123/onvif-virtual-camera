# -------------------------
# Stage 1: Base runtime
# -------------------------
FROM node:20-alpine AS base

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
RUN apk add --no-cache ffmpeg
COPY . .

# -------------------------
# Stage 2: Development image
# -------------------------
FROM base AS dev

# Install useful tools
RUN apk add --no-cache \
    bash \
    curl \
    iproute2 \
    busybox-extras \
    bind-tools \
    net-tools

CMD ["node", "main.js"]

# -------------------------
# Stage 3: Production image
# -------------------------
FROM base AS prod

CMD ["node", "main.js"]
