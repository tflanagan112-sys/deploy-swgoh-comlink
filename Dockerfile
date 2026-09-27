FROM ghcr.io/swgoh-utils/swgoh-comlink:latest

ENV TINI_SUBREAPER=true \
    APP_NAME=thrawns-plan \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --start-period=10s --interval=30s --timeout=5s --retries=3 CMD ["/swgoh-comlink", "--check"]
