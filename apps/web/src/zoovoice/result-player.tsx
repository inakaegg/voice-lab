import { Download, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ResultPlayer({
  source,
  fallbackDuration,
}: {
  source: string;
  fallbackDuration: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(fallbackDuration);
  }, [fallbackDuration, source]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  };

  return <div className="grid gap-4">
    <audio
      ref={audioRef}
      src={source}
      preload="metadata"
      hidden
      onLoadedMetadata={(event) => {
        const measured = event.currentTarget.duration;
        if (Number.isFinite(measured)) setDuration(measured);
      }}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
    />
    <div className="flex min-w-0 items-center gap-3">
      <button
        type="button"
        className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45 motion-reduce:transition-none"
        aria-label={playing ? "結果を一時停止" : "結果を再生"}
        onClick={() => void toggle()}
      >
        {playing ? <Pause className="size-5" aria-hidden="true" /> : <Play className="ml-0.5 size-5" aria-hidden="true" />}
      </button>
      <label className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs font-semibold text-muted-foreground">
        <span className="sr-only">再生位置</span>
        <input
          type="range"
          min="0"
          max={Math.max(duration, 0.01)}
          step="0.01"
          value={Math.min(currentTime, duration)}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            setCurrentTime(next);
            if (audioRef.current) audioRef.current.currentTime = next;
          }}
          className="min-w-0 accent-foreground"
        />
        <span className="tabular-nums">{formatTime(currentTime)} / {formatTime(duration)}</span>
      </label>
    </div>
    <a
      href={source}
      download="zoovoice.wav"
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-bold text-foreground no-underline transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/45"
    >
      <Download className="size-4" aria-hidden="true" />
      WAVを保存
    </a>
  </div>;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
