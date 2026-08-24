"""比較再生の解説図(SVG)を生成する。

docs/speech-translation/COMPARISON_PLAYBACK_CASE_STUDY.md が参照する図の正本。
外部ライブラリなしで再生成できる。

    python3 docs/diagrams/comparison_playback.py

図中の数値(±0.35秒、余白0.30秒、30msのfade、約1.4秒のズレ)は
docs/speech-translation/SPEC.md と解説本文の値に合わせている。
"""

from __future__ import annotations

import random
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent

FONT = "'Hiragino Sans','Noto Sans JP','Yu Gothic Medium',sans-serif"

INK = "#1f2937"
SUB = "#6f7684"
WAVE = "#8f9ac4"
AXIS = "#b8bfd8"
ISLAND = "#eceef3"
ISLAND_EDGE = "#c3c9d9"
BLUE = "#3b52c4"
BLUE_FILL = "#e3e7f8"
RED = "#c2402a"
RED_FILL = "#fbe9e4"
GREEN = "#0e7a55"
GREEN_FILL = "#def0e8"


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Svg:
    def __init__(self, width: int, height: int) -> None:
        self.width = width
        self.height = height
        self.parts: list[str] = [
            f'<rect x="0" y="0" width="{width}" height="{height}" rx="14" fill="#ffffff"/>'
        ]

    def rect(self, x, y, w, h, fill, stroke="none", sw=1.5, rx=8, dash=None, opacity=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        o = f' fill-opacity="{opacity}"' if opacity is not None else ""
        self.parts.append(
            f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{rx}" '
            f'fill="{fill}"{o} stroke="{stroke}" stroke-width="{sw}"{d}/>'
        )

    def line(self, x1, y1, x2, y2, stroke, sw=2, dash=None, cap="round"):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" '
            f'stroke="{stroke}" stroke-width="{sw}" stroke-linecap="{cap}"{d}/>'
        )

    def text(self, x, y, s, size=15, fill=INK, weight="normal", anchor="start"):
        self.parts.append(
            f'<text x="{x:g}" y="{y:g}" font-family="{FONT}" font-size="{size}" '
            f'fill="{fill}" font-weight="{weight}" text-anchor="{anchor}">{esc(s)}</text>'
        )

    def poly(self, points, fill):
        pts = " ".join(f"{x:g},{y:g}" for x, y in points)
        self.parts.append(f'<polygon points="{pts}" fill="{fill}"/>')

    def arrow(self, x1, y1, x2, y2, stroke, sw=2):
        # 水平・垂直の矢印だけ使う。矢じりは6x9pxの三角形。
        self.line(x1, y1, x2, y2, stroke, sw)
        if y1 == y2:
            s = 1 if x2 > x1 else -1
            self.poly([(x2, y2), (x2 - 9 * s, y2 - 5), (x2 - 9 * s, y2 + 5)], stroke)
        else:
            s = 1 if y2 > y1 else -1
            self.poly([(x2, y2), (x2 - 5, y2 - 9 * s), (x2 + 5, y2 - 9 * s)], stroke)

    def axis(self, x1, x2, y):
        self.line(x1, x2, y, y, AXIS, 2.5, dash="0.1 7") if False else self.line(
            x1, y, x2, y, AXIS, 2.5, dash="0.1 7"
        )

    def waveform(self, x0, x1, cy, amp, seed, color=WAVE):
        rng = random.Random(seed)
        x = x0
        while x < x1:
            h = amp * (0.28 + 0.72 * rng.random())
            self.parts.append(
                f'<rect x="{x:g}" y="{cy - h:g}" width="3.2" height="{2 * h:g}" '
                f'rx="1.6" fill="{color}"/>'
            )
            x += 6.5

    def save(self, name: str) -> None:
        body = "\n".join(self.parts)
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {self.width} {self.height}" '
            f'font-family="{FONT}">\n{body}\n</svg>\n'
        )
        (OUT_DIR / name).write_text(svg, encoding="utf-8")
        print(f"wrote {OUT_DIR / name}")


