FROM node:22-slim

WORKDIR /app

RUN groupadd --gid 10001 flowtwin \
  && useradd --uid 10001 --gid 10001 --shell /usr/sbin/nologin --create-home flowtwin

COPY package.json server.mjs index.html app.js service-intent.js ./
COPY lib ./lib
COPY assets ./assets

RUN mkdir -p /app/runtime && chown -R 10001:10001 /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4182

USER 10001:10001

EXPOSE 4182

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4182) + '/api/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
