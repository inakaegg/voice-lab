import sqlite3
import tempfile
import unittest
from pathlib import Path

import reevaluate


class ReevaluationTest(unittest.TestCase):
    def test_synonym_expansions_filter_pos_cap_per_term_and_deduplicate(self):
        connection = sqlite3.connect(":memory:")
        connection.execute(
            "CREATE TABLE synonyms(term TEXT, synonym TEXT, part_of_speech TEXT, synset TEXT)"
        )
        connection.executemany(
            "INSERT INTO synonyms VALUES(?,?,?,?)",
            [
                ("喉", "咽喉", "n", "n1"),
                ("喉", "咽喉", "n", "n2"),
                ("喉", "喉", "n", "n1"),
                ("喉", "乾く", "v", "v1"),
                ("喉", "渇いた", "a", "a1"),
                ("走る", "駆ける", "v", "v2"),
                ("走る", "疾走", "n", "n3"),
            ],
        )
        extracted = [{"id": "one", "terms": ["喉", "走る", "喉", ""]}]

        expansions, details = reevaluate.synonym_expansions(
            connection, extracted, allowed_pos={"n", "v"}, per_term_limit=1
        )

        self.assertEqual(expansions, {"one": ["乾く", "疾走"]})
        self.assertEqual(
            details["one"],
            [
                {"source_term": "喉", "synonym": "乾く", "part_of_speech": "v"},
                {"source_term": "走る", "synonym": "疾走", "part_of_speech": "n"},
            ],
        )

    def test_embedding_only_replaces_random_fallback_above_threshold(self):
        fixtures = [
            {"id": "kept", "input": "牧場", "acceptable_animals": ["cow"], "expected_strategy": ["conceptnet"]},
            {"id": "adopted", "input": "猫の気配", "acceptable_animals": ["cat"], "expected_strategy": ["random_fallback"]},
            {"id": "rejected", "input": "会議", "acceptable_animals": [], "expected_strategy": ["random_fallback"]},
        ]
        baseline = [
            {"id": "kept", "selection": {"species": "cow", "label_ja": "牛", "strategy": "conceptnet"}},
            {"id": "adopted", "selection": {"species": "dog", "label_ja": "犬", "strategy": "random_fallback"}},
            {"id": "rejected", "selection": {"species": "dog", "label_ja": "犬", "strategy": "random_fallback"}},
        ]
        embedding = {
            "adopted": {"candidates": [{"id": "cat", "label_ja": "猫", "score": 3.2}]},
            "rejected": {"candidates": [{"id": "cat", "label_ja": "猫", "score": 2.9}]},
        }

        results = reevaluate.embedding_fallback_results(
            fixtures, baseline, embedding, threshold=3.0
        )

        by_id = {item["id"]: item for item in results}
        self.assertEqual(by_id["kept"]["selection"]["strategy"], "conceptnet")
        self.assertEqual(by_id["adopted"]["selection"]["species"], "cat")
        self.assertEqual(by_id["adopted"]["selection"]["strategy"], "embedding_profile")
        self.assertEqual(by_id["rejected"]["selection"]["strategy"], "random_fallback")
        self.assertTrue(by_id["adopted"]["semantic_ok"])
        self.assertTrue(by_id["rejected"]["semantic_ok"])

    def test_semantic_ok_rejects_unexpected_path_when_no_animal_label_exists(self):
        fixture = {
            "id": "unknown",
            "acceptable_animals": [],
            "expected_strategy": ["random_fallback"],
        }
        result = {
            "id": "unknown",
            "selection": {"species": "cat", "strategy": "embedding_profile"},
        }

        self.assertFalse(reevaluate.semantic_ok(fixture, result))

    def test_compare_to_baseline_counts_improvement_regression_and_unchanged(self):
        baseline = [
            {"id": "better", "semantic_ok": False},
            {"id": "worse", "semantic_ok": True},
            {"id": "same", "semantic_ok": True},
        ]
        candidate = [
            {"id": "better", "semantic_ok": True},
            {"id": "worse", "semantic_ok": False},
            {"id": "same", "semantic_ok": True},
        ]

        self.assertEqual(
            reevaluate.compare_to_baseline(baseline, candidate),
            {"improved": 1, "regressed": 1, "unchanged": 1},
        )

    def test_result_ids_must_match_fixture_ids(self):
        with self.assertRaisesRegex(ValueError, "result IDs"):
            reevaluate.validate_result_ids(
                [{"id": "one"}, {"id": "two"}],
                [{"id": "one"}, {"id": "other"}],
            )

    def test_filter_fixtures_and_metrics_keep_roles_separate(self):
        fixtures = [
            {"id": "dev", "role": "development"},
            {"id": "reg", "role": "regression"},
            {"id": "hold", "role": "held-out"},
        ]
        selected = reevaluate.filter_fixtures(fixtures, {"regression", "held-out"})
        results = [
            {"id": "reg", "semantic_ok": True, "selection": {"strategy": "conceptnet"}},
            {"id": "hold", "semantic_ok": False, "selection": {"strategy": "random_fallback"}},
        ]

        self.assertEqual([item["id"] for item in selected], ["reg", "hold"])
        self.assertEqual(
            reevaluate.metrics_by_role(selected, results),
            {
                "held-out": {
                    "total": 1,
                    "semantic_ok_count": 0,
                    "association_path_count": 0,
                    "random_fallback_count": 1,
                    "error_count": 0,
                    "strategies": {"random_fallback": 1},
                },
                "regression": {
                    "total": 1,
                    "semantic_ok_count": 1,
                    "association_path_count": 1,
                    "random_fallback_count": 0,
                    "error_count": 0,
                    "strategies": {"conceptnet": 1},
                },
            },
        )

    def test_embedding_referenced_size_excludes_unused_model_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model"
            artifacts = root / "artifacts"
            model.mkdir()
            artifacts.mkdir()
            (model / "model_int8.onnx").write_bytes(b"1234")
            (model / "tokenizer.json").write_bytes(b"123")
            (model / "unused.onnx").write_bytes(b"12345")
            (artifacts / "manifest.json").write_text(
                '{"onnx_file":"model_int8.onnx"}', encoding="utf-8"
            )

            self.assertEqual(reevaluate.embedding_referenced_size(model, artifacts), 7)


if __name__ == "__main__":
    unittest.main()
