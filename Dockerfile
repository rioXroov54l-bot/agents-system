FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.build
EXPOSE 3000
CMD ["node", "server.js"]
