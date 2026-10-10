FROM mirror.gcr.io/library/node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

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
