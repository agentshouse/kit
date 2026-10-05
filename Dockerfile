FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

LABEL org.opencontainers.image.source="https://github.com/agentshouse/kit" \
  org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/* \
  && cp /etc/skel/.profile /etc/profile.d/home.sh

COPY tmp/kit.tgz /tmp/kit.tgz
RUN npm install --global --ignore-scripts /tmp/kit.tgz && rm /tmp/kit.tgz

ENV HOME=/kit-home HOUSE_KIT_HOME=/kit-home SHELL=/bin/bash
WORKDIR /agents/house
ENTRYPOINT ["kit"]
CMD ["resident"]
