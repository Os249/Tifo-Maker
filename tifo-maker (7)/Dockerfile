# Tifo Maker — single-image deploy (serves the built SPA + the API together).
FROM node:20-slim

WORKDIR /app

# Install dependencies first (layer-cached unless package files change).
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy source and build the frontend into dist/.
COPY . .
RUN npm run build:prod

# The server (run via tsx) serves dist/ and the API from one origin.
ENV NODE_ENV=production
EXPOSE 8787

# Health check hits the existing GET /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
