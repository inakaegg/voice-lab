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
    assert "一般公開製品ではなくprivateまたは管理者専用" in readme
    assert "未deploy" in readme


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


def test_current_spec_tracks_tab_audio_and_rights_notice() -> None:
    spec = read_text("docs/speech-translation/SPEC.md")

    assert "タブ音声" in spec
    assert "利用条件" in spec
    assert "プライバシー" in spec

    vibevoice = read_text("docs/speech-translation/VIBEVOICE.md")
    assert "ブラウザの共有許可" in vibevoice
    assert "コンテンツの利用許諾" in vibevoice


def test_normal_ci_workflow_covers_python_node_and_static_checks() -> None:
    workflow = read_text(".github/workflows/ci.yml")

    assert "python3 -m pytest" in workflow
    assert "npm test" in workflow
    assert "npm run check:js" in workflow
    assert "Dockerfile.runpod" in workflow
    assert "gitleaks/gitleaks-action@v2" in workflow
    assert "fetch-depth: 0" in workflow


def test_publication_gate_tracks_private_review_and_external_blockers() -> None:
    checklist = read_text("docs/deployment/PUBLICATION_CHECKLIST.md")
    roadmap = read_text("docs/deployment/PUBLIC_DEMO_ROADMAP.md")
    task = read_text("TASK.md")

    for document in (checklist, roadmap, task):
        assert "GitHub repository" in document
        assert "private" in document

    assert "Docker Hub" in checklist
    assert "公開状態" in checklist
    assert "Private vulnerability reporting" in checklist
    assert "Secret scanning" in checklist
    assert "branch protection" in checklist
    assert "保持期間" in checklist
    assert "Seed-VC" in checklist
    assert "GPL-3.0" in checklist
    assert "VibeVoice" in checklist
    assert "外部状態スナップショット" in checklist
    assert "is_private=false" in checklist
    assert "Secret scanningは無効" in checklist
    assert "Dependabot alertsは無効" in checklist
    assert "Code scanningは未導入" in checklist
    assert "branch protectionとrulesetのAPIは403" in checklist


def test_repository_rights_and_third_party_boundaries_are_explicit() -> None:
    license_notice = read_text("LICENSE")
    notices = read_text("THIRD_PARTY_NOTICES.md")
    readme = read_text("README.md")

    assert "All rights reserved" in license_notice
    assert "No license is granted" in license_notice
    assert "オープンソースライセンスを付与していません" in readme
    assert "THIRD_PARTY_NOTICES.md" in readme
    assert "Seed-VC" in notices
    assert "GPL-3.0" in notices
    assert "ComfyUI-VibeVoice" in notices
    assert "bundled dependency licenses" in notices


def test_frontend_build_emits_and_packages_bundled_dependency_licenses() -> None:
    vite_config = read_text("apps/web/vite.config.ts")
    pyproject = read_text("pyproject.toml")
    wheel_verifier = read_text("scripts/verify_wheel_assets.py")

    assert 'fileName: "assets/licenses.md"' in vite_config
    assert "postBanner" in vite_config
    assert '"web/react/assets/*.md"' in pyproject
    assert '"mo_speech/web/react/assets/licenses.md"' in wheel_verifier


def test_container_images_include_repository_rights_notices() -> None:
    for dockerfile_path in ("Dockerfile", "Dockerfile.runpod"):
        dockerfile = read_text(dockerfile_path)

        assert "COPY LICENSE THIRD_PARTY_NOTICES.md /app/" in dockerfile


def test_privacy_boundary_records_unresolved_retention_before_publication() -> None:
    privacy = read_text("docs/deployment/PRIVACY.md")

    assert "完全なプライバシーポリシーではない" in privacy
    assert "OpenAI" in privacy
    assert "RunPod" in privacy
    assert "SHA-256" in privacy
    assert "署名cookie" in privacy
    assert "admin_google_emails" in privacy
    assert "legacy KV" in privacy
    assert "保持期間" in privacy
    assert "削除" in privacy
    assert "公開再開" in privacy
    assert "RUNPOD_OPERATION_POLICIES_JSON" not in privacy
    assert "policy.ttl" in privacy
    assert "policy.executionTimeout" in privacy
    assert "実測" in privacy


def test_public_docs_keep_skitvoice_closed_and_distinguish_local_changes_from_deploy() -> None:
    readme = read_text("README.md")
    task = read_text("TASK.md")
    spec = read_text("docs/speech-translation/SPEC.md")
    vibevoice = read_text("docs/speech-translation/VIBEVOICE.md")
    checklist = read_text("docs/deployment/PUBLICATION_CHECKLIST.md")

    for document in (readme, task, spec, vibevoice):
        assert "管理者" in document
    assert "生成フォームやsampleを含まない" in spec
    assert "public sample APIはSkitVoice sampleを返さない" in vibevoice
    assert "現時点の公開環境で停止済みとは扱わない" in checklist
    assert "aoi-ot/VibeVoice-LargeをMicrosoft公式配布と表現しない" in read_text("THIRD_PARTY_NOTICES.md")


def test_storage_plan_matches_the_implemented_r2_pilot_and_d1_boundary() -> None:
    storage = read_text("docs/deployment/STORAGE.md")

    assert "MO_SPEECH_AUDIO_R2" in storage
    assert "音声履歴" in storage
    assert "Cloudflare公開版では保存しない" in storage
    assert "ローカルFastAPI版" in storage
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
    assert "CLOUDFLARE_AUDIO_HISTORY_LIMIT" not in wrangler
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
    assert "https://voice-lab.inakaegg.workers.dev/" in cloudflare
    assert "https://voice-lab.inakaegg.workers.dev/auth/google/callback" in cloudflare


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


def test_public_docs_define_only_current_routes_and_fun_admin_boundary() -> None:
    readme = read_text("README.md")
    spec = read_text("docs/speech-translation/SPEC.md")
    architecture = read_text("docs/deployment/ARCHITECTURE.md")
    cloudflare = read_text("docs/deployment/CLOUDFLARE.md")

    for document in (readme, spec, architecture, cloudflare):
        assert "/speakloop" in document
        assert "/skitvoice" in document

    assert "`/fun` は管理者認証済みの場合だけ" in spec
    assert "同じGoogle OAuthセッション" in spec
    assert "別の管理パスワードや管理者cookieは設けない" in spec
    assert "管理機能の認証をWorker内のGoogle OAuthへ一本化" in cloudflare
    assert "管理者専用の別パスワード、別cookie、認証例外は設けない" in cloudflare
    assert "`/user`" not in spec
    assert "`/vibevoice`" not in spec
    assert "Cloudflare Pages" not in architecture
    assert "ファイル、マイク、タブ音声" in cloudflare
    assert "2話者・5行" in spec
    assert "1120px以上" in spec
    assert "D1" in spec
    assert "R2" in spec
