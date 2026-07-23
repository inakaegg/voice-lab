import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

# AGENTS.md「1文の読点（、）は3つまで」をdocs/配下へ機械検査する。
DOC_SENTENCE_COMMA_LIMIT = 3
_INLINE_CODE = re.compile(r"`[^`]*`")
_MARKDOWN_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_BARE_URL = re.compile(r"https?://\S+")
_NEW_BLOCK = re.compile(r"^(?:[-*+]\s|\d+\.\s)")


def iter_doc_sentences(markdown: str):
    """コードブロック・表・URL・リンク先を除いた本文を(行番号, 文)で返す。文の区切りは「。」。"""
    in_code_block = False
    paragraph_lines = []

    def flush_paragraph():
        if not paragraph_lines:
            return []
        sentences = []
        sentence_parts = []
        sentence_start = None
        for line_number, text in paragraph_lines:
            parts = text.split("。")
            for part_index, part in enumerate(parts):
                if part.strip():
                    if sentence_start is None:
                        sentence_start = line_number
                    sentence_parts.append(part.strip())
                if part_index < len(parts) - 1 and sentence_parts:
                    sentences.append((sentence_start, " ".join(sentence_parts)))
                    sentence_parts = []
                    sentence_start = None
        if sentence_parts:
            sentences.append((sentence_start, " ".join(sentence_parts)))
        paragraph_lines.clear()
        return sentences

    for line_number, raw_line in enumerate(markdown.splitlines(), start=1):
        stripped = raw_line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            yield from flush_paragraph()
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        if not stripped or stripped.startswith("|"):
            yield from flush_paragraph()
            continue
        text = _INLINE_CODE.sub("", stripped)
        text = _MARKDOWN_LINK.sub(r"\1", text)
        text = _BARE_URL.sub("", text)
        if stripped.startswith("#"):
            yield from flush_paragraph()
            paragraph_lines.append((line_number, text))
            yield from flush_paragraph()
            continue
        if _NEW_BLOCK.match(stripped):
            yield from flush_paragraph()
        paragraph_lines.append((line_number, text))
    yield from flush_paragraph()


def test_iter_doc_sentences_splits_sentences_and_excludes_non_prose() -> None:
    markdown = "\n".join(
        [
            "# 見出し",
            "一つ、二つ、三つ、四つ、五つと数える。次の文。",
            "```",
            "code、code、code、code、code",
            "```",
            "| 表、表、表、表、表 |",
            "リンクは[表示名、A、B、C、D](https://example.com/a,b,c,d)を残す。",
            "URLは https://example.com/x,y,z を除外し、`a、b、c、d、e` も除外する。",
        ]
    )
    sentences = list(iter_doc_sentences(markdown))

    assert (2, "一つ、二つ、三つ、四つ、五つと数える") in sentences
    assert (2, "次の文") in sentences
    assert (7, "リンクは表示名、A、B、C、Dを残す") in sentences
    assert (8, "URLは  を除外し、 も除外する") in sentences
    assert all("code" not in sentence for _, sentence in sentences)
    assert all("表、表" not in sentence for _, sentence in sentences)


def test_iter_doc_sentences_joins_soft_wrapped_paragraphs() -> None:
    markdown = "一つ、二つ、三つ、\n四つ、五つまで続く。"

    assert list(iter_doc_sentences(markdown)) == [
        (1, "一つ、二つ、三つ、 四つ、五つまで続く"),
    ]


def test_iter_doc_sentences_excludes_inline_code_from_headings() -> None:
    markdown = "# 見出し `一、二、三、四、五`"

    assert list(iter_doc_sentences(markdown)) == [
        (1, "# 見出し"),
    ]


def test_public_doc_sentences_keep_commas_within_limit() -> None:
    violations = []
    for path in sorted((ROOT / "docs").rglob("*.md")):
        markdown = path.read_text(encoding="utf-8")
        for line_number, sentence in iter_doc_sentences(markdown):
            comma_count = sentence.count("、")
            if comma_count > DOC_SENTENCE_COMMA_LIMIT:
                violations.append(
                    f"{path.relative_to(ROOT)}:{line_number} 読点{comma_count}個: {sentence}"
                )
    assert not violations, (
        f"1文の読点は{DOC_SENTENCE_COMMA_LIMIT}つまで（AGENTS.md）。違反{len(violations)}件:\n"
        + "\n".join(violations)
    )


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_public_docs_carry_an_update_date_near_the_top() -> None:
    # AGENTS.md「現状説明を持つ文書には更新日を置く」をdocs/配下へ機械検査する。
    date_line = re.compile(r"^(最終)?更新日[:：]\s*\S+")
    missing = []
    for path in sorted((ROOT / "docs").rglob("*.md")):
        head_lines = path.read_text(encoding="utf-8").splitlines()[:5]
        if not any(date_line.match(line) for line in head_lines):
            missing.append(str(path.relative_to(ROOT)))
    assert not missing, "冒頭5行に更新日行がないdocs:\n" + "\n".join(missing)