def phrase_span(svg, x0, x1, cy, active, label):
    h = 76
    if active:
        svg.rect(x0, cy - h / 2, x1 - x0, h, BLUE_FILL, BLUE, 2.5, opacity=0.75)
        svg.text((x0 + x1) / 2, cy - h / 2 - 12, f"▶ {label}", 15, BLUE, "bold", "middle")
    else:
        svg.rect(x0, cy - h / 2, x1 - x0, h, ISLAND, ISLAND_EDGE, 1.5, dash="5 4", opacity=0.6)
        svg.text((x0 + x1) / 2, cy - h / 2 - 12, label, 14, SUB, "normal", "middle")


def fig_mechanism() -> None:
    svg = Svg(960, 414)
    svg.text(24, 38, "同じフレーズを2本の音声から切り出して続けて再生する", 17, INK, "bold")
    svg.text(24, 84, "お手本(合成音声)", 15, INK, "bold")
    cy = 162
    svg.axis(24, 936, cy)
    for (x0, x1), active, label, seed in [
        ((70, 300), False, "フレーズ1", 11),
        ((330, 560), True, "フレーズ2", 12),
        ((590, 880), False, "フレーズ3", 13),
    ]:
        phrase_span(svg, x0, x1, cy, active, label)
        svg.waveform(x0 + 8, x1 - 8, cy, 30, seed)

    svg.text(24, 244, "あなたの復唱(マイク録音)", 15, INK, "bold")
    cy = 322
    svg.axis(24, 936, cy)
    for (x0, x1), active, label, seed in [
        ((70, 380), False, "フレーズ1", 21),
        ((410, 720), True, "フレーズ2", 22),
        ((750, 920), False, "フレーズ3", 23),
    ]:
        phrase_span(svg, x0, x1, cy, active, label)
        svg.waveform(x0 + 8, x1 - 8, cy, 30, seed)

    svg.text(
        24, 398,
        "フレーズ2を選ぶと、青い区間だけが順に再生される。話す速さが違うため、同じフレーズでも位置と長さは音声ごとに違う。",
        14, SUB,
    )
    svg.save("comparison-playback-mechanism.svg")


def fig_index_contract() -> None:
    svg = Svg(960, 434)
    svg.text(24, 38, "位置番号契約: LLMは番号だけを返し、時刻はアプリが表から引く", 17, INK, "bold")
    svg.text(24, 70, "ASRの認識単位(中国語ではほぼ漢字1文字)と、その時刻表", 14, SUB)

    chars = "已经晚上了再过一会儿"
    x0, w, gap, y, h = 90, 68, 10, 104, 60
    sel = range(5, 10)
    for i, ch in enumerate(chars):
        x = x0 + i * (w + gap)
        active = i in sel
        svg.rect(x, y, w, h, BLUE_FILL if active else "#f4f5f8",
                 BLUE if active else ISLAND_EDGE, 2 if active else 1.5)
        svg.text(x + w / 2, y - 10, str(i), 13, BLUE if active else SUB,
                 "bold" if active else "normal", "middle")
        svg.text(x + w / 2, y + h / 2 + 8, ch, 22, BLUE if active else INK, "normal", "middle")
        svg.text(x + w / 2, y + h + 20, f"{1.0 + 0.24 * i:.2f}秒", 11.5, SUB, "normal", "middle")

    # 選択範囲(単位5〜9)を角括弧で示す
    bx0 = x0 + 5 * (w + gap) - 4
    bx1 = x0 + 9 * (w + gap) + w + 4
    by = y + h + 32
    svg.line(bx0, by, bx1, by, BLUE, 2.5)
    svg.line(bx0, by, bx0, by - 8, BLUE, 2.5)
    svg.line(bx1, by, bx1, by - 8, BLUE, 2.5)

    ly, lh = 250, 118
    svg.rect(60, ly, 400, lh, "#ffffff", BLUE, 2)
    svg.text(80, ly + 32, "LLMが返すもの(番号だけ)", 15, BLUE, "bold")
    svg.text(80, ly + 62, "フレーズ2 = 単位5〜9", 15, INK)
    svg.text(80, ly + 90, "ほかに到達状態・点数・コメント", 13.5, SUB)
    # LLM箱は範囲(単位5〜9)の左下にあるため、L字の接続線で角括弧の中央付近を指す
    svg.line(260, ly, 260, by + 40, BLUE, 2)
    svg.line(260, by + 40, 600, by + 40, BLUE, 2)
    svg.arrow(600, by + 40, 600, by + 6, BLUE)

    ry = ly
    svg.rect(510, ry, 400, lh, "#ffffff", GREEN, 2)
    svg.text(530, ry + 32, "アプリが計算するもの(時刻)", 15, GREEN, "bold")
    svg.text(530, ry + 62, "開始 = 単位5の開始時刻(時刻表から)", 14.5, INK)
    svg.text(530, ry + 90, "終了 = 単位9の終了時刻(時刻表から)", 14.5, INK)
    svg.arrow(710, ry, 710, by + 6, GREEN)

    svg.text(
        24, 414,
        "時刻や文字列をLLMに書き写させると、1か所の写し間違いで比較全体が失敗する。写し得る情報を番号だけに絞っている。",
        14, SUB,
    )
    svg.save("comparison-playback-index-contract.svg")


