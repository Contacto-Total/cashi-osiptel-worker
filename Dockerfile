# ============================================================
# cashi-osiptel-worker - Container Node.js + Playwright Chromium
# ============================================================
# Imagen base: la oficial de Playwright (Chromium + deps de SO ya instaladas)
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS build

WORKDIR /app

# Cache de dependencias
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ----- Runtime stage -----
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS runtime

WORKDIR /app

# Solo dependencias de producción
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

# Usuario no root (la imagen de Playwright trae 'pwuser')
USER pwuser

ENV NODE_ENV=production \
    PORT=8090

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
