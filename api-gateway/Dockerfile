# Étape 1 : compilation TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

ENV NODE_ENV=development

COPY package*.json ./
RUN npm ci --include=dev
RUN npm install --no-save --no-package-lock typescript@6.0.3

COPY . .
RUN npm run build

# Étape 2 : image finale, légère
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]