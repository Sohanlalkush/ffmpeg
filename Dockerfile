# Base image: lightweight Node.js
FROM node:20-alpine

# Install FFmpeg and fontconfig (required for drawtext)
RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    && rm -rf /var/cache/apk/*

# Set working directory
WORKDIR /app

# Copy package.json and install production dependencies
COPY package.json ./
RUN npm install --only=production

# Copy API code and fonts
COPY server.js ./
COPY fonts ./fonts

# Temporary directory for FFmpeg processing
RUN mkdir -p /tmp/ffmpeg
ENV TMPDIR=/tmp/ffmpeg
ENV NODE_ENV=production

# Expose API port
EXPOSE 8080

# Start Node API
CMD ["node", "server.js"]
