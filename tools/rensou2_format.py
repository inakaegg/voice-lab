#!/usr/bin/env python3
"""runnerのJSON出力を読みやすい日本語へ整形する。"""
import json
import sys

data = json.load(sys.stdin)
if "error" in data:
    print(f"エラー: {data['error']['message']}")
    raise SystemExit(2)

print(f"入力: {data['input']}")
selected = data["selected_animal"]
print(f"選択: {selected['label_ja']}  (score {data['score']:.2f})")
print("上位候補:")
for candidate in data["candidates"]:
    print(f"  {candidate['rank']}. {candidate['label_ja']:<8} {candidate['score']:.2f}")
timing = data["timing"]
print(f"所要: {timing['total_ms']:.0f}ms (うちモデル読み込み {timing['model_load_ms']:.0f}ms)")
