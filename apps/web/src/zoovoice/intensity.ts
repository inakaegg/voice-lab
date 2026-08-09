// アニマル度は5段階。APIへは従来どおり0〜100の数値を送り、
// サーバ側（services/zoovoice/audio.go の mapIntensity）が20刻みで同じ段階へ丸める。
// スライダーが5段階の値しか出さないので、表示と実際の挙動が一致する。
export const intensityStageCount = 5;

export const intensityStageValues = [0, 25, 50, 75, 100];

export const defaultIntensity = 50;

// intensityStage は0〜100の値を1始まりの段階番号へ変換する。
export function intensityStage(intensity: number): number {
  return Math.min(intensityStageCount, Math.floor(intensity / 20) + 1);
}
