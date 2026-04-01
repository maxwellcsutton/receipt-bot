FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

ENV DATABASE_PATH=/app/data/receipts.db

CMD ["node", "dist/index.js"]
