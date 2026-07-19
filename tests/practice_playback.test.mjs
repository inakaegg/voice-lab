import assert from "node:assert/strict";
import test from "node:test";

await import("../src/mo_speech/web/practice_playback.js");

const {
  comparisonPlaybackPlan,
  comparisonRangeForTargetOffset,
  shouldStopAudioSegment,
  buildPracticeDiffCells,
  compactPracticeDiffCells,
} = globalThis.voiceLabPracticePlayback;

const completeModel = {
  available: true,
  complete: true,
  all_phrases_playable: true,
  target_phrase_count: 2,
  phrases: [
    { index: 0, available: true, audio_start: 0.1, audio_end: 0.9 },
    { index: 1, available: true, audio_start: 1.0, audio_end: 2.0 },
  ],
};

test("comparison playback uses one plan for the visible label and actual phrase mode", () => {
  const plan = comparisonPlaybackPlan({
    modelReady: true,
    repeatReady: true,
    resultVisible: true,
    outcome: "scored",
    recognizedLanguageMatches: true,
    attemptAlignment: completeModel,
    modelAlignment: completeModel,
    modelDuration: 2.2,
    repeatDuration: 2.2,
  });

  assert.equal(plan.mode, "phrase");
  assert.equal(plan.label, "フレーズごと比較再生");
  assert.equal(plan.description, "2/2フレーズを順番に比較できます。");
  assert.equal(plan.ranges.length, 2);
});

test("partial paired ranges stay in partial phrase mode and use a matching label", () => {
  const partialAttempt = {
    available: true,
    complete: false,
    all_phrases_playable: false,
    target_phrase_count: 2,
    phrases: [
      { index: 0, available: false, audio_start: null, audio_end: null },
      { index: 1, available: true, audio_start: 1.1, audio_end: 2.1 },
    ],
  };
  const plan = comparisonPlaybackPlan({
    modelReady: true,
    repeatReady: true,
    resultVisible: true,
    outcome: "scored",
    recognizedLanguageMatches: true,
    attemptAlignment: partialAttempt,
    modelAlignment: completeModel,
    modelDuration: 2.2,
    repeatDuration: 2.2,
  });

  assert.equal(plan.mode, "partial_phrase");
  assert.equal(plan.label, "一部フレーズ比較再生");
  assert.equal(plan.description, "確認できた1/2フレーズを順番に比較します。");
  assert.deepEqual(plan.ranges.map((range) => range.index), [1]);
});

test("whole comparison and no-speech never report phrase playback", () => {
  const noPair = { available: false, complete: false, target_phrase_count: 2, phrases: [] };
  const whole = comparisonPlaybackPlan({
    modelReady: true,
    repeatReady: true,
    resultVisible: true,
    outcome: "scored",
    recognizedLanguageMatches: true,
    attemptAlignment: noPair,
    modelAlignment: completeModel,
    modelDuration: 2.2,
    repeatDuration: 2.2,
  });
  const noSpeech = comparisonPlaybackPlan({
    modelReady: true,
    repeatReady: true,
    resultVisible: true,
    outcome: "no_speech",
    recognizedLanguageMatches: false,
    attemptAlignment: noPair,
    modelAlignment: completeModel,
    modelDuration: 2.2,
    repeatDuration: 2.2,
  });

  assert.deepEqual({ mode: whole.mode, label: whole.label }, { mode: "whole", label: "全体比較再生" });
  assert.equal(whole.description, "フレーズの区切りを確認できなかったため、全体を比較します。");
  assert.deepEqual({ mode: noSpeech.mode, label: noSpeech.label }, { mode: "model", label: "お手本を再生" });
  assert.equal(noSpeech.description, "");
});

test("segment playback stops at the exact end instead of 30ms early", () => {
  assert.equal(shouldStopAudioSegment({ active: true, ended: false, currentTime: 0.969, segmentEnd: 1.0 }), false);
  assert.equal(shouldStopAudioSegment({ active: true, ended: false, currentTime: 1.0, segmentEnd: 1.0 }), true);
  assert.equal(shouldStopAudioSegment({ active: false, ended: false, currentTime: 0.5, segmentEnd: 1.0 }), true);
});

test("a heard-word difference selects the paired range for its target phrase", () => {
  const alignment = {
    ...completeModel,
    phrases: [
      { ...completeModel.phrases[0], target_text: "Please open the window." },
      { ...completeModel.phrases[1], target_text: "Then sit down." },
    ],
  };
  const plan = comparisonPlaybackPlan({
    modelReady: true,
    repeatReady: true,
    resultVisible: true,
    outcome: "scored",
    recognizedLanguageMatches: true,
    attemptAlignment: alignment,
    modelAlignment: alignment,
    modelDuration: 2.2,
    repeatDuration: 2.2,
  });

  const selected = comparisonRangeForTargetOffset({
    targetText: "Please open the window. Then sit down.",
    targetOffset: 24,
    alignment,
    ranges: plan.ranges,
  });

  assert.equal(selected?.index, 1);
  assert.deepEqual(selected?.model, { start: 1, end: 2 });
  assert.deepEqual(selected?.repeat, { start: 1, end: 2 });
});

