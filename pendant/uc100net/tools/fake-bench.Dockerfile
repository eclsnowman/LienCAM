FROM debian:trixie-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 iproute2 libicu76 libssl3t64 libstdc++6 zlib1g && rm -rf /var/lib/apt/lists/*
RUN ln -s /usr/bin/python3 /usr/local/bin/python
