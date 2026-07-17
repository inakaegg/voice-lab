import assert from "node:assert/strict";
import test from "node:test";

await import("../src/mo_speech/web/practice_playback.js");

const {
  comparisonPlaybackPlan,
  comparisonRangeForTargetOffset,
  shouldStopAudioSegment,
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
  const noPair = { available: false, complete: false, target_phrase_count: 2, ranges: [] };
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

test("stored legacy ranges remain playable during the canonical migration", () => {
  const legacy = {
    available: true,
    complete: true,
    target_phrase_count: 1,
    ranges: [{ index: 0, available: true, audio_start: 0.2, audio_end: 1.2 }],
  };
  const plan = comparisonPlaybackPlan({
    modelReady: true,
    repeatReady: true,
    resultVisible: true,
    outcome: "evaluated",
    recognizedLanguageMatches: true,
    attemptAlignment: legacy,
    modelAlignment: legacy,
    modelDuration: 1.4,
    repeatDuration: 1.4,
  });

  assert.equal(plan.mode, "phrase");
  assert.equal(plan.ranges.length, 1);
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
