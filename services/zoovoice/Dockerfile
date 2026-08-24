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
# 形態素解析のkagomeとIPA辞書は配布imageへ入るため、そのLICENSEと
# mecab-ipadicのNOTICEを一緒に取り出す。NOTICEは再配布の条件そのものである。
RUN install -d /out/licenses \
    && cp "$(go list -m -f '{{.Dir}}' github.com/ikawaha/kagome/v2)/LICENSE" \
        /out/licenses/LICENSE-kagome \
    && cp "$(go list -m -f '{{.Dir}}' github.com/ikawaha/kagome-dict)/LICENSE" \
        /out/licenses/LICENSE-kagome-dict \
    && cp "$(go list -m -f '{{.Dir}}' github.com/ikawaha/kagome-dict/ipa)/LICENSE" \
        /out/licenses/LICENSE-kagome-dict-ipa \
    && cp "$(go list -m -f '{{.Dir}}' github.com/ikawaha/kagome-dict/ipa)/NOTICE.txt" \
        /out/licenses/NOTICE-mecab-ipadic.txt

FROM debian:bookworm-slim

ARG WHISPER_SOURCE_COMMIT
ARG ZOOVOICE_ASR_MODEL_SHA256

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && install -d --mode=0755 /app/licenses /app/models /app/sounds \
    && useradd --create-home --uid 10001 zoovoice

WORKDIR /app
COPY --from=service-builder /out/zoovoice /usr/local/bin/zoovoice
COPY --from=whisper-builder /src/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper_source LICENSE /app/licenses/LICENSE-whisper.cpp
COPY --from=service-builder /out/licenses/ /app/licenses/
COPY --from=zoovoice_runtime --chmod=0444 ggml-small.bin /app/models/ggml-small.bin
# 鳴き声素材はリポジトリに置かず、build時に zoovoice_sounds context から取り込む。
COPY --from=zoovoice_sounds . /app/sounds
# ディレクトリは r-x、ファイルは r-- にする（--chmod は両方へ同じ値を当てるため使わない）。
RUN chmod -R a=rX /app/sounds
RUN printf '%s  %s\n' "$ZOOVOICE_ASR_MODEL_SHA256" /app/models/ggml-small.bin | sha256sum --check --strict

LABEL org.opencontainers.image.licenses="MIT, CC0-1.0, CC-BY-4.0, LicenseRef-Taira-Komori, LicenseRef-mecab-ipadic" \
    io.voicelab.zoovoice.whisper.commit="$WHISPER_SOURCE_COMMIT" \
    io.voicelab.zoovoice.asr-model.sha256="$ZOOVOICE_ASR_MODEL_SHA256"

ENV PORT=8080 \
    ZOOVOICE_SOUNDS_DIR=/app/sounds \
    ZOOVOICE_WHISPER_COMMAND=/usr/local/bin/whisper-cli \
    ZOOVOICE_ASR_MODEL_PATH=/app/models/ggml-small.bin \
    ZOOVOICE_LOG_PATH=/dev/stderr \
    ZOOVOICE_TIMEOUT_SECONDS=85

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/zoovoice"]
