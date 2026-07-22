"""_ai/配下の計画ファイルに対する機械検査。

共通AGENTS.md §2.1.1「制約には出所を明記する」を検査する。対象は
`_ai/*plan*.md` の制約節で、各制約に次のいずれかのラベルを求める。

- [ユーザー指示]
- [実データ確認済み: 確認方法と件数]
- [未確認の推測]

`_ai/` はgit管理外のため、存在しない環境（CIなど）では検査対象なしで通る。
"""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

_SOURCE_LABELS = (
    re.compile(r"\[ユーザー指示\]"),
    re.compile(r"\[実データ確認済み[:：]\s*[^\]\s][^\]]*\]"),
    re.compile(r"\[未確認の推測\]"),
)
_HEADING = re.compile(r"^#{1,6}\s")
_CONSTRAINT_HEADING = re.compile(r"(?:制約|constraints)", re.IGNORECASE)
_CODE_FENCE = re.compile(r"^(```|~~~)")
_CONSTRAINT_LIST_INTRO = re.compile(r"^制約[:：]\s*$")
_BULLET = re.compile(r"^[-*]\s|^\d+\.\s")


def has_source_label(line: str) -> bool:
    return any(pattern.search(line) for pattern in _SOURCE_LABELS)


def iter_unlabeled_constraints(markdown: str):
    """出所ラベルの無い制約行を(行番号, 行)で返す。

    制約節は次の2形式を対象とする。
    1. 「制約」を含む見出しの節。見出し自体にラベルがあれば節全体を出所確認済みとみなす。
    2. コードブロック内の「制約:」行に続く箇条書き（新チャット貼り付け用プロンプト）。
    """
    in_code_block = False
    in_labeled_section = False
    in_constraint_section = False
    in_constraint_list = False
    for line_number, raw_line in enumerate(markdown.splitlines(), start=1):
        line = raw_line.rstrip()
        if _CODE_FENCE.match(line.strip()):
            in_code_block = not in_code_block
            in_constraint_list = False
            continue
        if in_code_block:
            if _CONSTRAINT_LIST_INTRO.match(line.strip()):
                in_constraint_list = True
                continue
            if in_constraint_list:
                if _BULLET.match(line.strip()) and not line.startswith((" ", "\t")):
                    if not has_source_label(line):
                        yield line_number, line.strip()
                elif line.strip() and not line.startswith((" ", "\t")):
                    in_constraint_list = False
            continue
        if _HEADING.match(line):
            in_constraint_section = bool(_CONSTRAINT_HEADING.search(line))
            in_labeled_section = has_source_label(line)
            continue
        if in_constraint_section and not in_labeled_section:
            if _BULLET.match(line) and not has_source_label(line):
                yield line_number, line.strip()


def test_iter_unlabeled_constraints_covers_headings_and_prompt_blocks() -> None:
    markdown = "\n".join(
        [
            "## 制約",
            "- ラベルなしの制約。",
            "- [ユーザー指示] ラベルありの制約。",
            "## 実データの制約 [実データ確認済み: 37件走査]",
            "- 見出しラベルで節全体が確認済み。",
            "## 方針",
            "- 制約節の外はラベル不要。",
            "```",
            "制約:",
            "- [未確認の推測] ラベルあり。",
            "- ラベルなし。",
            "",
            "検証: pytest",
            "```",
        ]
    )
    unlabeled = list(iter_unlabeled_constraints(markdown))

    assert unlabeled == [
        (2, "- ラベルなしの制約。"),
        (11, "- ラベルなし。"),
    ]


def test_iter_unlabeled_constraints_covers_english_constraint_heading() -> None:
    markdown = "\n".join(
        [
            "## Global Constraints",
            "- ラベルなしの制約。",
            "- [ユーザー指示] ラベルありの制約。",
        ]
    )

    assert list(iter_unlabeled_constraints(markdown)) == [
        (2, "- ラベルなしの制約。"),
    ]


def test_iter_unlabeled_constraints_rejects_incomplete_observation_label() -> None:
    markdown = "\n".join(
        [
            "## 制約",
            "- [実データ確認済み] 確認方法と件数がない制約。",
            "- [実データ確認済み: 37件を走査] 完全なラベル。",
        ]
    )

    assert list(iter_unlabeled_constraints(markdown)) == [
        (2, "- [実データ確認済み] 確認方法と件数がない制約。"),
    ]


def test_internal_plan_constraints_carry_source_labels() -> None:
    internal_dir = ROOT / "_ai"
    if not internal_dir.is_dir():
        return
    violations = []
    for path in sorted(internal_dir.glob("*plan*.md")):
        markdown = path.read_text(encoding="utf-8")
        for line_number, line in iter_unlabeled_constraints(markdown):
            violations.append(f"{path.relative_to(ROOT)}:{line_number} {line}")
    assert not violations, (
        "出所ラベル（[ユーザー指示]/[実データ確認済み]/[未確認の推測]）の無い制約:\n"
        + "\n".join(violations)
    )
