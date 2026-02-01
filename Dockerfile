FROM node:20-alpine

RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    noto-fonts-devanagari \
    && rm -rf /var/cache/apk/*

WORKDIR /app

COPY package.json ./
RUN npm install --only=production

COPY server.js .

RUN mkdir -p /tmp/ffmpeg
ENV TMPDIR=/tmp/ffmpeg
ENV NODE_ENV=production

EXPOSE 8080
CMD ["node", "server.js"]