def fig_snap() -> None:
    svg = Svg(960, 396)
    svg.text(24, 38, "VADスナップ: 発話島の端から±0.35秒以内の時刻だけを端へ差し替える", 17, INK, "bold")

    def panel(px, title, off_sec, snapped, seed):
        # 1秒=160px。発話島の左端を基準にoff_sec手前へfa-zhの時刻を置く。
        edge = px + 190
        cy = 210
        svg.text(px, 84, title, 15, INK, "bold")
        svg.axis(px, px + 420, cy)
        svg.rect(edge, cy - 52, 210, 104, ISLAND, ISLAND_EDGE, 1.5, rx=10)
        svg.waveform(edge + 8, edge + 202, cy, 36, seed)
        svg.text(edge + 105, cy + 76, "発話島(無音で区切られた発話)", 12.5, SUB, "normal", "middle")

        band = 0.35 * 160
        svg.rect(edge - band, cy - 58, band * 2, 12, GREEN_FILL, rx=4)
        svg.text(edge, cy - 66, "±0.35秒", 12, GREEN, "normal", "middle")

        bx = edge - off_sec * 160
        svg.line(bx, cy - 42, bx, cy + 42, RED, 2.5, dash="6 5")
        svg.text(bx, cy - 88, f"fa-zhの時刻({off_sec:.2f}秒手前)", 13, RED, "bold", "middle")
        if snapped:
            svg.arrow(bx + 6, cy, edge - 4, cy, GREEN, 2.5)
            svg.line(edge, cy - 46, edge, cy + 46, GREEN, 3)
            svg.text(edge + 8, cy - 30, "端へ差し替え", 13, GREEN, "bold")
        else:
            svg.text(bx, cy + 66, "0.35秒超 → 動かさない", 13, RED, "bold", "middle")

    panel(40, "差し替えられる例", 0.15, True, 31)
    panel(500, "差し替えられない例", 0.60, False, 32)

    svg.text(
        24, 376,
        "対象は発話島ごとの先頭単位の開始時刻と末尾単位の終了時刻だけ。大づかみの位置はfa-zhが決め、スナップは端の微調整に限る。",
        14, SUB,
    )
    svg.save("comparison-playback-snap.svg")


def fig_padding() -> None:
    svg = Svg(960, 380)
    svg.text(24, 38, "再生の余白: 前後0.30秒を足し、隣の認識単位の時刻で止める", 17, INK, "bold")

    # この図だけ1秒=320px。0.30秒=96pxをラベルが読める幅にするため。
    cy = 200
    svg.axis(24, 936, cy)

    prev_end = 330
    svg.waveform(150, prev_end, cy, 30, 41)
    svg.line(prev_end, cy - 46, prev_end, cy + 46, SUB, 2, dash="5 4")
    svg.text(prev_end - 8, cy - 56, "直前の認識単位の終了", 13, SUB, "normal", "end")

    x0, x1 = 400, 700
    svg.rect(x0, cy - 52, x1 - x0, 104, BLUE_FILL, BLUE, 2.5, opacity=0.7)
    svg.text((x0 + x1) / 2, cy - 64, "選んだフレーズ", 14.5, BLUE, "bold", "middle")
    svg.waveform(x0 + 8, x1 - 8, cy, 36, 42)

    # 左側: 0.30秒(96px)延ばしたいが、直前の単位の終了(330)で止まる
    svg.rect(prev_end, cy - 52, x0 - prev_end, 104, GREEN_FILL, GREEN, 1.8, rx=6, opacity=0.8)
    svg.line(x0 - 96, cy + 62, x0, cy + 62, RED, 2, dash="6 5")
    svg.line(x0 - 96, cy + 56, x0 - 96, cy + 68, RED, 2)
    svg.text(x0 - 48, cy + 84, "0.30秒に届く前にクランプ", 13, RED, "normal", "middle")

    # 右側: 0.30秒まるごと付く
    svg.rect(x1, cy - 52, 96, 104, GREEN_FILL, GREEN, 1.8, rx=6, opacity=0.8)
    svg.text(x1 + 48, cy - 64, "余白0.30秒", 13.5, GREEN, "bold", "middle")

    svg.arrow(x1 + 130, cy - 100, x1 + 100, cy - 58, SUB)
    svg.text(x1 + 138, cy - 106, "両端に30msのfade", 13, SUB)

    svg.text(
        24, 344,
        "余白の上限は隣の認識単位の時刻と音声全体の長さ。無音の位置は見ないため、余白が必ず無音側へ広がる保証はない。",
        14, SUB,
    )
    svg.save("comparison-playback-padding.svg")


