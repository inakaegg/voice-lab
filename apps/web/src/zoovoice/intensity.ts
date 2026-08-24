// アニマル度は5段階。APIへは選んだ0〜100の値を送り、
// サーバ側が入力音声長へその値を掛けるので、表示と実際の密度が一致する。
export const intensityStageCount = 5;

export const intensityStageValues = [0, 25, 50, 75, 100];

export const defaultIntensity = 50;

// intensityStage は0〜100の値を1始まりの段階番号へ変換する。
export function intensityStage(intensity: number): number {
  return Math.min(intensityStageCount, Math.floor(intensity / 20) + 1);
}
