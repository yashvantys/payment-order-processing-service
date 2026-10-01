# ---------- Build stage ----------
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./

# Copy Prisma files before npm ci because
# package.json runs "npx prisma generate" in postinstall
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npm ci

COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src

RUN npm run build


# ---------- Production stage ----------
FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

# Prisma schema/config must exist before npm ci
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]