def test_readme_presents_speakloop_without_research_branding() -> None:
    readme = read_text("README.md")

    assert "SpeakLoop" in readme
    assert "Cloudflare Worker" in readme
    assert "RunPod Serverless" in readme
    assert "```mermaid" in readme
    assert "npm test" in readme
    assert "python3 -m pytest" in readme
    assert "https://voice-lab.inakaegg.workers.dev/" in readme
    assert "SkitVoice" not in readme
    assert "VibeVoice" not in readme
    assert "本番未deploy" not in readme


def test_project_agent_guide_contains_current_validation_commands() -> None:
    guide = read_text("AGENTS.md")

    assert "python3 -m pytest" in guide
    assert "npm test" in guide
    assert "npm run check:js" in guide
    assert "まだアプリ実装前" not in guide


def test_status_docs_do_not_claim_cloudflare_gateway_is_unimplemented() -> None:
    roadmap = read_text("docs/speech-translation/ROADMAP.md")
    known_limits = read_text("docs/speech-translation/KNOWN_LIMITS.md")

    assert "SpeakLoop" in roadmap
    assert "SkitVoice" not in roadmap
    assert "VibeVoice" not in roadmap
    assert "Cloudflare Worker" in roadmap
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
    assert "タブ音声録音の開始前に権利確認を必須とする" in vibevoice
    assert "必須チェックを毎回要求しない" not in vibevoice


def test_normal_ci_workflow_covers_python_node_and_static_checks() -> None:
    workflow = read_text(".github/workflows/ci.yml")
    secret_workflow = read_text(".github/workflows/secret-scan.yml")

    assert "python3 -m pytest" in workflow
    assert "npm test" in workflow
    assert "npm run check:js" in workflow
    assert "Dockerfile.runpod" in workflow
    assert "branches: [main]" in workflow
    assert "gitleaks/gitleaks-action" not in workflow
    assert "gitleaks/gitleaks-action@v3" in secret_workflow
    assert "fetch-depth: 0" in secret_workflow
    assert "branches: [main]" not in secret_workflow
    assert "on:\n  push:\n  pull_request:" in secret_workflow


def test_secret_scanning_layers_are_documented() -> None:
    readme = read_text("README.md")
    checklist = read_text("docs/deployment/PUBLICATION_CHECKLIST.md")
    roadmap = read_text("docs/deployment/PUBLIC_DEMO_ROADMAP.md")

    assert "scripts/install_git_hooks.sh" in readme
    assert "pre-commit" in checklist
    assert "pre-push" in checklist
    assert "GitHub Push Protection" in checklist
    assert "全branchへのpush" in roadmap
    assert "commit前" in roadmap
    assert "push前" in roadmap


def test_publication_record_tracks_public_repository_and_external_controls() -> None:
    checklist = read_text("docs/deployment/PUBLICATION_CHECKLIST.md")
    roadmap = read_text("docs/deployment/PUBLIC_DEMO_ROADMAP.md")

    for document in (checklist, roadmap):
        assert "GitHub repository" in document
        assert "public" in document

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
    assert "is_private=true" in checklist
    assert "Secret scanningとGitHub Push Protectionは有効" in checklist
    assert "Dependabot alertsは有効" in checklist
    assert "Code scanningは未導入" in checklist
    assert "Private vulnerability reportingは有効" in checklist
    assert "required checks" in checklist
    assert "force pushとbranch削除は禁止" in checklist
    assert "2026-07-22（米国太平洋時間）" in checklist
    assert "2026-07-23T04:38:20Z" in checklist
    assert "legacy quota keyは0件" in checklist
    assert "D1 audit 97件" in checklist
    assert "registry credentialは1件" in checklist
    assert "強制scale-to-zero後の新しいworker" in checklist


