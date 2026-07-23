from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPENDABOT = ROOT / ".github" / "dependabot.yml"
WORKFLOW = ROOT / ".github" / "workflows" / "dependabot-automerge.yml"


def _ecosystem_section(
    text: str,
    ecosystem: str,
    next_ecosystem: str | None = None,
) -> str:
    section = text.split(f"  - package-ecosystem: {ecosystem}", 1)[1]
    if next_ecosystem is not None:
        section = section.split(f"  - package-ecosystem: {next_ecosystem}", 1)[0]
    return section


def test_dependabot_groups_only_npm_and_github_actions_patch_minor_updates() -> None:
    config = DEPENDABOT.read_text(encoding="utf-8")
    npm = _ecosystem_section(config, "npm", "pip")
    github_actions = _ecosystem_section(config, "github-actions")

    for section in (npm, github_actions):
        assert "update-types:" in section
        assert "          - patch" in section
        assert "          - minor" in section
        assert "          - major" not in section


def test_dependabot_keeps_runpod_coupled_python_dependencies_ignored() -> None:
    config = DEPENDABOT.read_text(encoding="utf-8")
    pip = _ecosystem_section(config, "pip", "github-actions")

    for dependency in ("torch", "torchaudio", "funasr"):
        assert f"- dependency-name: {dependency}" in pip


def test_dependabot_automerge_workflow_has_narrow_trigger_and_permissions() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "pull_request:" in workflow
    assert "types: [opened, reopened, synchronize]" in workflow
    assert "pull_request_target:" not in workflow
    assert "contents: write" in workflow
    assert "pull-requests: write" in workflow
    assert "dependabot[bot]" in workflow


def test_dependabot_automerge_workflow_allows_only_selected_ecosystems_and_updates() -> (
    None
):
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "outputs.package-ecosystem == 'npm_and_yarn'" in workflow
    assert "outputs.package-ecosystem == 'github_actions'" in workflow
    assert "outputs.package-ecosystem == 'pip'" not in workflow
    assert "outputs.update-type == 'version-update:semver-patch'" in workflow
    assert "outputs.update-type == 'version-update:semver-minor'" in workflow
    assert "version-update:semver-major" not in workflow


def test_dependabot_automerge_workflow_uses_pinned_metadata_and_safe_merge() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert (
        "dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98"
        in workflow
    )
    assert "gh pr merge --auto --squash" in workflow
    assert "--admin" not in workflow
    assert "gh pr review" not in workflow
