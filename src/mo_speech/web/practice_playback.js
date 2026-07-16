(function practicePlaybackContract(global) {
  function availableRanges(alignment) {
    if (!Array.isArray(alignment?.ranges)) return [];
    return alignment.ranges.filter((range) => {
      const start = Number(range?.audio_start);
      const end = Number(range?.audio_end);
      return range?.available === true && Number.isFinite(start) && Number.isFinite(end) && end > start;
    });
  }

  function pairedRanges(attemptAlignment, modelAlignment, modelDuration, repeatDuration) {
    const modelByIndex = new Map(availableRanges(modelAlignment).map((range) => [Number(range.index), range]));
    return availableRanges(attemptAlignment).map((attempt) => {
      const model = modelByIndex.get(Number(attempt.index));
      if (!model) return null;
      const range = {
        index: Number(attempt.index),
        model: {
          start: Math.max(0, Math.min(Number(model.audio_start), modelDuration)),
          end: Math.max(0, Math.min(Number(model.audio_end), modelDuration)),
        },
        repeat: {
          start: Math.max(0, Math.min(Number(attempt.audio_start), repeatDuration)),
          end: Math.max(0, Math.min(Number(attempt.audio_end), repeatDuration)),
        },
      };
      return range.model.end > range.model.start && range.repeat.end > range.repeat.start ? range : null;
    }).filter(Boolean);
  }

  function comparisonPlaybackPlan(options) {
    if (!options.modelReady) return { mode: "none", label: "再生", ranges: [] };
    if (options.outcome === "no_speech" || !options.repeatReady || !options.resultVisible) {
      return { mode: "model", label: "再生", ranges: [] };
    }
    const modelDuration = Number(options.modelDuration);
    const repeatDuration = Number(options.repeatDuration);
    if (
      !options.recognizedLanguageMatches ||
      !Number.isFinite(modelDuration) || modelDuration <= 0 ||
      !Number.isFinite(repeatDuration) || repeatDuration <= 0
    ) {
      return { mode: "whole", label: "全体比較再生", ranges: [] };
    }
    const ranges = pairedRanges(
      options.attemptAlignment,
      options.modelAlignment,
      modelDuration,
      repeatDuration,
    );
    if (!ranges.length) return { mode: "whole", label: "全体比較再生", ranges: [] };
    const targetCount = Math.max(
      Number(options.attemptAlignment?.target_phrase_count || 0),
      Number(options.modelAlignment?.target_phrase_count || 0),
    );
    const complete =
      options.attemptAlignment?.complete === true &&
      options.modelAlignment?.complete === true &&
      (!targetCount || ranges.length === targetCount);
    return {
      mode: complete ? "phrase" : "partial_phrase",
      label: complete ? "フレーズごと比較再生" : "一部フレーズ比較再生",
      ranges,
    };
  }

  function shouldStopAudioSegment({ active, ended, currentTime, segmentEnd }) {
    return !active || ended || Number(currentTime) >= Number(segmentEnd);
  }

  global.voiceLabPracticePlayback = { comparisonPlaybackPlan, shouldStopAudioSegment };
})(globalThis);
