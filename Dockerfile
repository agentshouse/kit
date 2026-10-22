FROM mirror.gcr.io/library/node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

LABEL org.opencontainers.image.source="https://github.com/agentshouse/kit" \
  org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/* \
  && cp /etc/skel/.profile /etc/profile.d/home.sh

COPY tmp/kit.tgz /tmp/kit.tgz
RUN npm install --global --ignore-scripts /tmp/kit.tgz && rm /tmp/kit.tgz

ENV HOME=/kit-home HOUSE_KIT_HOME=/kit-home SHELL=/bin/bash
WORKDIR /agents/house
ENTRYPOINT ["tini", "--", "kit"]
CMD ["resident"]
