# Architecture viewer for the OpenClaw factory (fork addition, see FORK.md).
# Built from the same commit the factory nodes pin in skills.sources.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git tar && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY skills/seecode skills/seecode
COPY viewer viewer
USER node
ENV PORT=17318 SEECODE_DATA=/data SEECODE_BOARDS=/config/boards.json
EXPOSE 17318
CMD ["node", "viewer/server.mjs"]
