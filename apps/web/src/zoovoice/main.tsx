import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles } from "lucide-react";
import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from "react";

import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, PageShell, PrivacyNotice, ProductHeader, TechStackNote } from "../shared/components";
import { animalEmoji } from "./animal-emoji";
import {
  composeRecording,
  fetchZoovoiceConfig,
  isRetryableZoovoiceError,
  wavBlobFromBase64,
  type ComposeResponse,
  type SoundCredit,
  type ZoovoiceConfig,
} from "./api";
import { defaultIntensity, intensityStage, intensityStageCount, intensityStageValues } from "./intensity";

// 動物の種類数。既定は1種で、2種にすると2種類の鳴き声が交互に入る。
const defaultAnimalCount = 1;
const animalCountChoices = [1, 2];
import { RecordOrb } from "./record-orb";
import { ResultPlayer } from "./result-player";
import {
  controlsForZoovoiceState,
  initialZoovoiceState,
  isComposeReady,
  isTurnstileTokenFresh,
  zoovoiceReducer,
} from "./state";
import { TurnstileWidget } from "./turnstile-widget";
import { useRecorder } from "./use-recorder";

activateCompactLayout();

const minimumRecordingMilliseconds = 500;
const verificationTimeoutMilliseconds = 30_000;
const interactiveTimeoutMilliseconds = 120_000;

type ResultState = {
  payload: ComposeResponse;
  url: string;
};

type RecordingState = {
  id: number;
  blob: Blob;
  intensity: number;
  animalCount: number;
};

type ComposeAttempt = RecordingState & {
  attemptId: number;
  status: "armed" | "sent";
};

type TurnstileToken = {
  value: string;
  issuedAt: number;
};

