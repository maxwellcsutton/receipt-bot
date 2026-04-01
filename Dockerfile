FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

RUN mkdir -p /app/data
VOLUME /app/data

ENV DATABASE_PATH=/app/data/receipts.db

CMD ["node", "dist/index.js"]
