# Builds the server. Run it with a PostgreSQL address and a token; see docs/operations.md.
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
# The package lists that client for development only, so clear that list and install it plainly.
RUN npm pkg delete devDependencies peerDependencies peerDependenciesMeta && npm install pg@^8.13.0 && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/serve.js"]