function Zoovoice() {
  const [state, dispatch] = useReducer(zoovoiceReducer, initialZoovoiceState);
  const [intensity, setIntensity] = useState(defaultIntensity);
  const [animalCount, setAnimalCount] = useState(defaultAnimalCount);
  const [result, setResult] = useState<ResultState | null>(null);
  const [config, setConfig] = useState<ZoovoiceConfig | null>(null);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [attempt, setAttempt] = useState<ComposeAttempt | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<TurnstileToken>({ value: "", issuedAt: 0 });
  const [turnstileResetVersion, setTurnstileResetVersion] = useState(0);
  const [turnstileUnavailable, setTurnstileUnavailable] = useState(false);
  const [turnstileInteractive, setTurnstileInteractive] = useState(false);
  const [interactionStartedAt, setInteractionStartedAt] = useState(0);
  const recorder = useRecorder();
  const recordingIdRef = useRef(0);
  const attemptIdRef = useRef(0);
  const activeRecordingRef = useRef<{ id: number; intensity: number; animalCount: number } | null>(null);
  const sentAttemptsRef = useRef(new Set<number>());
  const resetStaleTokensRef = useRef(new Set<string>());
  const verificationAttemptRef = useRef(0);
  const verificationRemainingRef = useRef(verificationTimeoutMilliseconds);
  const verificationSegmentStartedRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchZoovoiceConfig(controller.signal)
      .then((loadedConfig) => {
        setConfig(loadedConfig);
        if (!loadedConfig.enabled) {
          dispatch({ type: "failed", kind: "setup_failed", message: "Zoovoiceは現在利用できません。" });
          return;
        }
        dispatch({ type: "config_loaded" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: "failed",
          kind: "setup_failed",
          message: messageFromError(error, "Zoovoiceを準備できませんでした。"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (
      state.phase === "recording"
      && activeRecordingRef.current
      && (recorder.isFinalizing || !recorder.isRecording)
    ) {
      dispatch({ type: "recording_stopping" });
    }
  }, [recorder.isFinalizing, recorder.isRecording, state.phase]);

  useEffect(() => {
    if (!recorder.blob || state.phase !== "finalizing") return;
    const active = activeRecordingRef.current;
    if (!active) return;
    if (recorder.durationMilliseconds < minimumRecordingMilliseconds) {
      recorder.clear();
      activeRecordingRef.current = null;
      setRecording(null);
      setAttempt(null);
      dispatch({ type: "recording_too_short" });
      return;
    }
    const nextRecording: RecordingState = {
      id: active.id,
      blob: recorder.blob,
      intensity: active.intensity,
      animalCount: active.animalCount,
    };
    const nextAttempt: ComposeAttempt = {
      ...nextRecording,
      attemptId: ++attemptIdRef.current,
      status: "armed",
    };
    activeRecordingRef.current = null;
    setRecording(nextRecording);
    setAttempt(nextAttempt);
    if (!isComposeReady(
      config?.turnstile_required === true,
      turnstileToken.value,
      turnstileToken.issuedAt,
    )) {
      dispatch({ type: "verification_waiting" });
    }
  }, [
    config?.turnstile_required,
    recorder.blob,
    recorder.clear,
    recorder.durationMilliseconds,
    state.phase,
    turnstileToken,
  ]);

  useEffect(() => {
    if (
      !attempt
      || attempt.status !== "armed"
      || config?.turnstile_required !== true
      || !turnstileToken.value
      || isTurnstileTokenFresh(turnstileToken.value, turnstileToken.issuedAt)
      || resetStaleTokensRef.current.has(turnstileToken.value)
    ) return;
    resetStaleTokensRef.current.add(turnstileToken.value);
    setTurnstileToken({ value: "", issuedAt: 0 });
    setTurnstileResetVersion((current) => current + 1);
    dispatch({ type: "verification_waiting" });
  }, [attempt, config?.turnstile_required, turnstileToken]);

  useEffect(() => {
    if (!attempt || attempt.status !== "armed" || !config) return;
    if (!isComposeReady(
      config.turnstile_required,
      turnstileToken.value,
      turnstileToken.issuedAt,
    )) {
      if (state.phase !== "verifying") dispatch({ type: "verification_waiting" });
      return;
    }
    if (sentAttemptsRef.current.has(attempt.attemptId)) return;
    sentAttemptsRef.current.add(attempt.attemptId);
    setAttempt({ ...attempt, status: "sent" });
    dispatch({ type: "compose_started" });

    void composeRecording(attempt.blob, attempt.intensity, attempt.animalCount, turnstileToken.value)
      .then((payload) => {
        const url = URL.createObjectURL(wavBlobFromBase64(payload.audio.base64));
        setResult({ payload, url });
        dispatch({ type: "compose_succeeded", fallback: false });
      })
      .catch((error: unknown) => {
        dispatch({
          type: "failed",
          kind: isRetryableZoovoiceError(error) ? "compose_retryable" : "compose_terminal",
          message: messageFromError(error, "音声を生成できませんでした。もう一度お試しください。"),
        });
      })
      .finally(() => {
        if (config.turnstile_required) {
          setTurnstileToken({ value: "", issuedAt: 0 });
          setTurnstileResetVersion((current) => current + 1);
        }
      });
  }, [attempt, config, state.phase, turnstileToken]);

  useEffect(() => {
    if (state.phase !== "verifying" || !attempt) return undefined;
    if (verificationAttemptRef.current !== attempt.attemptId) {
      verificationAttemptRef.current = attempt.attemptId;
      verificationRemainingRef.current = verificationTimeoutMilliseconds;
      verificationSegmentStartedRef.current = 0;
    }
    const fail = () => {
      setAttempt(null);
      dispatch({
        type: "failed",
        kind: "verify_timeout",
        message: "不正利用防止の確認を完了できませんでした。ページを再読み込みするか、もう一度録音してください。",
      });
    };

    let timeout: number;
    if (turnstileInteractive) {
      const remaining = Math.max(0, interactiveTimeoutMilliseconds - (Date.now() - interactionStartedAt));
      timeout = window.setTimeout(fail, remaining);
    } else {
      verificationSegmentStartedRef.current = Date.now();
      timeout = window.setTimeout(fail, verificationRemainingRef.current);
    }
    return () => {
      window.clearTimeout(timeout);
      if (!turnstileInteractive && verificationSegmentStartedRef.current > 0) {
        verificationRemainingRef.current = Math.max(
          0,
          verificationRemainingRef.current - (Date.now() - verificationSegmentStartedRef.current),
        );
        verificationSegmentStartedRef.current = 0;
      }
    };
  }, [attempt, interactionStartedAt, state.phase, turnstileInteractive]);

  useEffect(() => {
    const url = result?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [result?.url]);

  const handleTurnstileToken = useCallback((token: string) => {
    setTurnstileToken({ value: token, issuedAt: token ? Date.now() : 0 });
  }, []);

  const handleTurnstileUnavailable = useCallback((message: string) => {
    setTurnstileUnavailable(true);
    dispatch({ type: "failed", kind: "setup_failed", message });
  }, []);

  const handleTurnstileInteraction = useCallback((interactive: boolean) => {
    setTurnstileInteractive(interactive);
    setInteractionStartedAt(interactive ? Date.now() : 0);
  }, []);

  const beginOrStopRecording = async () => {
    if (recorder.isRecording) {
      if (recorder.stop()) dispatch({ type: "recording_stopping" });
      return;
    }
    if (recorder.isStarting || recorder.isFinalizing) return;
    const id = ++recordingIdRef.current;
    activeRecordingRef.current = { id, intensity, animalCount };
    recorder.clear();
    setRecording(null);
    setAttempt(null);
    setResult(null);
    dispatch({ type: "recording_starting" });
    try {
      if (await recorder.start()) dispatch({ type: "recording_started" });
    } catch (error) {
      activeRecordingRef.current = null;
      dispatch({
        type: "failed",
        kind: "mic_denied",
        message: error instanceof DOMException && error.name === "NotAllowedError"
          ? "マイクを使用できません。ブラウザの権限を確認してください。"
          : "マイクを使用できません。ブラウザの設定を確認してください。",
      });
    }
  };

  const cancelRecording = () => {
    if (!recorder.cancel()) return;
    activeRecordingRef.current = null;
    setRecording(null);
    setAttempt(null);
    recorder.clear();
    dispatch({ type: "recording_cancelled" });
  };

  const retryCompose = () => {
    if (!recording) return;
    const nextAttempt: ComposeAttempt = {
      ...recording,
      intensity,
      animalCount,
      attemptId: ++attemptIdRef.current,
      status: "armed",
    };
    setRecording({ ...recording, intensity, animalCount });
    setAttempt(nextAttempt);
    if (!isComposeReady(
      config?.turnstile_required === true,
      turnstileToken.value,
      turnstileToken.issuedAt,
    )) {
      dispatch({ type: "verification_waiting" });
    }
  };

  const controls = controlsForZoovoiceState(state, {
    configEnabled: config?.enabled === true && !turnstileUnavailable,
    hasRecording: Boolean(recording),
  });
  const orbDisabled = !controls.orbEnabled || recorder.isStarting || recorder.isFinalizing;
  const isProcessing = state.phase === "processing";

  return <PageShell className="zoovoice-shell max-w-[1120px]">
    <ProductHeader product="zoovoice" title="声から動物を連想する" />
    <section className="mb-3 flex flex-col gap-1.5 border-l-[3px] border-[var(--react-ink)] pl-4 sm:mb-4 sm:flex-row sm:items-end sm:justify-between sm:gap-5">
      <div>
        <p className="text-[0.66rem] font-bold uppercase tracking-[0.18em] text-[var(--react-muted)]">Record · Associate · Play</p>
        <h2 className="text-balance text-[clamp(1.45rem,3vw,2.25rem)] font-bold leading-tight tracking-[-0.04em] text-[var(--react-ink)]">話すだけで、ぴったりの動物を。</h2>
      </div>
      <p className="max-w-[34rem] text-xs leading-5 text-[var(--react-muted)] sm:text-right sm:text-sm">話した内容から動物を選び、その鳴き声を言葉の切れ目へ差し込みます。</p>
    </section>

    <main data-testid="zoovoice-workspace" className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
      <Card className="min-w-0 gap-0 overflow-visible rounded-[1.35rem] border-border/80 py-0 shadow-sm">
        <CardHeader className="gap-1 border-b border-border/70 px-4 py-3.5 sm:px-5">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.15em] text-muted-foreground">01 · Record</p>
          <CardTitle className="text-lg tracking-[-0.025em]">声を録音する</CardTitle>
          <CardDescription className="text-xs leading-5">停止すると自動で生成を開始します。60秒で自動停止した場合も送信します。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3.5 p-4 sm:p-5">
          <RecordOrb
            disabled={orbDisabled}
            durationMilliseconds={recorder.durationMilliseconds}
            isProcessing={isProcessing}
            isRecording={recorder.isRecording}
            levels={recorder.levels}
            onCancel={cancelRecording}
            onPress={() => void beginOrStopRecording()}
          />

          <label className="grid gap-1.5 text-sm font-bold text-foreground">
            <span className="flex items-center justify-between gap-4"><span>アニマル度</span><output htmlFor="zoovoice-intensity" className="tabular-nums text-muted-foreground">{intensityStage(intensity)} / {intensityStageCount}</output></span>
            <input
              id="zoovoice-intensity"
              type="range"
              min="0"
              max="100"
              step="25"
              list="zoovoice-intensity-stages"
              value={intensity}
              disabled={!controls.sliderEnabled}
              onChange={(event) => setIntensity(Number(event.currentTarget.value))}
              className="w-full accent-foreground"
            />
            <datalist id="zoovoice-intensity-stages">
              {intensityStageValues.map((value) => <option key={value} value={value} />)}
            </datalist>
            <span className="flex justify-between gap-3 text-[0.65rem] font-medium text-muted-foreground"><span>ひかえめ</span><span>{controls.retryVisible ? "次の再生成にも反映" : "次の録音に反映"}</span><span>にぎやか</span></span>
          </label>

          {/* legend は互換layerの素の要素selectorが色と字を上書きするため、この route では使わない。 */}
          <div data-testid="zoovoice-animal-count" role="radiogroup" aria-label="動物の数" className="grid gap-1.5">
            <span className="text-sm font-bold text-foreground">動物の数</span>
            <div className="grid grid-cols-2 gap-2">
              {animalCountChoices.map((value) => <label
                key={value}
                className={`inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl border px-3 py-2 text-sm font-bold transition-colors ${animalCount === value ? "border-foreground bg-foreground text-background" : "border-border bg-background text-foreground hover:bg-muted"} has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/45`}
              >
                <input
                  type="radio"
                  name="zoovoice-animal-count"
                  value={value}
                  checked={animalCount === value}
                  disabled={!controls.sliderEnabled}
                  onChange={() => setAnimalCount(value)}
                  className="sr-only"
                />
                {value}種
              </label>)}
            </div>
          </div>

          {config?.turnstile_required && <TurnstileWidget
            siteKey={config.turnstile_site_key}
            resetVersion={turnstileResetVersion}
            onToken={handleTurnstileToken}
            onUnavailable={handleTurnstileUnavailable}
            onInteractionChange={handleTurnstileInteraction}
          />}

          <div className="grid gap-1.5">
            {controls.retryVisible && <button
              type="button"
              onClick={retryCompose}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-2.5 text-sm font-bold text-background shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 motion-reduce:transition-none"
            >
              <Sparkles className="size-4" aria-hidden="true" />
              もう一度生成
            </button>}
            <p
              role="status"
              aria-live="polite"
              data-testid="zoovoice-status"
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
              <p className="max-w-[28rem] text-sm leading-6">録音を止めると、選ばれた動物と鳴き声入り音声をここに表示します。</p>
            </div>}
        </CardContent>
      </Card>
    </main>
    <TechStackNote items={["React", "Cloudflare Workers", "Cloudflare Turnstile", "Go", "Google Cloud Run", "whisper.cpp", "OpenAI API", "ffmpeg"]} />
    <PrivacyNotice />
  </PageShell>;
}

function ResultDetails({ result }: { result: ResultState }) {
  const meta = result.payload.meta;
  return <>
    <div data-testid="zoovoice-animal-figure" className="grid gap-2 rounded-xl border border-border/70 bg-muted/35 px-3.5 py-3">
      {meta.selected_animals.map((animal) => <span key={animal.id} className="flex items-center gap-3.5">
        <span aria-hidden="true" className="text-[2.75rem] leading-none">{animalEmoji(animal.id)}</span>
        <span className="min-w-0 break-words text-xl font-bold tracking-[-0.02em] text-foreground">{animal.label_ja}</span>
      </span>)}
    </div>
    <dl className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-border/70 bg-muted/35 px-3.5 py-3 text-xs leading-5">
      <dt className="font-semibold text-muted-foreground">聞き取った言葉</dt>
      <dd className="min-w-0 break-words text-foreground">{meta.transcript}</dd>
      {meta.selected_animals.map((animal) => <Fragment key={animal.id}>
        <dt className="font-semibold text-muted-foreground">{animal.label_ja}を選んだ理由</dt>
        <dd className="min-w-0 break-words text-foreground">{animal.reason}</dd>
      </Fragment>)}
    </dl>
    <ResultPlayer source={result.url} fallbackDuration={meta.output_duration_seconds} autoPlay />
    <p className="break-words text-[0.68rem] leading-5 text-muted-foreground">
      {meta.insertions.length}か所に「{meta.selected_animals.map((animal) => animal.label_ja).join("」と「")}」の鳴き声を差し込みました。
    </p>
    <SoundCredits credits={meta.sound_credits ?? []} />
  </>;
}

// 鳴き声素材の出典表示。CC BYの素材は表示が利用条件なので、使った素材を必ず並べる。
// 素材はいずれも無音除去とトリム、音量調整を経ているため、改変した旨も添える。
function SoundCredits({ credits }: { credits: SoundCredit[] }) {
  if (credits.length === 0) return null;
  return <div data-testid="zoovoice-sound-credits" className="grid gap-1 border-t border-border/70 pt-2.5 text-[0.68rem] leading-5 text-muted-foreground">
    <p className="font-semibold">鳴き声素材の出典（無音除去・トリム・音量調整を実施）</p>
    <ul className="grid gap-0.5">
      {credits.map((credit) => <li key={`${credit.license}/${credit.creator ?? ""}/${credit.source_url ?? ""}`} className="break-words">
        {credit.license}
        {credit.creator ? ` / ${credit.creator}` : ""}
        {credit.source_url
          ? <> / <a href={credit.source_url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">出典</a></>
          : null}
      </li>)}
    </ul>
  </div>;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

mountPublicPage(<Zoovoice />);
