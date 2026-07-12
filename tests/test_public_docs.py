from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_readme_describes_current_public_apps_and_architecture() -> None:
    readme = read_text("README.md")

    assert "SpeakLoop" in readme
    assert "SkitVoice" in readme
    assert "Cloudflare Worker" in readme
    assert "RunPod Serverless" in readme
    assert "```mermaid" in readme
    assert "npm test" in readme
    assert "python3 -m pytest" in readme


def test_project_agent_guide_contains_current_validation_commands() -> None:
    guide = read_text("AGENTS.md")

    assert "python3 -m pytest" in guide
    assert "npm test" in guide
    assert "npm run check:js" in guide
    assert "まだアプリ実装前" not in guide


def test_status_docs_do_not_claim_cloudflare_gateway_is_unimplemented() -> None:
    task = read_text("TASK.md")
    known_limits = read_text("docs/speech-translation/KNOWN_LIMITS.md")

    assert "SpeakLoop" in task
    assert "SkitVoice" in task
    assert "Cloudflare Worker" in task
    assert "通常CI" in task
    assert "Cloudflare gateway、" not in known_limits
    assert "Workers KV" in known_limits
    assert "R2" in known_limits
    assert "D1" in known_limits


def test_public_demo_roadmap_tracks_tab_audio_and_rights_notice() -> None:
    roadmap = read_text("docs/deployment/PUBLIC_DEMO_ROADMAP.md")

    assert "タブ音声" in roadmap
    assert "権利" in roadmap
    assert "プライバシー" in roadmap

    vibevoice = read_text("docs/speech-translation/VIBEVOICE.md")
    assert "ブラウザの共有許可" in vibevoice
    assert "コンテンツの利用許諾" in vibevoice


def test_normal_ci_workflow_covers_python_node_and_static_checks() -> None:
    workflow = read_text(".github/workflows/ci.yml")

    assert "python3 -m pytest" in workflow
    assert "npm test" in workflow
    assert "npm run check:js" in workflow
    assert "Dockerfile.runpod" in workflow


def test_storage_plan_matches_the_implemented_r2_pilot_and_d1_boundary() -> None:
    storage = read_text("docs/deployment/STORAGE.md")

    assert "MO_SPEECH_AUDIO_R2" in storage
    assert "音声履歴" in storage
    assert "混在" in storage
    assert "D1" in storage
    assert "quota" in storage
    assert "audit" in storage
    assert "KV fallback" in storage


def test_wrangler_binds_the_project_d1_database_and_tracks_its_schema() -> None:
    wrangler = read_text("wrangler.toml")
    migration = read_text("migrations/0001_public_demo_storage.sql")
    sample_migration = read_text("migrations/0002_public_samples.sql")

    assert 'binding = "MO_SPEECH_DB"' in wrangler
    assert 'database_name = "mo-speech-demo-db"' in wrangler
    assert 'migrations_dir = "migrations"' in wrangler
    assert "CREATE TABLE IF NOT EXISTS public_users" in migration
    assert "CREATE TABLE IF NOT EXISTS quota_usage_daily" in migration
    assert "CREATE TABLE IF NOT EXISTS quota_usage_total" in migration
    assert "CREATE TABLE IF NOT EXISTS audit_events" in migration
    assert "CREATE TABLE IF NOT EXISTS job_metadata" in migration
    assert "CREATE TABLE IF NOT EXISTS public_sample_audios" in sample_migration


def test_cloudflare_worker_uses_the_voice_lab_public_name() -> None:
    wrangler = read_text("wrangler.toml")
    cloudflare = read_text("docs/deployment/CLOUDFLARE.md")

    assert 'name = "voice-lab"' in wrangler
    assert "https://voice-lab.functional-dog.workers.dev/" in cloudflare
    assert "https://voice-lab.functional-dog.workers.dev/auth/google/callback" in cloudflare


def test_wrangler_binds_production_and_preview_r2_buckets() -> None:
    wrangler = read_text("wrangler.toml")

    assert 'binding = "MO_SPEECH_AUDIO_R2"' in wrangler
    assert 'bucket_name = "mo-speech-audio"' in wrangler
    assert 'preview_bucket_name = "mo-speech-audio-preview"' in wrangler


def test_frontend_migration_plan_preserves_current_api_and_state_boundaries() -> None:
    migration = read_text("docs/deployment/FRONTEND_MIGRATION.md")

    assert "Vite" in migration
    assert "React" in migration
    assert "TypeScript" in migration
    assert "API互換" in migration
    assert "SpeakLoop" in migration
    assert "SkitVoice" in migration
    assert "状態遷移" in migration
    assert "一括移行しない" in migration
