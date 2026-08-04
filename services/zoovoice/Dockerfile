# syntax=docker/dockerfile:1.7

FROM debian:bookworm-slim AS whisper-builder

ARG WHISPER_SOURCE_COMMIT

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates cmake g++ make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/whisper.cpp
COPY --from=whisper_source . ./
RUN cmake -S . -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DGGML_NATIVE=OFF \
        -DGGML_OPENMP=OFF \
        -DGGML_BUILD_NUMBER=0 \
        -DGGML_BUILD_COMMIT=$WHISPER_SOURCE_COMMIT \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build build --config Release --parallel 2 --target whisper-cli

FROM golang:1.26.1-bookworm AS service-builder

WORKDIR /src/services/zoovoice
COPY services/zoovoice/go.mod services/zoovoice/go.sum ./
RUN go mod download
COPY services/zoovoice/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/zoovoice .

FROM debian:bookworm-slim

ARG WHISPER_SOURCE_COMMIT
ARG ZOOVOICE_ASR_MODEL_SHA256
ARG ZOOVOICE_CONCEPTNET_INDEX_SHA256
ARG ZOOVOICE_ANIMAL_LEXICON_SHA256

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && install -d --mode=0755 /app/assets /app/data /app/licenses /app/models \
    && useradd --create-home --uid 10001 zoovoice

WORKDIR /app
COPY --from=service-builder /out/zoovoice /usr/local/bin/zoovoice
COPY --from=whisper-builder /src/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper_source LICENSE /app/licenses/LICENSE-whisper.cpp
COPY --from=zoovoice_runtime --chmod=0444 LICENSE-CONCEPTNET.md /app/licenses/LICENSE-CONCEPTNET.md
COPY --from=zoovoice_runtime --chmod=0444 NOTICE-STABILITY-AI.md /app/licenses/NOTICE-STABILITY-AI.md
COPY --from=zoovoice_runtime --chmod=0444 ggml-small.bin /app/models/ggml-small.bin
COPY --from=zoovoice_runtime --chmod=0444 conceptnet-ja-5.7.0.sqlite /app/data/conceptnet-ja-5.7.0.sqlite
COPY services/zoovoice/assets /app/assets
RUN printf '%s  %s\n' "$ZOOVOICE_ASR_MODEL_SHA256" /app/models/ggml-small.bin | sha256sum --check --strict \
    && printf '%s  %s\n' "$ZOOVOICE_CONCEPTNET_INDEX_SHA256" /app/data/conceptnet-ja-5.7.0.sqlite | sha256sum --check --strict \
    && printf '%s  %s\n' "$ZOOVOICE_ANIMAL_LEXICON_SHA256" /app/assets/animal-lexicon.json | sha256sum --check --strict

LABEL org.opencontainers.image.licenses="MIT, CC-BY-SA-4.0, CC0-1.0, Stability-AI-Community" \
    io.voicelab.zoovoice.whisper.commit="$WHISPER_SOURCE_COMMIT" \
    io.voicelab.zoovoice.asr-model.sha256="$ZOOVOICE_ASR_MODEL_SHA256" \
    io.voicelab.zoovoice.conceptnet-index.sha256="$ZOOVOICE_CONCEPTNET_INDEX_SHA256" \
    io.voicelab.zoovoice.animal-lexicon.sha256="$ZOOVOICE_ANIMAL_LEXICON_SHA256"

ENV PORT=8080 \
    ZOOVOICE_ASSETS_DIR=/app/assets \
    ZOOVOICE_WHISPER_COMMAND=/usr/local/bin/whisper-cli \
    ZOOVOICE_ASR_MODEL_PATH=/app/models/ggml-small.bin \
    ZOOVOICE_CONCEPTNET_INDEX_PATH=/app/data/conceptnet-ja-5.7.0.sqlite \
    ZOOVOICE_LOG_PATH=/dev/stderr \
    ZOOVOICE_TIMEOUT_SECONDS=85

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/zoovoice"]