def fig_before_after() -> None:
    svg = Svg(960, 484)
    svg.text(24, 38, "実データの前後比較: 記録された時刻が実際の発話より約1.4秒早かった例", 17, INK, "bold")

    def islands(cy):
        for (x0, x1), label, seed in [((200, 440), "実際の発話: フレーズ2", 51), ((520, 760), "フレーズ3", 52)]:
            svg.rect(x0, cy - 44, x1 - x0, 88, ISLAND, ISLAND_EDGE, 1.5, rx=10)
            svg.waveform(x0 + 8, x1 - 8, cy, 30, seed)
            svg.text((x0 + x1) / 2, cy + 70, label, 12.5, SUB, "normal", "middle")

    # 改善前: ASRの時刻をそのまま使い、フレーズ3の再生区間が1.4秒(224px)手前を指す
    cy = 152
    svg.text(24, 96, "改善前 — ASRの時刻をそのまま使う", 15, RED, "bold")
    svg.axis(24, 936, cy)
    islands(cy)
    svg.rect(296, cy - 52, 240, 104, RED_FILL, RED, 2.5, rx=10, dash="7 5", opacity=0.6)
    svg.text(416, cy - 64, "記録時刻で切り出した「フレーズ3」", 13.5, RED, "bold", "middle")
    svg.arrow(516, cy - 90, 300, cy - 90, RED)
    svg.text(408, cy - 100, "約1.4秒早い", 13, RED, "bold", "middle")
    svg.text(296, cy + 92, "→ 前のフレーズの途中から再生が始まってしまう", 13.5, RED)

    # 改善後: fa-zhで求め直した時刻は実際の発話島と一致する
    cy = 348
    svg.text(24, 292, "改善後 — fa-zhで求め直し、VADスナップで端を整える", 15, GREEN, "bold")
    svg.axis(24, 936, cy)
    islands(cy)
    svg.rect(520, cy - 52, 240, 104, GREEN_FILL, GREEN, 2.5, rx=10, opacity=0.55)
    svg.text(640, cy - 64, "求め直した「フレーズ3」", 13.5, GREEN, "bold", "middle")
    svg.text(520, cy + 92, "→ 選んだフレーズどおりに再生される", 13.5, GREEN)

    svg.text(
        24, 466,
        "時刻は1本のお手本音声の実測値。ズレ幅は音声ごとに違い、確認した4本では0秒から2秒近くまでばらついた。",
        14, SUB,
    )
    svg.save("comparison-playback-before-after.svg")