test("a heard-word difference uses the punctuation-free display offset on both sides of a phrase boundary", () => {
  const alignment = {
    available: true,
    complete: true,
    target_phrase_count: 2,
    phrases: [
      { index: 0, target_text: "こんにちは、世界です。", available: true, audio_start: 0.1, audio_end: 1.2 },
      { index: 1, target_text: "次です。", available: true, audio_start: 1.3, audio_end: 2.0 },
    ],
  };
  const ranges = [
    { index: 0, model: { start: 0.1, end: 1.2 }, repeat: { start: 0.2, end: 1.3 } },
    { index: 1, model: { start: 1.3, end: 2.0 }, repeat: { start: 1.4, end: 2.1 } },
  ];

  const precedingPhrase = comparisonRangeForTargetOffset({
    targetText: "こんにちは、世界です。次です。",
    targetOffset: 8,
    alignment,
    ranges,
  });
  const followingPhrase = comparisonRangeForTargetOffset({
    targetText: "こんにちは、世界です。次です。",
    targetOffset: 9,
    alignment,
    ranges,
  });

  assert.equal(precedingPhrase?.index, 0);
  assert.equal(followingPhrase?.index, 1);
});

test("a heard-word difference does not fall back to the whole recording without a paired phrase", () => {
  const alignment = {
    available: true,
    complete: false,
    target_phrase_count: 2,
    phrases: [
      { index: 0, target_text: "First.", available: true, audio_start: 0.1, audio_end: 0.9 },
      { index: 1, target_text: "Second.", available: false, audio_start: null, audio_end: null },
    ],
  };

  const selected = comparisonRangeForTargetOffset({
    targetText: "First. Second.",
    targetOffset: 6,
    alignment,
    ranges: [{ index: 0, model: { start: 0.1, end: 0.9 }, repeat: { start: 0.1, end: 0.9 } }],
  });

  assert.equal(selected, null);
});

test("a plain substitution without pinyin data stays a substitute cell (no behavior change without data)", () => {
  const cells = buildPracticeDiffCells("是晚上", "洗完上");
  assert.deepEqual(cells.map((c) => c.type), ["substitute", "substitute", "equal"]);
});

test("a homophone recognized in place of the target character is treated as correct", () => {
  // 目標「的」・復唱「地」はどちらも de (声調まで同じ)。ASRが同音の別字を選んだだけで、
  // 学習者の発音自体は正しいので赤字にしない。
  const cells = buildPracticeDiffCells("的", "地", {
    target: ["de5"],
    recognized: ["de5"],
  });
  assert.deepEqual(cells, [{ type: "equal", correction: "", heard: "地", targetOffset: 0 }]);
});

test("a same-syllable different-tone recognition is flagged as a tone mismatch, not a full substitution", () => {
  // 目標「晚」(wan3)に対し「完」(wan2)は音節は同じで声調だけ違う。
  const cells = buildPracticeDiffCells("晚", "完", {
    target: ["wan3"],
    recognized: ["wan2"],
  });
  assert.deepEqual(cells, [{ type: "tone", correction: "晚", heard: "完", targetOffset: 0 }]);
});

test("a genuinely different syllable stays a full substitution even with pinyin data available", () => {
  // 目標「可能」(ke3 neng2)に対し復唱「刚刚」(gang1 gang1)は音節自体が違う実際の誤り。
  const cells = buildPracticeDiffCells("可能", "刚刚", {
    target: ["ke3", "neng2"],
    recognized: ["gang1", "gang1"],
  });
  assert.deepEqual(cells.map((c) => c.type), ["substitute", "substitute"]);
});

test("compacting merges consecutive equal characters and, separately, consecutive same-type mismatches", () => {
  const cells = [
    { type: "equal", correction: "", heard: "你", targetOffset: 0 },
    { type: "equal", correction: "", heard: "好", targetOffset: 1 },
    { type: "substitute", correction: "可", heard: "刚", targetOffset: 2 },
    { type: "substitute", correction: "能", heard: "刚", targetOffset: 3 },
    { type: "equal", correction: "", heard: "了", targetOffset: 4 },
  ];
  const compacted = compactPracticeDiffCells(cells);
  assert.deepEqual(compacted, [
    { type: "equal", correction: "", heard: "你好", targetOffset: 0 },
    { type: "substitute", correction: "可能", heard: "刚刚", targetOffset: 2 },
    { type: "equal", correction: "", heard: "了", targetOffset: 4 },
  ]);
});

test("compacting does not merge across different mismatch types", () => {
  const cells = [
    { type: "substitute", correction: "可", heard: "刚", targetOffset: 0 },
    { type: "tone", correction: "晚", heard: "完", targetOffset: 1 },
    { type: "delete", correction: "了", heard: "_", targetOffset: 2 },
    { type: "delete", correction: "吗", heard: "_", targetOffset: 3 },
  ];
  const compacted = compactPracticeDiffCells(cells);
  assert.deepEqual(compacted.map((c) => c.type), ["substitute", "tone", "delete"]);
  assert.deepEqual(compacted[2], { type: "delete", correction: "了吗", heard: "_", targetOffset: 2 });
});

test("a real logged mismatch (可能 heard as 刚刚) compacts to one readable cell end to end", () => {
  const cells = compactPracticeDiffCells(buildPracticeDiffCells("可能", "刚刚", {
    target: ["ke3", "neng2"],
    recognized: ["gang1", "gang1"],
  }));
  assert.deepEqual(cells, [{ type: "substitute", correction: "可能", heard: "刚刚", targetOffset: 0 }]);
});
