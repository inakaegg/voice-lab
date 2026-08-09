#!/usr/bin/env python3
"""自動トリムで鳴き声本体が消えてしまい、やむなく 30 秒の 24k 原音を選び直した音源を、
人が確認した位置で切り直す。

背景（CONCEPT.md 指示欄）:
  final に音の長いものが残っている。それらは自動トリムが無音判定を誤り、鳴き声の
  ない区間を切り出してしまったため、元の 24k ファイルをそのまま採用したものである。

対象の切り出し位置は、帯域エネルギーと純音らしさ（帯域内ピーク / 帯域平均）を見て
鳴き声そのものが鳴っている区間を特定し、下の WINDOWS に書き留めた。
出力は元ファイルと同じディレクトリへ `*_retrimmed.wav` として置く。
選別スクリプト (select_animal_sounds.py) は retrimmed があれば 24k 原音を使わない。
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tmp1" / "animal-sound-freesound"

FADE_SECONDS = 0.03

# (元ファイル, 開始秒, 終了秒, 採用理由)
WINDOWS = [
    (
        "bush-warbler/candidate1_24k.wav",
        0.75,
        2.15,
        "ウグイスのさえずり（約2.2kHzの伸ばし音から囀りへ）が丸ごと入る区間。"
        "29秒付近にもう一声あるが、ファイル終端で途切れている。",
    ),
    (
        "bullfrog/candidate1_24k.wav",
        6.15,
        8.45,
        "211Hz のウシガエルの鳴き声が2声そろって入る、最も大きい区間。"
        "9秒以降は環境音だけで、元の自動トリム（15.1〜20.1秒）はそこを切っていた。",
    ),
]


def read_wav(path: Path) -> tuple[np.ndarray, int, int, int]:
    with wave.open(str(path)) as w:
        params = w.getparams()
        raw = w.readframes(w.getnframes())
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if params.nchannels == 2:
        data = data.reshape(-1, 2)
    return data, params.framerate, params.nchannels, params.sampwidth


def write_wav(path: Path, data: np.ndarray, rate: int, channels: int, width: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(np.clip(data, -32768, 32767).astype(np.int16).tobytes())


def apply_fade(data: np.ndarray, rate: int) -> np.ndarray:
    n = int(rate * FADE_SECONDS)
    if n * 2 >= len(data):
        return data
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    out = data.copy()
    if out.ndim == 2:
        ramp = ramp[:, None]
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def main() -> None:
    for rel, start, end, reason in WINDOWS:
        src = SRC / rel
        data, rate, channels, width = read_wav(src)
        clip = apply_fade(data[int(start * rate) : int(end * rate)], rate)
        dest = src.with_name(src.name.replace("_24k.wav", "_retrimmed.wav"))
        write_wav(dest, clip, rate, channels, width)
        peak = float(np.abs(clip).max()) / 32768
        print(
            f"{rel}: {start:.2f}〜{end:.2f}秒 ({end - start:.2f}秒) → "
            f"{dest.relative_to(SRC.parent)} peak={peak:.2f}\n  理由: {reason}"
        )


if __name__ == "__main__":
    main()
