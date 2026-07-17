#!/bin/sh
set -eu

repository_root=$(git rev-parse --show-toplevel)

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaksが見つかりません。macOSでは 'brew install gitleaks' でインストールしてください。" >&2
  exit 1
fi

if [ ! -x "$repository_root/.githooks/pre-commit" ] || [ ! -x "$repository_root/.githooks/pre-push" ]; then
  echo "実行可能な.githooks/pre-commitまたは.githooks/pre-pushが見つかりません。" >&2
  exit 1
fi

# linked worktreeを含む他のcheckoutへhooksPathを波及させない。
git config --local extensions.worktreeConfig true
git config --worktree core.hooksPath .githooks

configured_hooks_path=$(git config --worktree --get core.hooksPath)
if [ "$configured_hooks_path" != ".githooks" ]; then
  echo "worktree単位のcore.hooksPath設定を確認できませんでした。" >&2
  exit 1
fi

echo "このworktreeでpre-commitとpre-pushのGitleaks検査を有効にしました。"
