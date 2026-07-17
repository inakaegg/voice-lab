FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml /app/
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
COPY src /app/src
COPY scripts /app/scripts

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir ".[local,voice,deploy]"

ENV MO_PROVIDER_MODE=local
ENV MO_TTS_PROVIDER=qwen-seed-vc
ENV MODEL_CACHE_DIR=/models

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "mo_speech.api:app", "--host", "0.0.0.0", "--port", "8000"]
