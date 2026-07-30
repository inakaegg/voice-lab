import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, Mic2, RotateCcw, Sparkles, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useReducer, useState } from "react";

import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, PageShell, PrivacyNotice, ProductHeader } from "../shared/components";
import { composeRecording, fetchAnimals, wavBlobFromBase64, type Animal, type ComposeResponse } from "./api";
import { ResultPlayer } from "./result-player";
import {
  initialZoovoiceState,
  luckyArrangement,
  singleAnimalArrangement,
  zoovoiceReducer,
  type Arrangement,
} from "./state";
import { useRecorder } from "./use-recorder";

activateCompactLayout();

type ResultState = {
  payload: ComposeResponse;
  url: string;
};

function Zoovoice() {
  const [state, dispatch] = useReducer(zoovoiceReducer, initialZoovoiceState);
  const [animals, setAnimals] = useState<Animal[]>([]);
  const [arrangement, setArrangement] = useState<Arrangement>(() => singleAnimalArrangement("cat"));
  const [intensity, setIntensity] = useState(50);
  const [result, setResult] = useState<ResultState | null>(null);
  const recorder = useRecorder();

  useEffect(() => {
    const controller = new AbortController();
    void fetchAnimals(controller.signal)
      .then((available) => {
        const initial = available.some((animal) => animal.id === "cat") ? "cat" : available[0].id;
        setAnimals(available);
        setArrangement(singleAnimalArrangement(initial));
        dispatch({ type: "animals_loaded" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: "failed", message: messageFromError(error, "動物を読み込めませんでした。") });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (recorder.blob && state.phase === "recording") {
      dispatch({ type: "recording_stopped" });
    }
  }, [recorder.blob, state.phase]);

  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const animalLabel = useMemo(
    () => new Map(animals.map((animal) => [animal.id, animal.label_ja])),
    [animals],
  );
  const isBusy = state.phase === "processing";
  const singleSelection = arrangement.opening === arrangement.gaps
    && arrangement.gaps === arrangement.ending
    && arrangement.opening !== null
    ? arrangement.opening
    : "custom";

  const beginOrStopRecording = async () => {
    if (recorder.isRecording) {
      recorder.stop();
      return;
    }
    if (result) {
      URL.revokeObjectURL(result.url);
      setResult(null);
    }
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
    dispatch({ type: "compose_started" });
    try {
      const payload = await composeRecording(recorder.blob, arrangement, intensity);
      if (result) URL.revokeObjectURL(result.url);
      const url = URL.createObjectURL(wavBlobFromBase64(payload.audio.base64));
      setResult({ payload, url });
      dispatch({ type: "compose_succeeded" });
    } catch (error) {
      dispatch({
        type: "failed",
        message: messageFromError(error, "音声を合成できませんでした。もう一度お試しください。"),
      });
    }
  };

  return <PageShell className="zoovoice-shell max-w-[1180px]">
    <ProductHeader product="zoovoice" title="声のすき間に動物を" />
    <section className="mb-5 grid gap-3 border-l-[3px] border-[var(--react-ink)] pl-4 sm:mb-7 sm:pl-5">
      <p className="text-[0.7rem] font-bold uppercase tracking-[0.18em] text-[var(--react-muted)]">Record · Arrange · Play</p>
      <h2 className="max-w-[20ch] text-balance text-[clamp(1.8rem,4vw,3rem)] font-bold leading-[1.04] tracking-[-0.045em] text-[var(--react-ink)]">声のすき間を、動物たちで彩る。</h2>
      <p className="max-w-[46rem] text-sm leading-7 text-[var(--react-muted)] sm:text-base">短く話して、動物とアニマル度を選ぶだけ。言葉の合間へ鳴き声を重ねたWAVを作ります。</p>
    </section>

    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
      <Card className="min-w-0 gap-0 overflow-hidden rounded-[1.5rem] border-border/80 py-0 shadow-sm">
        <CardHeader className="gap-2 border-b border-border/70 px-5 py-5 sm:px-6">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">01 · Voice</p>
          <CardTitle className="text-xl tracking-[-0.025em]">声を録音する</CardTitle>
          <CardDescription className="leading-6">60秒まで。無音だけの録音は合成しません。</CardDescription>
        </CardHeader>
        <CardContent className="grid min-h-[17rem] content-center gap-5 p-5 sm:p-6">
          <div className="mx-auto flex min-h-24 w-full max-w-[25rem] items-end justify-center gap-1.5 rounded-2xl border border-border/70 bg-muted/55 px-5 py-4" aria-label="マイク入力レベル">
            {recorder.levels.map((level, index) => <span
              key={index}
              className={`w-2 rounded-full transition-[height,background-color] duration-100 ${recorder.isRecording ? "bg-red-500" : "bg-foreground/25"}`}
              style={{ height: `${Math.round(16 + level * 54)}px` }}
            />)}
          </div>
          <div className="grid justify-items-center gap-2">
            <button
              type="button"
              aria-label={recorder.isRecording ? "録音を止める" : "録音する"}
              disabled={isBusy || animals.length === 0}
              onClick={() => void beginOrStopRecording()}
              className={`inline-flex size-20 items-center justify-center rounded-full border-[5px] shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[4px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none ${
                recorder.isRecording
                  ? "border-red-100 bg-red-600 text-white dark:border-red-950"
                  : "border-background bg-foreground text-background ring-1 ring-border"
              }`}
            >
              {recorder.isRecording
                ? <span className="size-5 rounded-sm bg-current" aria-hidden="true" />
                : <Mic2 className="size-7" strokeWidth={1.9} aria-hidden="true" />}
            </button>
            <strong className={recorder.isRecording ? "text-sm text-red-600 dark:text-red-400" : "text-sm text-foreground"}>
              {recorder.isRecording ? "REC" : recorder.blob ? "録音済み" : "録音する"}
            </strong>
            <span className="text-xs tabular-nums text-muted-foreground">{formatMilliseconds(recorder.durationMilliseconds)}</span>
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0 gap-0 rounded-[1.5rem] border-border/80 py-0 shadow-sm">
        <CardHeader className="gap-2 border-b border-border/70 px-5 py-5 sm:px-6">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">02 · Arrange</p>
          <CardTitle className="text-xl tracking-[-0.025em]">動物を配置する</CardTitle>
          <CardDescription className="leading-6">
            {state.phase === "loading"
              ? "動物を読み込んでいます。"
              : animals.length <= 12
                ? "現在は12種類のCC0音源で動いています。"
                : `${animals.length}種類から選べます。同じ動物でも鳴き方はランダムです。`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 p-5 sm:p-6">
          <label className="grid gap-2 text-sm font-bold text-foreground">
            <span>ひとつの動物で統一</span>
            <select
              value={singleSelection}
              disabled={isBusy || animals.length === 0}
              onChange={(event) => {
                if (event.currentTarget.value !== "custom") {
                  setArrangement(singleAnimalArrangement(event.currentTarget.value));
                }
              }}
              className="min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              {singleSelection === "custom" && <option value="custom">個別設定</option>}
              {singleSelection === "lucky" && <option value="lucky">おまかせ</option>}
              {animals.map((animal) => <option key={animal.id} value={animal.id}>{animal.label_ja}</option>)}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={isBusy || !animals.some((animal) => animal.id === "rooster") || !animals.some((animal) => animal.id === "cow")}
              onClick={() => setArrangement({ opening: "rooster", gaps: "cow", ending: "rooster" })}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-sm font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-45"
            >
              <WandSparkles className="size-4" aria-hidden="true" />
              にわとり牧場
            </button>
            <button
              type="button"
              disabled={isBusy || animals.length === 0}
              onClick={() => setArrangement(luckyArrangement())}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-sm font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-45"
            >
              <Sparkles className="size-4" aria-hidden="true" />
              feel lucky?
            </button>
          </div>

          <details className="group rounded-xl border border-border/80 bg-muted/35">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-bold text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/40">
              3つの場所を個別に選ぶ
              <ChevronDown className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
            </summary>
            <div className="grid gap-3 border-t border-border/70 p-4 sm:grid-cols-3">
              <SlotSelect label="はじめ" slot="opening" value={arrangement.opening} animals={animals} disabled={isBusy} onChange={setArrangement} arrangement={arrangement} />
              <SlotSelect label="合間" slot="gaps" value={arrangement.gaps} animals={animals} disabled={isBusy} onChange={setArrangement} arrangement={arrangement} />
              <SlotSelect label="おわり" slot="ending" value={arrangement.ending} animals={animals} disabled={isBusy} onChange={setArrangement} arrangement={arrangement} />
            </div>
          </details>

          <label className="grid gap-2 text-sm font-bold text-foreground">
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
            <span className="flex justify-between text-[0.68rem] font-medium text-muted-foreground"><span>長い間だけ</span><span>短い息継ぎにも</span></span>
          </label>
        </CardContent>
      </Card>
    </div>

    <section className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
      <Card className="gap-0 rounded-[1.5rem] border-border/80 py-0 shadow-sm">
        <CardContent className="grid gap-3 p-5 sm:p-6">
          <button
            type="button"
            disabled={!recorder.blob || recorder.isRecording || isBusy}
            onClick={() => void submit()}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-bold text-background shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[4px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
          >
            {isBusy
              ? <><span className="size-4 animate-spin rounded-full border-2 border-background/35 border-t-background motion-reduce:animate-none" aria-hidden="true" />合成中…</>
              : <><Sparkles className="size-4" aria-hidden="true" />{state.phase === "error" && recorder.blob ? "もう一度合成" : "合成する"}</>}
          </button>
          {recorder.blob && !recorder.isRecording && <button
            type="button"
            disabled={isBusy}
            onClick={() => void beginOrStopRecording()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            録り直す
          </button>}
          <p
            role="status"
            aria-live="polite"
            className={`min-h-6 text-center text-sm leading-6 ${
              state.phase === "error" ? "font-semibold text-red-700 dark:text-red-300" : "text-muted-foreground"
            }`}
          >
            {state.message}
          </p>
        </CardContent>
      </Card>

      <Card className="gap-0 rounded-[1.5rem] border-border/80 py-0 shadow-sm">
        <CardHeader className="gap-2 border-b border-border/70 px-5 py-5 sm:px-6">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">03 · Result</p>
          <CardTitle className="text-xl tracking-[-0.025em]">できあがり</CardTitle>
          <CardDescription>合成済みの音声だけを再生・保存できます。</CardDescription>
        </CardHeader>
        <CardContent className="grid min-h-[12.5rem] content-center gap-4 p-5 sm:p-6">
          {result
            ? <>
              <ResultPlayer source={result.url} fallbackDuration={result.payload.meta.output_duration_seconds} />
              <div className="flex flex-wrap gap-2" aria-label="挿入された動物">
                {result.payload.meta.insertions.map((insertion, index) => <span key={`${insertion.slot}-${insertion.at_seconds}-${index}`} className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                  {slotLabel(insertion.slot)} · {animalLabel.get(insertion.species) || insertion.species} · {insertion.at_seconds.toFixed(1)}秒
                </span>)}
              </div>
            </>
            : <div className="grid justify-items-center gap-2 text-center text-muted-foreground">
              <Sparkles className="size-7 opacity-45" strokeWidth={1.5} aria-hidden="true" />
              <p className="text-sm leading-6">録音して合成すると、ここで結果を確認できます。</p>
            </div>}
        </CardContent>
      </Card>
    </section>
    <PrivacyNotice />
  </PageShell>;
}

function SlotSelect({
  label,
  slot,
  value,
  animals,
  disabled,
  arrangement,
  onChange,
}: {
  label: string;
  slot: keyof Arrangement;
  value: Arrangement[keyof Arrangement];
  animals: Animal[];
  disabled: boolean;
  arrangement: Arrangement;
  onChange: (next: Arrangement) => void;
}) {
  return <label className="grid gap-1.5 text-xs font-bold text-muted-foreground">
    <span>{label}</span>
    <select
      value={value || ""}
      disabled={disabled}
      onChange={(event) => onChange({
        ...arrangement,
        [slot]: event.currentTarget.value || null,
      })}
      className="min-h-10 min-w-0 rounded-lg border border-border bg-background px-2 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
    >
      <option value="">入れない</option>
      <option value="lucky">おまかせ</option>
      {animals.map((animal) => <option key={animal.id} value={animal.id}>{animal.label_ja}</option>)}
    </select>
  </label>;
}

function formatMilliseconds(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function slotLabel(slot: "opening" | "gaps" | "ending"): string {
  return { opening: "はじめ", gaps: "合間", ending: "おわり" }[slot];
}

mountPublicPage(<Zoovoice />);
