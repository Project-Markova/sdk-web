# Build-only container for the SDK: the SDK is consumed as an npm package,
# not run as a service. This image proves the package builds in isolation.
FROM node:22-alpine AS build

WORKDIR /sdk
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS verify
WORKDIR /verify
COPY --from=build /sdk/dist ./node_modules/@markova/sdk/dist
COPY --from=build /sdk/package.json ./node_modules/@markova/sdk/package.json
RUN node -e "const { Markova } = require('@markova/sdk'); const m = new Markova({ apiKey: 'mk_live_verify', endpoint: 'https://x', flushInterval: 0 }); m.track('Verify', {}); if (m.pendingEvents() !== 1) process.exit(1); console.log('SDK verify OK');"
