FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node faapp_2.js rooms.js datastore.js busforecast.js backfill.js records.js ./
COPY --chown=node:node staticfile_public ./staticfile_public
RUN mkdir /app/data && chown node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "faapp_2.js"]
