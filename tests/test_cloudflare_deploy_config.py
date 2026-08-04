import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_wrangler_config() -> dict:
    return tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))


def test_staging_worker_configuration_is_removed() -> None:
    config = load_wrangler_config()

    assert "staging" not in config.get("env", {})
    assert not (ROOT / ".github/workflows/deploy-staging.yml").exists()


def test_workers_logs_observability_and_canonical_origin_remain_enabled_for_production() -> None:
    config = load_wrangler_config()

    assert config["observability"]["enabled"] is True
    assert config["vars"]["PUBLIC_CANONICAL_ORIGIN"] == "https://voice-lab.inakaegg.workers.dev"


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


def test_production_deploy_skips_a_tested_revision_older_than_main() -> None:
    workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")

    assert "current-main:" in workflow
    assert "ref: main" in workflow
    assert "current_main_sha=\"$(git rev-parse HEAD)\"" in workflow
    assert 'TESTED_SHA: ${{ github.event.workflow_run.head_sha }}' in workflow
    assert 'echo "deploy=false" >> "${GITHUB_OUTPUT}"' in workflow
    assert "needs: current-main" in workflow
    assert "needs.current-main.outputs.deploy == 'true'" in workflow

    revision_check = "current_main_sha=\"$(git rev-parse HEAD)\""
    migration = "npx wrangler d1 migrations apply mo-speech-demo-db --remote"
    assert workflow.index(revision_check) < workflow.index(migration)


def test_production_deploy_builds_the_frontend_before_wrangler() -> None:
    workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
    build = "npm run build:web"
    migration = "npx wrangler d1 migrations apply"
    deploy = "npx wrangler deploy"

    assert workflow.index(build) < workflow.index(migration)
    assert workflow.index(build) < workflow.index(deploy)


def test_production_deploy_smokes_the_deployed_environment() -> None:
    workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
    deploy = "npx wrangler deploy"
    smoke = "python3 scripts/smoke_cloudflare_deployment.py"

    assert workflow.index(deploy) < workflow.index(smoke)
    assert "--base-url https://voice-lab.inakaegg.workers.dev" in workflow


def test_cloudflare_deployment_smoke_script_exists() -> None:
    assert (ROOT / "scripts/smoke_cloudflare_deployment.py").is_file()
