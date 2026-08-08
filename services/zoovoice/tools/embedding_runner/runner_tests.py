import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

import runner


class FakeEmbedder:
    """語ごとに固定ベクトルを返す。未知語は原点付近へ落とす。"""

    load_seconds = 0.0

    def __init__(self, vectors):
        self.vectors = {key: np.asarray(value, dtype=np.float32) for key, value in vectors.items()}

    def encode(self, texts, prefix):
        rows = []
        for text in texts:
            body = text[len(prefix):] if prefix and text.startswith(prefix) else text
            rows.append(self.vectors.get(body, np.asarray([0.01, 0.01], dtype=np.float32)))
        return np.stack(rows)


class RunnerTest(unittest.TestCase):
    def test_artifact_contract_identifies_median_bias_floor(self):
        self.assertEqual(runner.ARTIFACT_VERSION, 2)
        self.assertEqual(runner.BIAS_STD_FLOOR, "median_background_std")

    def test_load_animals_merges_terms_and_onomatopoeia(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lexicon.json"
            path.write_text(
                json.dumps(
                    {
                        "animals": [
                            {
                                "id": "cat",
                                "label_ja": "猫",
                                "terms": ["ねこ"],
                                "onomatopoeia": ["にゃー"],
                            }
                        ]
                    },
                    ensure_ascii=False,
                )
            )

            animals = runner.load_animals(path)

            self.assertEqual(animals[0]["id"], "cat")
            self.assertEqual(animals[0]["terms"], ["ねこ", "にゃー", "猫"])

    def test_load_animals_rejects_empty_lexicon(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lexicon.json"
            path.write_text(json.dumps({"animals": []}))

            with self.assertRaises(ValueError):
                runner.load_animals(path)

    def test_compute_bias_scores_hub_animals_higher(self):
        embedder = FakeEmbedder({sentence: [1.0, 0.0] for sentence in runner.BACKGROUND_SENTENCES})
        profiles = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)

        bias_mean, bias_std = runner.compute_bias(embedder, profiles)

        self.assertGreater(float(bias_mean[0]), float(bias_mean[1]))
        self.assertTrue(np.all(bias_std > 0))

    def test_compute_bias_uses_median_deviation_as_floor(self):
        vectors = {
            sentence: ([1.0, 0.0, 0.0] if index < 8 else [0.8, 0.6, 0.0])
            for index, sentence in enumerate(runner.BACKGROUND_SENTENCES)
        }
        embedder = FakeEmbedder(vectors)
        profiles = np.eye(3, dtype=np.float32)
        scores = runner.normalized_rows(
            embedder.encode(list(runner.BACKGROUND_SENTENCES), runner.QUERY_PREFIX)
        ) @ profiles.T
        raw_std = scores.std(axis=0)

        _, bias_std = runner.compute_bias(embedder, profiles)

        np.testing.assert_allclose(bias_std, np.maximum(raw_std, np.median(raw_std)))
        self.assertGreater(float(bias_std[2]), float(raw_std[2]))

    def test_rank_animals_demotes_hub_animal_with_bias(self):
        vectors = {sentence: [1.0, 0.0] for sentence in runner.BACKGROUND_SENTENCES}
        vectors["夜の森を歩いた"] = [0.8, 0.6]
        embedder = FakeEmbedder(vectors)
        animals = [{"id": "hub", "label_ja": "ハブ動物"}, {"id": "owl", "label_ja": "フクロウ"}]
        profiles = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        bias_mean, bias_std = runner.compute_bias(embedder, profiles)

        raw = runner.rank_animals(embedder, "夜の森を歩いた", animals, profiles, None, None, 2)
        debiased = runner.rank_animals(
            embedder, "夜の森を歩いた", animals, profiles, bias_mean, bias_std, 2
        )

        self.assertEqual(raw[0]["id"], "hub")
        self.assertEqual(debiased[0]["id"], "owl")

    def test_rank_animals_clamps_top_k_to_animal_count(self):
        embedder = FakeEmbedder({"入力": [1.0, 0.0]})
        animals = [{"id": "cat", "label_ja": "猫"}, {"id": "dog", "label_ja": "犬"}]
        profiles = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)

        candidates = runner.rank_animals(embedder, "入力", animals, profiles, None, None, 99)

        self.assertEqual(len(candidates), 2)
        self.assertEqual([item["rank"] for item in candidates], [1, 2])

    def test_associate_parser_defaults_to_debiased_output(self):
        args = runner.build_parser().parse_args(
            ["associate", "--model", "m", "--artifacts", "a", "--text", "入力"]
        )

        self.assertFalse(args.no_debias)
        self.assertEqual(args.top_k, 5)
        self.assertEqual(args.threads, 2)


if __name__ == "__main__":
    unittest.main()
