import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_wrangler_config() -> dict:
    return tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))


def binding_by_name(bindings: list[dict], binding_name: str) -> dict:
    return next(binding for binding in bindings if binding["binding"] == binding_name)


def test_staging_uses_separate_cloudflare_data_resources() -> None:
    config = load_wrangler_config()
    staging = config["env"]["staging"]

    effective_name = staging.get("name", f'{config["name"]}-staging')
    assert effective_name == "voice-lab-staging"

    production_kv = binding_by_name(config["kv_namespaces"], "MO_SPEECH_KV")
    staging_kv = binding_by_name(staging["kv_namespaces"], "MO_SPEECH_KV")
    assert staging_kv["id"] != production_kv["id"]

    production_d1 = binding_by_name(config["d1_databases"], "MO_SPEECH_DB")
    staging_d1 = binding_by_name(staging["d1_databases"], "MO_SPEECH_DB")
    assert staging_d1["database_id"] != production_d1["database_id"]
    assert staging_d1["database_name"] != production_d1["database_name"]

    production_r2 = binding_by_name(config["r2_buckets"], "MO_SPEECH_AUDIO_R2")
    staging_r2 = binding_by_name(staging["r2_buckets"], "MO_SPEECH_AUDIO_R2")
    assert staging_r2["bucket_name"] != production_r2["bucket_name"]


def test_staging_repeats_vars_and_disables_the_production_cron() -> None:
    config = load_wrangler_config()
    staging = config["env"]["staging"]

    assert staging["vars"] == config["vars"]
    assert staging["triggers"]["crons"] == []


def test_production_deploy_waits_for_successful_main_ci() -> None:
    workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")

    assert "workflow_run:" in workflow
    assert "workflows: [CI]" in workflow
    assert "branches: [main]" in workflow
    assert "types: [completed]" in workflow
    assert "github.event.workflow_run.conclusion == 'success'" in workflow
    assert "ref: ${{ github.event.workflow_run.head_sha }}" in workflow
    assert "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}" in workflow
    assert "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" in workflow

    migration = "npx wrangler d1 migrations apply mo-speech-demo-db --remote"
    deploy = "npx wrangler deploy"
    assert workflow.index(migration) < workflow.index(deploy)


def test_staging_deploy_is_manual_and_targets_only_staging() -> None:
    workflow = (ROOT / ".github/workflows/deploy-staging.yml").read_text(encoding="utf-8")

    assert "workflow_dispatch:" in workflow
    assert "push:" not in workflow
    assert "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}" in workflow
    assert "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" in workflow

    migration = (
        "npx wrangler d1 migrations apply mo-speech-staging-db "
        "--env staging --remote"
    )
    deploy = "npx wrangler deploy --env staging"
    assert workflow.index(migration) < workflow.index(deploy)
