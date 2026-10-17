FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Only the app itself goes into the image. The vault (database, encrypted files, key file)
# lives on a mounted volume at /data and must never be baked into an image.
COPY package.json server.js export.js ./
COPY public ./public

ENV MEDVAULT_DATA_DIR=/data
EXPOSE 4000

# Run node directly rather than through npm so SIGTERM from the host reaches the server.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
