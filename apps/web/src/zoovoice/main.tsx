import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Mic2, RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useReducer, useState } from "react";

import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, PageShell, PrivacyNotice, ProductHeader } from "../shared/components";
import {
  composeRecording,
  fetchZoovoiceConfig,
  wavBlobFromBase64,
  type ComposeResponse,
  type SelectionStrategy,
  type ZoovoiceConfig,
} from "./api";
import { ResultPlayer } from "./result-player";
import { initialZoovoiceState, zoovoiceReducer } from "./state";
import { TurnstileWidget } from "./turnstile-widget";
import { useRecorder } from "./use-recorder";

activateCompactLayout();

type ResultState = {
  payload: ComposeResponse;
  url: string;
};

function Zoovoice() {
  const [state, dispatch] = useReducer(zoovoiceReducer, initialZoovoiceState);
  const [intensity, setIntensity] = useState(50);
  const [result, setResult] = useState<ResultState | null>(null);
  const [config, setConfig] = useState<ZoovoiceConfig | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetVersion, setTurnstileResetVersion] = useState(0);
  const recorder = useRecorder();

  useEffect(() => {
    const controller = new AbortController();
    void fetchZoovoiceConfig(controller.signal)
      .then((loadedConfig) => {
        setConfig(loadedConfig);
        if (!loadedConfig.enabled) throw new Error("Zoovoiceは現在利用できません。");
        dispatch({ type: "config_loaded" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: "failed", message: messageFromError(error, "Zoovoiceを準備できませんでした。") });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (recorder.blob && state.phase === "recording") {
      dispatch({ type: "recording_stopped", turnstileRequired: config?.turnstile_required === true });
    }
  }, [config?.turnstile_required, recorder.blob, state.phase]);

  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const isBusy = state.phase === "processing";
  const turnstileReady = !config?.turnstile_required || Boolean(turnstileToken);
  const handleTurnstileToken = useCallback((token: string) => setTurnstileToken(token), []);

  const beginOrStopRecording = async () => {
    if (recorder.isRecording) {
      recorder.stop();
      return;
    }
    if (result) {
      URL.revokeObjectURL(result.url);
      setResult(null);
    }
    setTurnstileToken("");
    setTurnstileResetVersion((current) => current + 1);
    recorder.clear();
    try {
      await recorder.start();
      dispatch({ type: "recording_started" });
    } catch (error) {
      dispatch({
        type: "failed",
        message: error instanceof DOMException && error.name === "NotAllowedError"
          ? "マイクを使用できません。ブラウザの権限を確認してください。"
          : messageFromError(error, "マイクを使用できません。ブラウザの設定を確認してください。"),
      });
    }
  };

  const submit = async () => {
    if (!recorder.blob) {
      dispatch({ type: "failed", message: "先に声を録音してください。" });
      return;
    }
    if (config?.turnstile_required && !turnstileToken) {
      dispatch({ type: "failed", message: "不正利用防止の確認が完了するまでお待ちください。" });
      return;
    }
    dispatch({ type: "compose_started" });
    try {
      const payload = await composeRecording(recorder.blob, intensity, turnstileToken);
      if (result) URL.revokeObjectURL(result.url);
      const url = URL.createObjectURL(wavBlobFromBase64(payload.audio.base64));
      setResult({ payload, url });
      dispatch({
        type: "compose_succeeded",
        fallback: payload.meta.selection_strategy === "random_fallback",
      });
    } catch (error) {
      dispatch({
        type: "failed",
        message: messageFromError(error, "音声を生成できませんでした。もう一度お試しください。"),
      });
    } finally {
      if (config?.turnstile_required) {
        setTurnstileToken("");
        setTurnstileResetVersion((current) => current + 1);
      }
    }
  };

  return <PageShell className="zoovoice-shell max-w-[1120px]">
    <ProductHeader product="zoovoice" title="声から動物を連想する" />
    <section className="mb-3 flex flex-col gap-1.5 border-l-[3px] border-[var(--react-ink)] pl-4 sm:mb-4 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
      <div>
        <p className="text-[0.66rem] font-bold uppercase tracking-[0.18em] text-[var(--react-muted)]">Record · Associate · Play</p>
        <h2 className="text-balance text-[clamp(1.45rem,3vw,2.25rem)] font-bold leading-tight tracking-[-0.04em] text-[var(--react-ink)]">話すだけで、ぴったりの動物を。</h2>
      </div>
      <p className="max-w-[34rem] text-xs leading-5 text-[var(--react-muted)] sm:text-right sm:text-sm">話した内容から動物を1種選び、同じ鳴き声を声のすき間へ重ねます。</p>
    </section>

    <main data-testid="zoovoice-workspace" className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
      <Card className="min-w-0 gap-0 overflow-hidden rounded-[1.35rem] border-border/80 py-0 shadow-sm">
        <CardHeader className="gap-1 border-b border-border/70 px-4 py-3.5 sm:px-5">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.15em] text-muted-foreground">01 · Record</p>
          <CardTitle className="text-lg tracking-[-0.025em]">声を録音する</CardTitle>
          <CardDescription className="text-xs leading-5">60秒まで。動物は話した内容から自動で選びます。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3.5 p-4 sm:p-5">
          <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3">
            <div className="flex h-16 min-w-0 items-end justify-center gap-1 overflow-hidden rounded-xl border border-border/70 bg-muted/55 px-3 py-2" aria-label="マイク入力レベル">
              {recorder.levels.map((level, index) => <span
                key={index}
                className={`w-1.5 rounded-full transition-[height,background-color] duration-100 ${recorder.isRecording ? "bg-red-500" : "bg-foreground/25"}`}
                style={{ height: `${Math.round(10 + level * 34)}px` }}
              />)}
            </div>
            <div className="grid justify-items-center gap-1">
              <button
                type="button"
                aria-label={recorder.isRecording ? "録音を止める" : "録音する"}
                disabled={isBusy || !config?.enabled}
                onClick={() => void beginOrStopRecording()}
                className={`inline-flex size-14 items-center justify-center rounded-full border-4 shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[4px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none ${
                  recorder.isRecording
                    ? "border-red-100 bg-red-600 text-white dark:border-red-950"
                    : "border-background bg-foreground text-background ring-1 ring-border"
                }`}
              >
                {recorder.isRecording
                  ? <span className="size-4 rounded-sm bg-current" aria-hidden="true" />
                  : <Mic2 className="size-5" strokeWidth={1.9} aria-hidden="true" />}
              </button>
              <strong className={recorder.isRecording ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-foreground"}>
                {recorder.isRecording ? "REC" : recorder.blob ? "録音済み" : "録音する"}
              </strong>
              <span className="text-[0.68rem] tabular-nums text-muted-foreground">{formatMilliseconds(recorder.durationMilliseconds)}</span>
            </div>
          </div>

          <label className="grid gap-1.5 text-sm font-bold text-foreground">
            <span className="flex items-center justify-between gap-4"><span>アニマル度</span><output htmlFor="zoovoice-intensity" className="tabular-nums text-muted-foreground">{intensity}</output></span>
            <input
              id="zoovoice-intensity"
              type="range"
              min="0"
              max="100"
              value={intensity}
              disabled={isBusy}
              onChange={(event) => setIntensity(Number(event.currentTarget.value))}
              className="w-full accent-foreground"
            />
            <span className="flex justify-between text-[0.65rem] font-medium text-muted-foreground"><span>ひかえめ</span><span>にぎやか</span></span>
          </label>

          {recorder.blob && config?.turnstile_required && <TurnstileWidget
            siteKey={config.turnstile_site_key}
            resetVersion={turnstileResetVersion}
            onToken={handleTurnstileToken}
          />}

          <div className="grid gap-1.5">
            <button
              type="button"
              disabled={!recorder.blob || recorder.isRecording || isBusy || !turnstileReady}
              onClick={() => void submit()}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-2.5 text-sm font-bold text-background shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[4px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
            >
              {isBusy
                ? <><span className="size-4 animate-spin rounded-full border-2 border-background/35 border-t-background motion-reduce:animate-none" aria-hidden="true" />連想・合成中…</>
                : <><Sparkles className="size-4" aria-hidden="true" />{state.phase === "error" && recorder.blob ? "もう一度生成" : "生成する"}</>}
            </button>
            {recorder.blob && !recorder.isRecording && <button
              type="button"
              disabled={isBusy}
              onClick={() => void beginOrStopRecording()}
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-bold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              録り直す
            </button>}
            <p
              role="status"
              aria-live="polite"
              className={`min-h-5 text-center text-xs leading-5 ${
                state.phase === "error"
                  ? "font-semibold text-red-700 dark:text-red-300"
                  : state.phase === "fallback"
                    ? "font-semibold text-amber-700 dark:text-amber-300"
                    : "text-muted-foreground"
              }`}
            >
              {state.message}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 gap-0 overflow-hidden rounded-[1.35rem] border-border/80 py-0 shadow-sm">
        <CardHeader className="gap-1 border-b border-border/70 px-4 py-3.5 sm:px-5">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.15em] text-muted-foreground">02 · Result</p>
          <CardTitle className="text-lg tracking-[-0.025em]">連想された動物</CardTitle>
          <CardDescription className="text-xs leading-5">聞き取った言葉と選んだ理由も確認できます。</CardDescription>
        </CardHeader>
        <CardContent className="grid min-h-[20rem] content-center gap-3.5 p-4 sm:p-5">
          {result
            ? <ResultDetails result={result} />
            : <div className="grid justify-items-center gap-2 text-center text-muted-foreground">
              <Sparkles className="size-7 opacity-45" strokeWidth={1.5} aria-hidden="true" />
              <p className="max-w-[28rem] text-sm leading-6">録音して生成すると、選ばれた動物と鳴き声入り音声をここに表示します。</p>
            </div>}
        </CardContent>
      </Card>
    </main>
    <PrivacyNotice />
  </PageShell>;
}

function ResultDetails({ result }: { result: ResultState }) {
  const meta = result.payload.meta;
  return <>
    {meta.selection_strategy === "random_fallback" && <p className="rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      直接の言及や意味のつながりが見つからず、動物をランダムに選びました。
    </p>}
    <dl className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-border/70 bg-muted/35 px-3.5 py-3 text-xs leading-5">
      <dt className="font-semibold text-muted-foreground">選ばれた動物</dt>
      <dd className="min-w-0 break-words font-bold text-foreground">{meta.selected_animal.label_ja}</dd>
      <dt className="font-semibold text-muted-foreground">聞き取った言葉</dt>
      <dd className="min-w-0 break-words text-foreground">{meta.transcript}</dd>
      <dt className="font-semibold text-muted-foreground">根拠語</dt>
      <dd className="min-w-0 break-words text-foreground">{meta.evidence_term || "該当なし"}</dd>
      <dt className="font-semibold text-muted-foreground">選択方式</dt>
      <dd className="min-w-0 break-words text-foreground">{selectionStrategyLabel(meta.selection_strategy)}</dd>
    </dl>
    <ResultPlayer source={result.url} fallbackDuration={meta.output_duration_seconds} />
    <p className="break-words text-[0.68rem] leading-5 text-muted-foreground">
      {meta.insertions.length}か所に「{meta.selected_animal.label_ja}」の鳴き声を追加しました。
    </p>
  </>;
}

function selectionStrategyLabel(strategy: SelectionStrategy): string {
  return {
    direct: "動物名・鳴き声の直接言及",
    conceptnet: "言葉の意味のつながり",
    random_fallback: "ランダム選択",
  }[strategy];
}

function formatMilliseconds(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

mountPublicPage(<Zoovoice />);
