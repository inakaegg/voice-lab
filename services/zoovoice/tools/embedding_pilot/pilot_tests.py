import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import pilot


class FakeModel:
    def __init__(self, vectors):
        self.vectors = {key: np.asarray(value, dtype=np.float32) for key, value in vectors.items()}

    def encode(self, texts):
        return np.stack([self.vectors[text] for text in texts])


class PilotTest(unittest.TestCase):
    def test_rank_animal_candidates_returns_top_candidates_without_threshold(self):
        model = FakeModel(
            {
                "牧場": [1.0, 0.0],
                "ミルク": [0.8, 0.2],
            }
        )
        animals = [
            {"id": "cow", "label_ja": "牛"},
            {"id": "goat", "label_ja": "ヤギ"},
            {"id": "cat", "label_ja": "猫"},
        ]
        profiles = np.asarray(
            [
                [1.0, 0.0],
                [0.7, 0.3],
                [-1.0, 0.0],
            ],
            dtype=np.float32,
        )

        candidates = pilot.rank_animal_candidates(
            ["牧場", "ミルク"], model, animals, profiles, top_k=3
        )

        self.assertEqual([candidate["id"] for candidate in candidates], ["cow", "goat", "cat"])
        self.assertEqual([candidate["rank"] for candidate in candidates], [1, 2, 3])
        self.assertLess(candidates[-1]["similarity"], 0)

    def test_rank_animal_candidates_rejects_invalid_top_k(self):
        model = FakeModel({"猫": [1.0, 0.0]})
        animals = [{"id": "cat", "label_ja": "猫"}]
        profiles = np.asarray([[1.0, 0.0]], dtype=np.float32)

        with self.assertRaisesRegex(ValueError, "top_k"):
            pilot.rank_animal_candidates(["猫"], model, animals, profiles, top_k=0)
        with self.assertRaisesRegex(ValueError, "top_k"):
            pilot.rank_animal_candidates(["猫"], model, animals, profiles, top_k=2)

    def test_associate_parser_accepts_method_and_text(self):
        args = pilot.build_parser().parse_args(
            [
                "associate",
                "--method",
                "embedding",
                "--text",
                "牧場でミルクをしぼった",
                "--go-binary",
                "/tmp/zoovoice",
                "--model",
                "/tmp/model",
                "--precomputed",
                "/tmp/precomputed",
            ]
        )

        self.assertEqual(args.method, "embedding")
        self.assertEqual(args.text, "牧場でミルクをしぼった")
        self.assertEqual(args.top_k, 5)

    def test_verify_model_artifact_set_rejects_mixed_model_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.safetensors").write_bytes(b"weights")
            (root / "tokenizer.json").write_text("{}", encoding="utf-8")
            provenance = {
                "files": [
                    pilot.file_record(root / "model.safetensors"),
                    pilot.file_record(root / "tokenizer.json"),
                ]
            }

            pilot.verify_model_artifact_set(root, provenance)
            (root / "tokenizer.json").write_text('{"changed":true}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "tokenizer.json"):
                pilot.verify_model_artifact_set(root, provenance)

    def test_associate_embedding_outputs_selected_and_ranked_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            precomputed = root / "precomputed"
            precomputed.mkdir()
            model_directory = root / "model"
            model_directory.mkdir()
            (model_directory / "model.safetensors").write_bytes(b"weights")
            (model_directory / "tokenizer.json").write_text("{}", encoding="utf-8")
            (precomputed / "provenance.json").write_text(
                json.dumps(
                    {
                        "model_id": "example/model",
                        "revision": "fixed",
                        "license": "MIT",
                        "truncate_dim": 2,
                        "files": [
                            pilot.file_record(model_directory / "model.safetensors"),
                            pilot.file_record(model_directory / "tokenizer.json"),
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (precomputed / "animal_profiles.json").write_text(
                json.dumps(
                    [
                        {"id": "cow", "label_ja": "牛"},
                        {"id": "cat", "label_ja": "猫"},
                    ]
                ),
                encoding="utf-8",
            )
            np.save(
                precomputed / "animal_profile_embeddings.npy",
                np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32),
            )
            args = pilot.build_parser().parse_args(
                [
                    "associate",
                    "--method",
                    "embedding",
                    "--text",
                    "牧場でミルクをしぼった",
                    "--go-binary",
                    str(root / "zoovoice"),
                    "--model",
                    str(model_directory),
                    "--precomputed",
                    str(precomputed),
                    "--top-k",
                    "2",
                ]
            )
            output = io.StringIO()
            with (
                mock.patch.object(
                    pilot,
                    "go_result_for_text",
                    return_value=(
                        {
                            "terms": ["牧場", "ミルク"],
                            "embedding_terms": ["牧場", "ミルク"],
                        },
                        None,
                    ),
                ),
                mock.patch.object(
                    pilot,
                    "StaticEmbeddingModel",
                    return_value=FakeModel({"牧場": [1.0, 0.0], "ミルク": [0.8, 0.2]}),
                ),
                contextlib.redirect_stdout(output),
            ):
                pilot.associate_text(args)

            payload = json.loads(output.getvalue())
            self.assertEqual(payload["method"], "embedding")
            self.assertEqual(payload["selected_animal"], {"id": "cow", "label_ja": "牛"})
            self.assertEqual([item["id"] for item in payload["candidates"]], ["cow", "cat"])
            self.assertEqual(payload["association"]["strategy"], "embedding_profile")

    def test_associate_conceptnet_outputs_current_selection(self):
        args = pilot.build_parser().parse_args(
            [
                "associate",
                "--method",
                "conceptnet",
                "--text",
                "犬が走る",
                "--go-binary",
                "/tmp/zoovoice",
                "--lexicon",
                "/tmp/animal-lexicon.json",
                "--index",
                "/tmp/conceptnet.sqlite",
            ]
        )
        output = io.StringIO()
        with (
            mock.patch.object(
                pilot,
                "go_result_for_text",
                return_value=(
                    {"terms": ["犬", "走る"], "embedding_terms": ["犬", "走る"]},
                    {
                        "selection": {
                            "species": "dog",
                            "label_ja": "犬",
                            "evidence_term": "犬",
                            "strategy": "direct",
                        }
                    },
                ),
            ),
            contextlib.redirect_stdout(output),
        ):
            pilot.associate_text(args)

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["method"], "conceptnet")
        self.assertEqual(payload["selected_animal"], {"id": "dog", "label_ja": "犬"})
        self.assertEqual(payload["association"]["strategy"], "direct")

    def test_expand_terms_keeps_best_unique_neighbors(self):
        model = FakeModel(
            {
                "飛ぶ": [1.0, 0.0],
                "空": [0.8, 0.2],
            }
        )
        concepts = ["飛行", "翼", "海"]
        matrix = np.asarray([[1.0, 0.0], [0.9, 0.1], [0.0, 1.0]], dtype=np.float32)

        expansions, details = pilot.expand_terms(
            ["飛ぶ", "空"], model, concepts, matrix, threshold=0.7, top_k=2
        )

        self.assertEqual(expansions, ["飛行", "翼"])
        self.assertEqual(details[0]["concept"], "飛行")
        self.assertGreaterEqual(details[0]["similarity"], details[1]["similarity"])

    def test_profile_candidate_preserves_literal_and_replaces_conceptnet(self):
        model = FakeModel({"猫": [1.0, 0.0], "夜": [0.0, 1.0]})
        extracted = [
            {"id": "literal", "role": "regression", "kind": "direct", "input": "猫", "terms": ["ネコ"], "embedding_terms": ["猫"]},
            {"id": "semantic", "role": "development", "kind": "conceptnet", "input": "夜", "terms": ["ヨル"], "embedding_terms": ["夜"]},
        ]
        baseline = [
            {
                "id": "literal",
                "role": "regression",
                "kind": "direct",
                "input": "猫",
                "candidate": "A",
                "selection": {"species": "cat", "label_ja": "猫", "evidence_term": "猫", "strategy": "direct"},
            },
            {
                "id": "semantic",
                "role": "development",
                "kind": "conceptnet",
                "input": "夜",
                "candidate": "A",
                "selection": {"species": "cat", "label_ja": "猫", "evidence_term": "夜", "strategy": "conceptnet"},
            },
        ]
        fixtures = [
            {"id": "literal", "acceptable_animals": ["cat"], "expected_strategy": ["direct"]},
            {"id": "semantic", "acceptable_animals": ["owl"], "expected_strategy": ["conceptnet"]},
        ]
        animals = [
            {"id": "cat", "label_ja": "猫"},
            {"id": "owl", "label_ja": "フクロウ"},
        ]
        profiles = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)

        results = pilot.profile_candidate_results(
            extracted,
            baseline,
            fixtures,
            model,
            animals,
            profiles,
            threshold=0.8,
            seed=7,
        )

        self.assertEqual(results[0]["selection"]["strategy"], "direct")
        self.assertEqual(results[1]["selection"]["species"], "owl")
        self.assertEqual(results[1]["selection"]["strategy"], "embedding_profile")
        self.assertTrue(results[1]["semantic_ok"])

    def test_metrics_use_all_inputs_as_denominator(self):
        results = [
            {"selection": {"strategy": "conceptnet"}, "contract_ok": True},
            {"selection": {"strategy": "random_fallback"}, "contract_ok": True},
            {"error": {"code": "asr_empty"}, "contract_ok": True},
        ]
        metrics = pilot.summarize_results(results)
        self.assertEqual(metrics["total"], 3)
        self.assertAlmostEqual(metrics["association_path_rate"], 1 / 3)
        self.assertAlmostEqual(metrics["random_fallback_rate"], 1 / 3)
        self.assertAlmostEqual(metrics["error_rate"], 1 / 3)

    def test_blind_sheet_hides_candidate_and_has_separate_key(self):
        results = {
            "A": [{"id": "one", "input": "夜", "selection": {"species": "owl", "label_ja": "フクロウ", "evidence_term": "夜"}}],
            "B": [{"id": "one", "input": "夜", "selection": {"species": "cat", "label_ja": "猫", "evidence_term": "夜"}}],
        }
        sheet, key = pilot.build_blind_comparison(results, seed=9)
        encoded = json.dumps(sheet, ensure_ascii=False)
        self.assertNotIn('"candidate"', encoded)
        self.assertEqual({entry["candidate"] for entry in key}, {"A", "B"})
        self.assertEqual(len(sheet[0]["options"]), 2)

    def test_grid_selection_rejects_invalid_path_when_semantic_score_ties(self):
        baseline_like = [
            {"selection": {"strategy": "random_fallback"}, "contract_ok": False},
            {"selection": {"strategy": "conceptnet"}, "contract_ok": True},
        ]
        false_path = [
            {"selection": {"strategy": "conceptnet"}, "contract_ok": False},
            {"selection": {"strategy": "conceptnet"}, "contract_ok": True},
        ]
        chosen, _ = pilot.choose_result(
            [((1.01, 1), baseline_like), ((0.65, 1), false_path)]
        )
        self.assertEqual(chosen, (1.01, 1))

    def test_static_model_matches_mean_without_special_tokens(self):
        try:
            from safetensors.numpy import save_file
            from tokenizers import Tokenizer, models, pre_tokenizers
        except ImportError as exc:
            self.skipTest(str(exc))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0, "猫": 1, "犬": 2}, unk_token="[UNK]"))
            tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
            tokenizer.save(str(root / "tokenizer.json"))
            save_file(
                {"embedding.weight": np.asarray([[0, 0], [2, 0], [0, 2]], dtype=np.float32)},
                str(root / "model.safetensors"),
            )
            model = pilot.StaticEmbeddingModel(root)
            np.testing.assert_allclose(model.encode(["猫 犬"]), [[1, 1]])


if __name__ == "__main__":
    unittest.main()
