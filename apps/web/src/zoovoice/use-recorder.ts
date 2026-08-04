import { useCallback, useEffect, useRef, useState } from "react";

const maximumRecordingMilliseconds = 60_000;
const meterBarCount = 7;
const idleLevels = () => Array(meterBarCount).fill(0.12) as number[];

type TerminalOperation = "active" | "stop" | "cancel";

type RecordingSession = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  terminal: TerminalOperation;
  audioContext: AudioContext | null;
  animationFrame: number | null;
  interval: number | null;
  timeout: number | null;
};

export function useRecorder() {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [durationMilliseconds, setDurationMilliseconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(idleLevels);
  const sessionRef = useRef<RecordingSession | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  const releaseSession = useCallback((session: RecordingSession) => {
    if (session.animationFrame !== null) window.cancelAnimationFrame(session.animationFrame);
    if (session.interval !== null) window.clearInterval(session.interval);
    if (session.timeout !== null) window.clearTimeout(session.timeout);
    session.animationFrame = null;
    session.interval = null;
    session.timeout = null;
    session.stream.getTracks().forEach((track) => track.stop());
    void session.audioContext?.close();
    session.audioContext = null;
    if (mountedRef.current) setLevels(idleLevels());
  }, []);

  const finishSession = useCallback((session: RecordingSession, operation: Exclude<TerminalOperation, "active">) => {
    if (sessionRef.current !== session || session.terminal !== "active" || session.recorder.state !== "recording") {
      return false;
    }
    session.terminal = operation;
    if (session.timeout !== null) {
      window.clearTimeout(session.timeout);
      session.timeout = null;
    }
    if (mountedRef.current) {
      setIsRecording(false);
      setIsFinalizing(true);
    }
    session.recorder.stop();
    return true;
  }, []);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    return session ? finishSession(session, "stop") : false;
  }, [finishSession]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    return session ? finishSession(session, "cancel") : false;
  }, [finishSession]);

  const start = useCallback(async () => {
    if (startingRef.current || sessionRef.current) return false;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error("このブラウザではマイク録音を利用できません。");
    }
    startingRef.current = true;
    if (mountedRef.current) setIsStarting(true);
    let stream: MediaStream | null = null;
    let session: RecordingSession | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      const mimeType = supportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const ownedSession: RecordingSession = {
        recorder,
        stream,
        chunks: [],
        startedAt: Date.now(),
        terminal: "active",
        audioContext: null,
        animationFrame: null,
        interval: null,
        timeout: null,
      };
      session = ownedSession;
      sessionRef.current = ownedSession;
      setBlob(null);
      setDurationMilliseconds(0);

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) ownedSession.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const duration = Date.now() - ownedSession.startedAt;
        if (mountedRef.current && ownedSession.terminal === "stop") {
          setBlob(new Blob(ownedSession.chunks, {
            type: recorder.mimeType || mimeType || "audio/webm",
          }));
          setDurationMilliseconds(duration);
        }
        releaseSession(ownedSession);
        if (sessionRef.current === ownedSession) sessionRef.current = null;
        if (mountedRef.current) setIsFinalizing(false);
      }, { once: true });

      beginMeter(ownedSession, setLevels);
      recorder.start(200);
      setIsRecording(true);
      ownedSession.interval = window.setInterval(() => {
        if (mountedRef.current) setDurationMilliseconds(Date.now() - ownedSession.startedAt);
      }, 100);
      ownedSession.timeout = window.setTimeout(
        () => finishSession(ownedSession, "stop"),
        maximumRecordingMilliseconds,
      );
      return true;
    } catch (error) {
      if (session) {
        session.terminal = "cancel";
        if (sessionRef.current === session) sessionRef.current = null;
        if (session.recorder.state === "recording") session.recorder.stop();
        releaseSession(session);
      } else {
        stream?.getTracks().forEach((track) => track.stop());
      }
      throw error;
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [finishSession, releaseSession]);

  const clear = useCallback(() => {
    setBlob(null);
    setDurationMilliseconds(0);
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    startingRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    session.terminal = "cancel";
    if (session.recorder.state === "recording") session.recorder.stop();
    releaseSession(session);
  }, [releaseSession]);

  return {
    blob,
    cancel,
    clear,
    durationMilliseconds,
    isFinalizing,
    isRecording,
    isStarting,
    levels,
    start,
    stop,
  };
}

function beginMeter(session: RecordingSession, setLevels: (levels: number[]) => void) {
  const AudioContextConstructor = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  const context = new AudioContextConstructor();
  session.audioContext = context;
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  context.createMediaStreamSource(session.stream).connect(analyser);
  const values = new Uint8Array(analyser.frequencyBinCount);
  const update = () => {
    if (session.terminal !== "active") return;
    analyser.getByteFrequencyData(values);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length / 255;
    setLevels(Array.from({ length: meterBarCount }, (_, index) => {
      const pulse = 0.62 + Math.sin(index * 1.7 + performance.now() / 130) * 0.24;
      return Math.max(0.12, Math.min(1, average * 2.5 * pulse));
    }));
    session.animationFrame = window.requestAnimationFrame(update);
  };
  update();
}

function supportedMimeType(): string {
  return [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}
