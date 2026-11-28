# Builds the review app, the pages staff work in. Build it from the repository root:
#   docker build -f apps/review/Dockerfile -t account-graph-review .
# Run it with the graph's address and a session secret. See docs/review-app.md.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
COPY apps/review/package.json apps/review/package-lock.json ./apps/review/
RUN npm --prefix apps/review ci
# The pages quote three guides, and the demo stage shares its stylesheet.
COPY docs/report.md docs/operations.md docs/calls.md ./docs/
COPY examples/firm ./examples/firm
COPY apps/review ./apps/review
RUN npm --prefix apps/review run build

FROM node:22-alpine
WORKDIR /app
# Inside a container the app answers on every address, and the port map decides who reaches it.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY apps/review/package.json apps/review/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/review/server.mjs ./
COPY --from=build /app/apps/review/build ./build
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:3000/signin >/dev/null || exit 1
CMD ["node", "server.mjs"]
