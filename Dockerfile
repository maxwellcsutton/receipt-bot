FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

RUN mkdir -p /app/data

ENV DATABASE_PATH=/app/data/receipts.db

CMD ["node", "dist/index.js"]
