FROM golang:1.26.1-bookworm AS builder

WORKDIR /src
COPY services/zoovoice/go.mod ./
RUN go mod download
COPY services/zoovoice/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/zoovoice .

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 zoovoice

WORKDIR /app
COPY --from=builder /out/zoovoice /usr/local/bin/zoovoice
COPY services/zoovoice/assets /app/assets

ENV PORT=8080 \
    ZOOVOICE_ASSETS_DIR=/app/assets \
    ZOOVOICE_LOG_PATH=/dev/stderr \
    ZOOVOICE_TIMEOUT_SECONDS=85

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/zoovoice"]