def test_public_privacy_policy_and_retention_are_fixed() -> None:
    policy = read_text("docs/PRIVACY_POLICY.md")
    privacy = read_text("docs/deployment/PRIVACY.md")
    storage = read_text("docs/deployment/STORAGE.md")
    wrangler = read_text("wrangler.toml")

    assert "利用上限を管理するため、利用者ごとの利用回数を記録します" in policy
    assert "音声や入力内容はこの記録に含まれません" in policy
    assert "日ごとの利用回数は、利用日から3日以内に削除します" in policy
    assert "操作ログは、約90日間保存します" in policy
    assert "ログインしたメールアドレスと日時は、運営者が管理画面で確認できる形で保存します" in policy
    assert "ログインしたメールアドレスと日時" in privacy
    assert "public_users" in privacy
    assert "最大3日" not in policy
    assert "最大91日" not in policy
    assert "48時間" in privacy
    assert "90日" in privacy
    assert "48時間" in storage
    assert "90日" in storage
    for document in (policy, privacy, storage):
        assert "公開デモの運用中" in document
    for document in (policy, privacy):
        assert "30日" in document

    for provider in ("Cloudflare", "OpenAI", "RunPod"):
        assert provider in policy

    assert "外部処理事業者" not in policy
    assert "Report a vulnerability" not in policy
    assert "security/advisories/new" not in policy
    assert 'crons = ["17 3 * * *"]' in wrangler


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
    assert "public container imageを配布しない" in notices
    assert "self-hosted runtimeへ実装済みとは表示しない" in notices

    browser_bundle = notices.split("## ブラウザbundle", 1)[1].split("## Cloudflare Worker", 1)[0]
    worker_bundle = notices.split("## Cloudflare Worker", 1)[1].split("## Python・GPU image", 1)[0]
    assert "pinyin-pro" not in browser_bundle
    assert "pinyin-pro" in worker_bundle


def test_runpod_registry_docs_do_not_put_pull_tokens_on_command_lines() -> None:
    runpod = read_text("docs/deployment/RUNPOD.md")

    assert "read-only Personal Access Token" in runpod
    assert "RUNPOD_REGISTRY_AUTH_ID" in runpod
    assert "--password" not in runpod


def test_frontend_build_emits_and_packages_bundled_dependency_licenses() -> None:
    vite_config = read_text("apps/web/vite.config.ts")
    package_json = read_text("package.json")
    pyproject = read_text("pyproject.toml")
    wheel_verifier = read_text("scripts/verify_wheel_assets.py")
    generated_licenses = read_text("src/mo_speech/web/react/assets/licenses.md")

    assert 'fileName: "assets/licenses.md"' in vite_config
    assert "postBanner" in vite_config
    assert "ensure_frontend_license_notices.mjs" in package_json
    assert '"web/react/assets/*.md"' in pyproject
    assert '"web/react/*.ico"' in pyproject
    assert '"mo_speech/web/react/assets/licenses.md"' in wheel_verifier
    assert '"mo_speech/web/react/favicon.ico"' in wheel_verifier
    assert "opencc-js - 1.4.1 (MIT AND Apache-2.0)" in generated_licenses
    assert "opencc-data" in generated_licenses
    assert "Apache License" in generated_licenses


def test_container_images_include_repository_rights_notices() -> None:
    for dockerfile_path in ("Dockerfile", "Dockerfile.runpod"):
        dockerfile = read_text(dockerfile_path)

        assert "COPY LICENSE THIRD_PARTY_NOTICES.md /app/" in dockerfile


def test_privacy_boundary_explains_external_processing_without_blocking_runpod() -> None:
    privacy = read_text("docs/deployment/PRIVACY.md")

    assert "Voice Lab プライバシーポリシー" in privacy
    assert "OpenAI" in privacy
    assert "RunPod" in privacy
    assert "SHA-256" in privacy
    assert "署名cookie" in privacy
    assert "admin_google_emails" in privacy
    assert "legacy KV" in privacy
    assert "保持期間" in privacy
    assert "削除" in privacy
    assert "legacy KVの平文email keyは0件" in privacy
    assert "Private vulnerability reportingは有効" in privacy
    assert "RUNPOD_OPERATION_POLICIES_JSON" not in privacy
    assert "policy.ttl" not in privacy
    assert "policy.executionTimeout" not in privacy
    assert "RunPodの既定" in privacy


def test_public_summaries_focus_on_speakloop_while_technical_boundaries_remain() -> None:
    readme = read_text("README.md")
    roadmap = read_text("docs/deployment/PUBLIC_DEMO_ROADMAP.md")
    spec = read_text("docs/speech-translation/SPEC.md")
    vibevoice = read_text("docs/speech-translation/VIBEVOICE.md")

    for document in (readme, roadmap):
        assert "SpeakLoop" in document
        assert "SkitVoice" not in document
        assert "VibeVoice" not in document
    assert "VIBEVOICE.md" not in readme
    assert "生成フォームやsampleを含まない" in spec
    assert "public sample APIはSkitVoice sampleを返さない" in vibevoice
    assert "aoi-ot/VibeVoice-LargeをMicrosoft公式配布と表現しない" in read_text("THIRD_PARTY_NOTICES.md")


