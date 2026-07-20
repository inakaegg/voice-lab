(function practicePlaybackContract(global) {
  function availableRanges(alignment) {
    const entries = Array.isArray(alignment?.phrases) ? alignment.phrases : [];
    return entries.filter((range) => {
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
    if (!options.modelReady) return { mode: "none", label: "お手本を再生", description: "", ranges: [] };
    if (options.outcome === "no_speech" || !options.repeatReady || !options.resultVisible) {
      return { mode: "model", label: "お手本を再生", description: "", ranges: [] };
    }
    const modelDuration = Number(options.modelDuration);
    const repeatDuration = Number(options.repeatDuration);
    if (
      !options.recognizedLanguageMatches ||
      !Number.isFinite(modelDuration) || modelDuration <= 0 ||
      !Number.isFinite(repeatDuration) || repeatDuration <= 0
    ) {
      return {
        mode: "whole",
        label: "全体比較再生",
        description: "フレーズの区切りを確認できなかったため、全体を比較します。",
        ranges: [],
      };
    }
    const ranges = pairedRanges(
      options.attemptAlignment,
      options.modelAlignment,
      modelDuration,
      repeatDuration,
    );
    if (!ranges.length) {
      return {
        mode: "whole",
        label: "全体比較再生",
        description: "フレーズの区切りを確認できなかったため、全体を比較します。",
        ranges: [],
      };
    }
    const targetCount = Math.max(
      Number(options.attemptAlignment?.target_phrase_count || 0),
      Number(options.modelAlignment?.target_phrase_count || 0),
    );
    const complete =
      (options.attemptAlignment?.all_phrases_playable ?? options.attemptAlignment?.complete) === true &&
      (options.modelAlignment?.all_phrases_playable ?? options.modelAlignment?.complete) === true &&
      (!targetCount || ranges.length === targetCount);
    return {
      mode: complete ? "phrase" : "partial_phrase",
      label: complete ? "フレーズごと比較再生" : "一部フレーズ比較再生",
      description: complete
        ? `${ranges.length}/${targetCount || ranges.length}フレーズを順番に比較できます。`
        : `確認できた${ranges.length}/${targetCount || ranges.length}フレーズを順番に比較します。`,
      ranges,
    };
  }

  function comparableTargetText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\p{P}\p{S}]+/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  }

  // targetTextの空白なしフレーズ連結が、目標文の空白除去版と一致することは
  // practice_llm.py/worker.mjsの検証(_normalize_reconstruction_whitespace/
  // practiceLlmWhitespaceInsensitive)が保証している。この保証は句読点を含む
  // 非空白文字の並びには一切ずれがないことも意味するため、各フレーズの
  // 「空白抜き文字数」を先頭から積み上げるだけでオフセット→フレーズ対応が
  // 一意に決まる。indexOfによる文字列探索(繰り返し表現があると誤対応しうる)は不要。
  function coreTargetText(value) {
    return comparableTargetText(value).replace(/\s+/gu, "");
  }

  function comparisonPhraseIndexForTargetOffset({ targetText, targetOffset, alignment }) {
    const offset = Number(targetOffset);
    const target = comparableTargetText(targetText);
    const phrases = Array.isArray(alignment?.phrases) ? alignment.phrases : [];
    if (!target || !Number.isInteger(offset) || offset < 0 || !phrases.length) {
      return null;
    }

    let coreOffset = 0;
    for (let index = 0; index < offset && index < target.length; index += 1) {
      if (target[index] !== " ") coreOffset += 1;
    }

    let cursor = 0;
    let selectedIndex = null;
    for (const phrase of phrases) {
      const phraseCoreLength = coreTargetText(phrase?.target_text).length;
      if (!phraseCoreLength) continue;
      const end = cursor + phraseCoreLength;
      if (coreOffset < end) {
        selectedIndex = Number(phrase.index);
        break;
      }
      selectedIndex = Number(phrase.index);
      cursor = end;
    }
    return Number.isInteger(selectedIndex) ? selectedIndex : null;
  }

  function comparisonRangeForTargetOffset({ targetText, targetOffset, alignment, ranges }) {
    const playableRanges = Array.isArray(ranges) ? ranges : [];
    const selectedIndex = comparisonPhraseIndexForTargetOffset({ targetText, targetOffset, alignment });
    if (!Number.isInteger(selectedIndex) || !playableRanges.length) return null;
    return playableRanges.find((range) => Number(range?.index) === selectedIndex) || null;
  }

  function shouldStopAudioSegment({ active, ended, currentTime, segmentEnd }) {
    return !active || ended || Number(currentTime) >= Number(segmentEnd);
  }

  function practiceDisplayCharsEqual(left, right) {
    const normalizedLeft = String(left || "").normalize("NFKC").toLocaleLowerCase();
    const normalizedRight = String(right || "").normalize("NFKC").toLocaleLowerCase();
    if (normalizedLeft === normalizedRight) return true;
    const punctuationPairs = new Set(["?？", "？?", "!！", "！!", ",，", "，,", ".。", "。."]);
    return punctuationPairs.has(`${left || ""}${right || ""}`);
  }

  function pinyinSyllable(list, index) {
    const value = Array.isArray(list) ? list[index] : undefined;
    return typeof value === "string" && value ? value : "";
  }

  function pinyinBaseSyllable(syllable) {
    return syllable.replace(/[0-9]$/, "");
  }

  // 目標文字と復唱文字が食い違うセルを、ピンイン(声調つき)が分かる場合だけ細分する。
  // 一致文字列(equal)自体の判定は変えず、既存のLevenshtein整列結果の解釈を補うだけ。
  function classifySubstitution(targetChar, recognizedChar, targetIndex, recognizedIndex, pinyin) {
    if (!pinyin) return "substitute";
    const targetSyllable = pinyinSyllable(pinyin.target, targetIndex);
    const recognizedSyllable = pinyinSyllable(pinyin.recognized, recognizedIndex);
    if (!targetSyllable || !recognizedSyllable) return "substitute";
    if (targetSyllable === recognizedSyllable) return "equal";
    if (pinyinBaseSyllable(targetSyllable) === pinyinBaseSyllable(recognizedSyllable)) return "tone";
    return "substitute";
  }

  // 目標文(targetTextValue)と復唱ASR文(recognizedTextValue)の文字単位差分を作る。
  // pinyinを渡すと、同音の字違い(ASRの字選び)はequalへ、声調だけの違いはtoneへ再分類する。
  // pinyin = { target: string[], recognized: string[] } で、それぞれ
  // Array.from(targetTextValue) / Array.from(recognizedTextValue) と同じ添字に揃えること。
  function buildPracticeDiffCells(targetTextValue, recognizedTextValue, pinyin = null) {
    const targetChars = Array.from(targetTextValue || "");
    const recognizedChars = Array.from(recognizedTextValue || "");
    const rows = targetChars.length + 1;
    const columns = recognizedChars.length + 1;
    const distance = Array.from({ length: rows }, () => new Array(columns).fill(0));
    for (let targetIndex = targetChars.length; targetIndex >= 0; targetIndex -= 1) {
      distance[targetIndex][recognizedChars.length] = targetChars.length - targetIndex;
    }
    for (let recognizedIndex = recognizedChars.length; recognizedIndex >= 0; recognizedIndex -= 1) {
      distance[targetChars.length][recognizedIndex] = recognizedChars.length - recognizedIndex;
    }
    for (let targetIndex = targetChars.length - 1; targetIndex >= 0; targetIndex -= 1) {
      for (let recognizedIndex = recognizedChars.length - 1; recognizedIndex >= 0; recognizedIndex -= 1) {
        if (practiceDisplayCharsEqual(targetChars[targetIndex], recognizedChars[recognizedIndex])) {
          distance[targetIndex][recognizedIndex] = distance[targetIndex + 1][recognizedIndex + 1];
        } else {
          distance[targetIndex][recognizedIndex] = 1 + Math.min(
            distance[targetIndex + 1][recognizedIndex + 1],
            distance[targetIndex + 1][recognizedIndex],
            distance[targetIndex][recognizedIndex + 1],
          );
        }
      }
    }

    const cells = [];
    let targetIndex = 0;
    let recognizedIndex = 0;
    while (targetIndex < targetChars.length || recognizedIndex < recognizedChars.length) {
      const targetChar = targetChars[targetIndex];
      const recognizedChar = recognizedChars[recognizedIndex];
      if (
        targetIndex < targetChars.length &&
        recognizedIndex < recognizedChars.length &&
        practiceDisplayCharsEqual(targetChar, recognizedChar)
      ) {
        cells.push({ type: "equal", correction: "", heard: recognizedChar, targetOffset: targetIndex });
        targetIndex += 1;
        recognizedIndex += 1;
        continue;
      }
      const currentDistance = distance[targetIndex][recognizedIndex];
      if (
        targetIndex < targetChars.length &&
        recognizedIndex < recognizedChars.length &&
        currentDistance === 1 + distance[targetIndex + 1][recognizedIndex + 1]
      ) {
        const type = classifySubstitution(targetChar, recognizedChar, targetIndex, recognizedIndex, pinyin);
        cells.push({
          type,
          correction: type === "equal" ? "" : targetChar,
          heard: recognizedChar,
          targetOffset: targetIndex,
        });
        targetIndex += 1;
        recognizedIndex += 1;
        continue;
      }
      if (
        targetIndex < targetChars.length &&
        currentDistance === 1 + distance[targetIndex + 1][recognizedIndex]
      ) {
        cells.push({ type: "delete", correction: targetChar, heard: "_", targetOffset: targetIndex });
        targetIndex += 1;
        continue;
      }
      cells.push({ type: "insert", correction: "", heard: recognizedChar || "_", targetOffset: targetIndex });
      recognizedIndex += 1;
    }
    return cells.length ? cells : [{ type: "insert", correction: "", heard: "（聞き取れませんでした）" }];
  }

  // equalの連続に加え、substitute/tone/deleteなど同種の不一致セルが連続する場合もまとめる。
  // 1文字ごとに正誤セルが分裂するのを防ぎ、語や句のまとまりで表示できるようにする。
  function compactPracticeDiffCells(cells, { targetText = "", alignment = null } = {}) {
    const compacted = [];
    cells.forEach((cell) => {
      const previous = compacted[compacted.length - 1];
      const previousPhraseIndex = previous
        ? comparisonPhraseIndexForTargetOffset({ targetText, targetOffset: previous.targetOffset, alignment })
        : null;
      const cellPhraseIndex = comparisonPhraseIndexForTargetOffset({
        targetText,
        targetOffset: cell.targetOffset,
        alignment,
      });
      const crossesKnownPhraseBoundary = (
        Number.isInteger(previousPhraseIndex) &&
        Number.isInteger(cellPhraseIndex) &&
        previousPhraseIndex !== cellPhraseIndex
      );
      if (previous && previous.type === cell.type && !crossesKnownPhraseBoundary) {
        previous.heard += cell.type === "delete" ? "" : cell.heard;
        previous.correction += cell.correction;
        return;
      }
      compacted.push({ ...cell });
    });
    return compacted;
  }

  global.voiceLabPracticePlayback = {
    comparisonPlaybackPlan,
    comparisonRangeForTargetOffset,
    shouldStopAudioSegment,
    comparableTargetText,
    buildPracticeDiffCells,
    compactPracticeDiffCells,
  };
})(globalThis);
