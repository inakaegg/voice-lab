import assert from "node:assert/strict";
import test from "node:test";

await import("../src/mo_speech/web/practice_playback.js");

const { comparisonPlaybackPlan, shouldStopAudioSegment } = globalThis.voiceLabPracticePlayback;

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
