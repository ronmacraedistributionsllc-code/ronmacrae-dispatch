# Production image: API + built web (served via WEB_DIST) + prisma client.
# The zero-service preview (DEV_DB=1, QUEUE_DRIVER=memory) runs from this image
# without postgres/redis; set QUEUE_DRIVER=bullmq + REDIS_URL to use them.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/geo/package.json packages/geo/
COPY packages/money/package.json packages/money/
COPY packages/notifications/package.json packages/notifications/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/scripts ./apps/api/scripts
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
EXPOSE 3000
ENV WEB_DIST=/app/apps/web/dist
CMD ["node", "apps/api/dist/main.js"]
