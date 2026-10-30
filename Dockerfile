FROM mirror.gcr.io/library/debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4

LABEL org.opencontainers.image.source="https://github.com/agentshouse/kit" \
  org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.1.0-2+deb13u1 \
  && rm -rf /var/lib/apt/lists/* \
  && cp /etc/skel/.profile /etc/profile.d/home.sh \
  && printf 'PATH="/kit-home/kit/bin:$PATH"\n' > /etc/profile.d/kit.sh

ENV HOME=/kit-home HOUSE_KIT_HOME=/kit-home SHELL=/bin/bash NODE_USE_SYSTEM_CA=1 \
  PATH=/kit-home/kit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /agents/house
ENTRYPOINT ["tini", "--", "/kit-home/kit/bin/kit"]
CMD ["resident"]
