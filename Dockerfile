FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/.data/workflow \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright BROWSER_EXECUTABLE=/usr/local/bin/chromium \
    XDG_CACHE_HOME=/tmp/workflow-cache XDG_CONFIG_HOME=/tmp/workflow-config
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb xauth fonts-noto-cjk \
    && node --input-type=module -e "import {symlinkSync} from 'node:fs'; import {chromium} from 'playwright-core'; symlinkSync(chromium.executablePath(), '/usr/local/bin/chromium');" \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.data && chown node:node /app/.data
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node examples ./examples
USER node
VOLUME ["/app/.data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["xvfb-run","-a","node","server.js"]