def test_current_state_docs_match_the_deployed_production_boundary() -> None:
    for relative_path in (
        "README.md",
        "docs/deployment/CLOUDFLARE.md",
        "docs/deployment/PUBLIC_DEMO_ROADMAP.md",
        "docs/deployment/ARCHITECTURE.md",
        "docs/deployment/APP_SPLIT.md",
        "docs/speech-translation/SPEC.md",
    ):
        document = read_text(relative_path)
        assert "production" in document, relative_path
        assert "本番未deploy" not in document, relative_path
        assert "production公開環境へ反映済み" in document, relative_path


def test_speakloop_roadmap_contains_future_work_without_public_task_notes() -> None:
    roadmap = read_text("docs/speech-translation/ROADMAP.md")

    assert "LLMによる比較再生と採点" in roadmap
    assert "Hono" in roadmap
    assert "FastAPI" in roadmap
    assert "Cloudflare Worker" in roadmap
    assert "Python依存処理" in roadmap
    assert "`wrangler dev`" in roadmap
    assert "ローカルsimulation" in roadmap
    assert "本番リソースへ接続しない" in roadmap
    assert "job単位のDurable Object" in roadmap
    assert "お手本ASR cache" in roadmap
    assert "公開文書の整理" in roadmap
    assert "既存文書への統合" in roadmap
    assert "`_ai/`" in roadmap
    assert "Git履歴" in roadmap
    assert not (ROOT / "TASK.md").exists()
    assert not (ROOT / "docs/speech-translation/LEARNING_ROADMAP.md").exists()
    assert not (ROOT / "docs/speech-translation/PRACTICE_LLM_COMPARISON_SPEC.md").exists()


def test_speech_translation_docs_are_consolidated() -> None:
    # 完了済みフェーズ履歴と統合済み文書は再作成しない。詳細はGit履歴を正とする。
    assert not (ROOT / "docs/speech-translation/PHASES.md").exists()
    assert not (ROOT / "docs/speech-translation/LATENCY.md").exists()
    assert not (ROOT / "docs/speech-translation/MODEL_EVALUATION.md").exists()
    assert not (ROOT / "docs/speech-translation/REFERENCE_SELECTION.md").exists()

    local_providers = read_text("docs/speech-translation/LOCAL_PROVIDERS.md")
    assert "benchmark_pipeline.py" in local_providers
    assert "要件未達" in local_providers

    voice_clone = read_text("docs/speech-translation/VOICE_CLONE.md")
    assert "silencedetect" in voice_clone
    assert "REFERENCE_SELECTION.md" not in voice_clone


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
    user_email_migration = read_text("migrations/0003_public_user_email.sql")
    storage = read_text("docs/deployment/STORAGE.md")

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
    assert "ALTER TABLE public_users ADD COLUMN email TEXT" in user_email_migration
    assert "ALTER TABLE public_users ADD COLUMN last_login_at TEXT" in user_email_migration
    assert "last_login_at TEXT" in storage


def test_cloudflare_deploy_applies_remote_d1_migrations_before_worker() -> None:
    cloudflare = read_text("docs/deployment/CLOUDFLARE.md")
    deployment = cloudflare.split("## デプロイ", 1)[1].split("## 制限", 1)[0]
    migration_command = "npx wrangler d1 migrations apply mo-speech-demo-db --remote"
    deploy_command = "wrangler deploy"

    assert migration_command in deployment
    assert deployment.index(migration_command) < deployment.index(deploy_command)


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

    assert "/speakloop" in readme
    for document in (spec, architecture, cloudflare):
        assert "/speakloop" in document
        assert "/skitvoice" in document
    assert "/skitvoice" not in readme

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


def test_runpod_practice_contract_documents_the_cached_reference_asr_exception() -> None:
    spec = read_text("docs/speech-translation/SPEC.md")
    cloudflare = read_text("docs/deployment/CLOUDFLARE.md")

    assert "お手本ASRのキャッシュがある場合は `model_audio_base64` を省略できる" in spec
    assert "`model_transcription` も返さない" in spec
    assert "`model_audio_base64` を省略したjob" in cloudflare
    assert "旧imageとは判定しない" in cloudflare
    # 現在の実装仕様はSPEC.mdを正とする（ROADMAP.mdは将来方針に限る）。
    assert "音声履歴と独立した短期job state" in spec
