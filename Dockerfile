FROM node:20-alpine

# Install ffmpeg + fonts (Alpine compatible)
RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    font-noto-devanagari

WORKDIR /app

COPY package.json ./
RUN npm install --only=production

COPY . .

# Temp directory for ffmpeg
RUN mkdir -p /tmp/ffmpeg

ENV TMPDIR=/tmp/ffmpeg
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
