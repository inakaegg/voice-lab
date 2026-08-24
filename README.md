# Voice Lab

[![CI](https://github.com/inakaegg/voice-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/inakaegg/voice-lab/actions/workflows/ci.yml)
[![Secret scan](https://github.com/inakaegg/voice-lab/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/inakaegg/voice-lab/actions/workflows/secret-scan.yml)

🇯🇵 日本語ドキュメント: [README.ja.md](README.ja.md)

Voice Lab is a voice web app with two features: SpeakLoop for pronunciation practice and Zoovoice for animal-call synthesis.

SpeakLoop, the main feature, turns what you say in your native language into pronunciation practice in Chinese or English. Recording, generation of a study sentence and a model voice, repetition, and comparison all happen in one flow.

Zoovoice transcribes a free-form Japanese recording and picks one animal the utterance evokes. It returns your speech with that animal's call layered into the pauses.

**Live demo:** [https://voice-lab.inakaegg.workers.dev/](https://voice-lab.inakaegg.workers.dev/)

## Screens

| Portal | SpeakLoop practice screen |
| --- | --- |
| ![Voice Lab portal](docs/images/portal-1440.png) | ![SpeakLoop practice screen](docs/images/speakloop-1440.png) |

## Demo videos

A roughly two-minute demo recorded on a real smartphone. It generates a model voice in "your own voice" from what you said, then compares the practice result as text and audio.

**English**

https://github.com/user-attachments/assets/018a157d-28b2-45fd-bac4-ab462f4cee9d

**Chinese**

https://github.com/user-attachments/assets/4ef52293-8252-48bd-b1ae-0f942a24930d

## Why I built it

I am a Japanese speaker studying Chinese. Textbook sentences rarely match what I actually want to say, so I built a practice loop that starts from my own words instead. I use it for my own study, and it doubles as a portfolio piece showing how I design, test, and operate a product end to end.

## What it does

### SpeakLoop — pronunciation practice

1. Record what you want to say in your native language
2. Generate a sentence and a model voice in the language you are learning
3. Record yourself saying that sentence
4. Compare the model and your repetition, as text and as audio

The model and your repetition are analyzed with timestamp-aligned ASR. The app shows the heard-word differences between the model and your repetition, with phrase-level playback positions. You can alternate playback of the full sentence or replay from the exact phrase you care about.

With the optional "own voice" mode, the app references only your own recording from the same submission. It converts the model voice into AI-generated audio close to your own voice quality. When conversion is not possible, practice continues with the standard model voice.

### Zoovoice — animal-call synthesis

1. Record free-form Japanese speech
2. One animal is automatically associated from what you said
3. Play or download your speech with the animal's call layered into the pauses

Japanese ASR, animal association, and synthesis run on a private Go service on Google Cloud Run. An LLM (OpenAI API) picks one animal from those with available recordings. All bundled calls are real recordings licensed for free commercial use.

## Architecture

```mermaid
flowchart LR
    Browser[Browser\nSpeakLoop / Zoovoice] --> Worker[Cloudflare Worker\nStatic Assets / Auth / Quota / API Gateway]
    Worker --> OpenAI[OpenAI API\nASR / Translation / TTS]
    Worker --> RunPod[Private RunPod Serverless\nChinese ASR / Voice Conversion]
    Worker --> CloudRun[Private Google Cloud Run\nZoovoice Go Service\nJapanese ASR / Animal Association / Mixing]
    Worker --> KV[Workers KV\nSettings / Short-lived Jobs / Fallback]
    Worker --> D1[D1\nQuota / Audit]
```

- API keys for OpenAI and RunPod never reach the browser. They live in Worker secrets or server-side environment variables.
- The public deployment handles Google login, per-feature quotas, input limits, and a simple audit log in the Cloudflare Worker.
- Chinese pronunciation comparison and optional voice conversion temporarily send only the required audio to a private RunPod Serverless backend.
- Zoovoice audio processing runs on a private Go service on Google Cloud Run (whisper.cpp, OpenAI API, ffmpeg). The Worker relays to it with Google IAM authentication.
- Zoovoice uses Cloudflare Turnstile against automated access, with shared usage limits managed in D1.
- The public Cloudflare deployment does not store user input audio or generated audio as Voice Lab history.
- Checks that require GPU billing are separated from the request, job, and error handling that a fake model can verify.

## Three engineering decisions

The parts I would walk through first in a code review.

**1. A fake provider keeps GPUs and billing out of tests.** The speech pipeline sits behind a provider interface. Local tests and CI run against a fake provider that returns fixed responses independent of input. Request handling, job state, and error paths are verified without a GPU or an API key. GPU-dependent smoke checks run manually with minimal input, only after the model-independent tests pass.

**2. Secrets scanning runs at three independent stages.** Gitleaks runs at pre-commit on staged diffs and at pre-push on the entire Git history. GitHub Actions re-scans independently on every push and pull request. A hook skipped on one machine still gets caught before anything ships.

**3. The Worker is the privacy boundary.** The browser never receives OpenAI or RunPod API keys. The Cloudflare Worker holds all credentials, enforces auth and quotas, and forwards only the audio a request needs to the private backends. The public deployment keeps no history of user audio.

## Local setup

Use Python 3.11+ and Node.js 22.18+. The minimal setup runs the UI/API with the fake provider:

```sh
python3 -m pip install -e ".[dev]"
npm ci
PYTHONPATH=src python3 -m uvicorn mo_speech.api:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/` in a browser. The fake provider is for UI/API verification and returns fixed responses independent of input.

Optional extras by purpose:

```sh
# Local ASR / translation
python3 -m pip install -e ".[dev,local]"

# OpenAI API path
python3 -m pip install -e ".[dev,openai]"
cp .env.example .env
```

Models, generated audio, API keys, and `.env` stay out of Git. For voice-conversion dependencies and model placement, see [VOICE_CLONE.md](docs/speech-translation/VOICE_CLONE.md).

The local Zoovoice UI and API do not use FastAPI. Verify them with the Wrangler local Worker and the Go service. See [services/zoovoice/README.md](services/zoovoice/README.md).

## Verification

Enable the gitleaks Git hooks in each worktree:

```sh
brew install gitleaks
./scripts/install_git_hooks.sh
```

`pre-commit` scans staged diffs; `pre-push` scans the entire Git history. GitHub Actions re-scans independently on pushes to all branches and on pull requests.

Routine checks:

```sh
gitleaks git --redact --log-opts='--all' .
python3 -m pytest
npm test
npm run check:js
npm run check:worker
npm run check:web
npm run test:e2e
cd services/zoovoice && go vet ./... && go test ./...
```

RunPod image builds and GPU smoke checks cost real money and take time, so routine CI excludes them. They run manually with minimal input, only when needed and after the model-independent tests pass.

## Public demo

The Cloudflare Worker serves `/` as the portal, `/speakloop` as the practice screen, and `/zoovoice` as the animal-call screen. The production environment reflects the merged version and the routes above are live. UI changes added on this branch (beta-label removal, tech-stack display, and the SpeakLoop GitHub link) are not yet in production. Deploy and post-deploy smoke checks follow the merge.

Audio is processed by external services for generation and evaluation, and is not stored as Voice Lab history. Do not record audio containing personal or confidential information. Details: [privacy policy](docs/PRIVACY_POLICY.md).

## Known limits

- RunPod Serverless is subject to cold starts, queuing, and GPU pricing.
- Zoovoice synthesis on Cloud Run is subject to cold starts and ASR/synthesis processing time.
- ASR results and phrase positions vary with language, pronunciation, recording quality, and provider output.
- Local and preview environments without D1/KV bindings use fallbacks, so storage differs from production.
- Recording formats on Safari, Firefox, and physical smartphones need continued verification.

Details: [KNOWN_LIMITS.md](docs/speech-translation/KNOWN_LIMITS.md).

## How it is developed

This is a solo project. Implementation uses AI coding agents (Claude Code and Codex).

The author:

- decides requirements, specifications, and design
- reviews every change and triages the findings
- verifies with real data and makes publication and cost decisions

The agents:

- propose designs, implement code and tests
- review implementations in a context separate from the implementer

Quality relies on automated tests and CI, secret scanning, docs linting, and cross-review between different models. Operating rules: [AGENTS.md](AGENTS.md).

## Security and license

For vulnerability reports, see [SECURITY.md](SECURITY.md). Do not post secrets or personal information in public issues.

Voice Lab itself is not under an open-source license. The repository is public as a portfolio for reading and evaluating the source code. Copying, modification, and redistribution are allowed only within the scope stated in [LICENSE](LICENSE). Cloning and running locally for evaluation and review are permitted as a limited exception in the LICENSE.

Dependencies, models, and third-party implementations keep their own licenses and terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Design write-ups

How comparison playback chooses its playback positions, and why that design was chosen, is published with diagrams. The normative spec is [SPEC.md](docs/speech-translation/SPEC.md) (Japanese, English summary at the top).

- [Comparison playback: how positions are chosen and why](docs/speech-translation/COMPARISON_PLAYBACK_CASE_STUDY.md) (Japanese). Covers what makes it hard, why this shape, the four roles, and the evaluation numbers with their limits.

## Documentation

The documentation index is [docs/README.md](docs/README.md) (Japanese). It organizes all documents by purpose, from the SpeakLoop spec and screens to execution paths, providers, and public operation.

Frequently used documents (Japanese; the ones marked below carry an English summary at the top):

- [CLI.md](CLI.md) — commands to try each feature locally, with example output
- [Full spec](docs/speech-translation/SPEC.md) — English summary included
- [Deployment architecture](docs/deployment/ARCHITECTURE.md) — English summary included
- [Known limits](docs/speech-translation/KNOWN_LIMITS.md) — English summary included
- [Privacy policy](docs/PRIVACY_POLICY.md) — English summary included
