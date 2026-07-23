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


def test_dependabot_ignores_only_version_updates_for_runpod_coupled_dependencies() -> (
    None
):
    config = DEPENDABOT.read_text(encoding="utf-8")
    pip = _ecosystem_section(config, "pip", "github-actions")
    dependencies = ("torch", "torchaudio", "funasr")

    for index, dependency in enumerate(dependencies):
        dependency_rule = pip.split(f"- dependency-name: {dependency}", 1)[1]
        if index + 1 < len(dependencies):
            dependency_rule = dependency_rule.split(
                f"- dependency-name: {dependencies[index + 1]}",
                1,
            )[0]

        assert "update-types:" in dependency_rule
        assert "version-update:semver-patch" in dependency_rule
        assert "version-update:semver-minor" in dependency_rule
        assert "version-update:semver-major" in dependency_rule


def test_dependabot_automerge_workflow_has_narrow_trigger_and_permissions() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "pull_request:" in workflow
    assert "types: [opened, reopened, synchronize]" in workflow
    assert "pull_request_target:" not in workflow
    assert "checks: read" in workflow
    assert "contents: write" in workflow
    assert "pull-requests: write" in workflow
    assert "dependabot[bot]" in workflow


def test_dependabot_automerge_workflow_allows_only_npm_patch_minor_updates() -> (
    None
):
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "outputs.package-ecosystem == 'npm_and_yarn'" in workflow
    assert "outputs.package-ecosystem == 'github_actions'" not in workflow
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
    assert 'gh pr checks --required --watch --fail-fast "$PR_URL"' in workflow
    assert workflow.index("gh pr checks --required") < workflow.index(
        "gh pr merge --auto"
    )
    assert "--admin" not in workflow
    assert "gh pr review" not in workflow


def test_dependabot_automerge_retries_when_required_checks_are_not_reported() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "for attempt in {1..12}; do" in workflow
    assert "no required checks reported" in workflow
    assert "no checks reported" in workflow
    assert "sleep 10" in workflow
    assert workflow.index("for attempt in {1..12}; do") < workflow.index(
        "gh pr checks --required --watch --fail-fast"
    )
