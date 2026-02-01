FROM node:20-alpine

# Install ffmpeg + fonts
RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    noto-fonts \
    noto-fonts-extra

# App directory
WORKDIR /app

# Copy API code
COPY package.json ./
RUN npm install --only=production

COPY . .

# Temp directory for processing
RUN mkdir -p /tmp/ffmpeg

ENV TMPDIR=/tmp/ffmpeg
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
