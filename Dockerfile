# syntax=docker/dockerfile:1
# Builds the server. Run it with a PostgreSQL address, a token and a receipt secret; see docs/operations.md.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
# The package itself needs nothing at run time; the server needs the PostgreSQL client.
# The package lists that client for development only, so clear that list and install it plainly, at the version the lock file holds,
# with the packages it needs at theirs, so the image is built the same way twice. The lock file is read for that, and not kept.
RUN --mount=type=bind,source=package-lock.json,target=/tmp/package-lock.json \
  cp /tmp/package-lock.json ./ \
  && PG=$(node -p "require('./package-lock.json').packages['node_modules/pg'].version") \
  && npm pkg delete devDependencies peerDependencies peerDependenciesMeta && npm pkg set dependencies.pg=$PG \
  && npm install --omit=dev --no-audit --no-fund && rm package-lock.json && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/bin.js"]
