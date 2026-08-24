import { useEffect, useState } from "react";

import { useT } from "../shared/i18n";

type RecordOrbProps = {
  disabled: boolean;
  durationMilliseconds: number;
  isProcessing: boolean;
  isRecording: boolean;
  levels: number[];
  onCancel: () => void;
  onPress: () => void;
};

export function RecordOrb({
  disabled,
  durationMilliseconds,
  isProcessing,
  isRecording,
  levels,
  onCancel,
  onPress,
}: RecordOrbProps) {
  const processingMilliseconds = useProcessingElapsed(isProcessing);
  const progressDegrees = Math.min(360, Math.max(0, durationMilliseconds / 60_000 * 360));
  const t = useT();
  const label = t(isRecording ? "zoovoice.orb.stopRecording" : "zoovoice.orb.record");
  const orbBackground = isProcessing
    ? "linear-gradient(135deg, #0284c7, #6366f1 54%, #f59e0b)"
    : isRecording ? "#b91c1c" : "#ef4444";

  return <div className="relative grid justify-items-center gap-2">
    <div className="relative" style={{ width: "clamp(64px, 8vw, 84px)", aspectRatio: "1" }}>
      {isRecording && <>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-4 rounded-full border-2 border-red-500/35 motion-safe:animate-ping"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2 rounded-full"
          style={{
            background: `conic-gradient(rgb(248 113 113) ${progressDegrees}deg, rgb(255 255 255 / 0.26) 0deg)`,
          }}
        />
      </>}
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onPress}
        className="relative z-[1] grid size-full place-items-center overflow-hidden text-white shadow-[0_12px_30px_rgba(58,68,78,0.24),inset_0_-7px_0_rgba(95,15,7,0.12)] transition-[transform,opacity,box-shadow] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 focus-visible:ring-offset-4 motion-reduce:transition-none"
        style={{
          background: orbBackground,
          border: "6px solid white",
          borderRadius: "9999px",
          boxSizing: "border-box",
          cursor: disabled ? "not-allowed" : "pointer",
          minHeight: 0,
          opacity: disabled ? 0.55 : 1,
          padding: 0,
        }}
      >
        {isProcessing
          ? <span className="size-9 animate-spin rounded-full border-[5px] border-white/40 border-t-white motion-reduce:animate-none" aria-hidden="true" />
          : isRecording
            ? <span className="flex h-[48%] w-[58%] items-end justify-center gap-1" aria-label={t("zoovoice.orb.micLevel")}>
                {levels.map((level, index) => <span
                  key={index}
                  className="w-1 flex-1 rounded-full bg-white/90 shadow-[0_0_8px_rgba(255,255,255,0.34)] transition-[height,opacity] duration-100"
                  style={{ height: `${Math.round(18 + level * 82)}%`, opacity: 0.55 + level * 0.45 }}
                />)}
              </span>
            : <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-[52%]"
                aria-hidden="true"
              >
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
              </svg>}
        {isRecording && <span className="absolute bottom-1 rounded-full bg-white/95 px-1.5 py-0.5 text-[0.58rem] font-black leading-none text-red-900">REC</span>}
      </button>
      {isRecording && <button
        type="button"
        aria-label={t("zoovoice.orb.cancel")}
        title={t("zoovoice.orb.cancel")}
        onClick={onCancel}
        className="absolute -right-3 -top-2 z-[3] inline-flex size-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition hover:-translate-y-0.5 hover:border-red-500 hover:text-red-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/25 dark:hover:text-red-300 motion-reduce:transition-none"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "9999px",
          color: "var(--muted-foreground)",
          minHeight: "36px",
          padding: 0,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-[17px]" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>}
    </div>
    <strong className={`text-xs ${isRecording ? "text-red-700 dark:text-red-300" : "text-foreground"}`}>
      {t(isRecording ? "zoovoice.orb.recording" : isProcessing ? "zoovoice.orb.generating" : "zoovoice.orb.tapToSpeak")}
    </strong>
    <span data-testid="zoovoice-orb-time" className="text-[0.68rem] tabular-nums text-muted-foreground">
      {formatMilliseconds(isProcessing ? processingMilliseconds : durationMilliseconds)}
    </span>
  </div>;
}

// 生成中は録音の長さではなく、生成を始めてからの経過時間を数える。
// 録音の長さのままだと止まった数字に見えてしまうためである。
function useProcessingElapsed(isProcessing: boolean): number {
  const [elapsedMilliseconds, setElapsedMilliseconds] = useState(0);

  useEffect(() => {
    if (!isProcessing) {
      setElapsedMilliseconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMilliseconds(0);
    const interval = window.setInterval(() => setElapsedMilliseconds(Date.now() - startedAt), 200);
    return () => window.clearInterval(interval);
  }, [isProcessing]);

  return elapsedMilliseconds;
}

function formatMilliseconds(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