def fig_timeline_correction() -> None:
    # 役割1〜3で同じ認識単位列が実際の発話位置へ合っていく様子。位置は模式値。
    svg = Svg(960, 560)
    svg.text(24, 38, "時刻が段階的に実際の発話へ合っていく(模式図)", 17, INK, "bold")

    islands = [(300, 560), (620, 880)]
    top, bottom = 96, 470
    # 帯は背景に敷くため、薄いと白地に溶けて見えなくなる。濃いめの塗りと輪郭を付ける。
    for x0, x1 in islands:
        svg.rect(x0, top, x1 - x0, bottom - top, "#e4e8ef", "#c6ccda", 1.2, rx=10)
    svg.rect(440, 72, 22, 14, "#e4e8ef", "#c6ccda", 1.2, rx=3)
    svg.text(470, 84, "= 実際の発話の位置(発話島)", 13, SUB)

    rows = [
        (168, "1. ASRの時刻のまま", "最大1〜2秒ずれることがある", RED, RED_FILL, -70, 0),
        (300, "2. fa-zhで求め直す", "ほぼ合うが端が少し早い", BLUE, BLUE_FILL, -18, -10),
        (432, "3. VADスナップ", "端の差(±0.35秒以内)を合わせる", GREEN, GREEN_FILL, 0, 0),
    ]
    for cy, title, sub, color, fill, off0, off1 in rows:
        svg.text(24, cy - 26, title, 15, color, "bold")
        svg.text(24, cy - 4, sub, 12.5, SUB)
        svg.axis(260, 936, cy)
        for (ix0, ix1), off in [(islands[0], off0), (islands[1], off1)]:
            uw, ugap, n = 56, 6, 4
            span = n * (uw + ugap) - ugap
            start = ix0 + (ix1 - ix0 - span) / 2 + off
            # 段階3は端へ吸着した状態を描く: 先頭単位は島の左端、末尾単位は右端に一致させる
            if off == 0 and cy == 432:
                start = ix0
                uw = (ix1 - ix0 - (n - 1) * ugap) / n
            for i in range(n):
                x = start + i * (uw + ugap)
                svg.rect(x, cy - 22, uw, 44, fill, color, 1.6, rx=6, opacity=0.85)

    svg.text(
        24, 536,
        "同じ認識単位の列が、段階を経て実際の発話位置と重なっていく。位置は模式値で、実測の一例は前後比較の図を参照。",
        14, SUB,
    )
    svg.save("comparison-playback-timeline-correction.svg")


def fig_correspondence() -> None:
    # 同じフレーズでも音声ごとに単位の数と番号が違うことを、LLMの対応表を挟んで示す
    svg = Svg(960, 470)
    svg.text(24, 38, "対応表: 同じフレーズでも、お手本と復唱で切り出す範囲は違う(模式図)", 17, INK, "bold")

    def unit_row(label, chars, sel, y, number_above):
        x0, w, gap = 250, 56, 8
        svg.text(24, y + 32, label, 14, INK, "bold")
        for i, ch in enumerate(chars):
            x = x0 + i * (w + gap)
            active = i in sel
            svg.rect(x, y, w, 48, BLUE_FILL if active else "#f4f5f8",
                     BLUE if active else ISLAND_EDGE, 1.8 if active else 1.4, rx=7)
            svg.text(x + w / 2, y + 32, ch, 19, BLUE if active else INK, "normal", "middle")
            ny = y - 8 if number_above else y + 66
            svg.text(x + w / 2, ny, str(i), 12, BLUE if active else SUB,
                     "bold" if active else "normal", "middle")
        first, last = min(sel), max(sel)
        return (x0 + first * (w + gap), x0 + last * (w + gap) + w)

    m0, m1 = unit_row("お手本", "已经晚上了再过一会儿", range(5, 10), 104, True)
    r0, r1 = unit_row("復唱(「儿」を言い落とした例)", "已经晚上了再过一会", range(5, 9), 344, False)

    bx, by, bw, bh = 250, 210, 620, 90
    svg.rect(bx, by, bw, bh, "#ffffff", INK, 1.6)
    svg.text(bx + 24, by + 34, "LLMが返す対応表(抜粋)", 14.5, INK, "bold")
    svg.text(bx + 24, by + 64, "フレーズ2 = お手本 単位5〜9 / 復唱 単位5〜8 / 点数82", 15, INK)
    svg.arrow((m0 + m1) / 2, by, (m0 + m1) / 2, 170, BLUE)
    svg.arrow((r0 + r1) / 2, by + bh, (r0 + r1) / 2, 336, BLUE)

    svg.text(
        24, 446,
        "範囲は音声ごとの番号で持つ。復唱に言い落としがあると、同じフレーズでも単位の数と番号は一致しない。点数は模式値。",
        14, SUB,
    )
    svg.save("comparison-playback-correspondence.svg")


def main() -> None:
    fig_mechanism()
    fig_index_contract()
    fig_snap()
    fig_padding()
    fig_before_after()
    fig_timeline_correction()
    fig_correspondence()


if __name__ == "__main__":
    main()
