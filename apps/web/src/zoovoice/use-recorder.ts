import { useCallback, useEffect, useRef, useState } from "react";

const maximumRecordingMilliseconds = 60_000;
const meterBarCount = 7;

export function useRecorder() {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [durationMilliseconds, setDurationMilliseconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(meterBarCount).fill(0.12));
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);

  const releaseCapture = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setLevels(Array(meterBarCount).fill(0.12));
  }, []);

  const stop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error("このブラウザではマイク録音を利用できません。");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    chunksRef.current = [];
    setBlob(null);
    setDurationMilliseconds(0);

    const mimeType = supportedMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      const recording = new Blob(chunksRef.current, {
        type: recorder.mimeType || mimeType || "audio/webm",
      });
      setBlob(recording);
      setDurationMilliseconds(Date.now() - startedAtRef.current);
      setIsRecording(false);
      mediaRecorderRef.current = null;
      releaseCapture();
    }, { once: true });

    beginMeter(stream);
    startedAtRef.current = Date.now();
    recorder.start(200);
    setIsRecording(true);
    intervalRef.current = window.setInterval(() => {
      setDurationMilliseconds(Date.now() - startedAtRef.current);
    }, 100);
    timeoutRef.current = window.setTimeout(stop, maximumRecordingMilliseconds);
  }, [releaseCapture, stop]);

  const clear = useCallback(() => {
    setBlob(null);
    setDurationMilliseconds(0);
  }, []);

  const beginMeter = (stream: MediaStream) => {
    const AudioContextConstructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = context;
    const values = new Uint8Array(analyser.frequencyBinCount);
    const update = () => {
      analyser.getByteFrequencyData(values);
      const average = values.reduce((sum, value) => sum + value, 0) / values.length / 255;
      setLevels(Array.from({ length: meterBarCount }, (_, index) => {
        const pulse = 0.62 + Math.sin(index * 1.7 + performance.now() / 130) * 0.24;
        return Math.max(0.12, Math.min(1, average * 2.5 * pulse));
      }));
      animationFrameRef.current = window.requestAnimationFrame(update);
    };
    update();
  };

  useEffect(() => () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    releaseCapture();
  }, [releaseCapture]);

  return {
    blob,
    clear,
    durationMilliseconds,
    isRecording,
    levels,
    start,
    stop,
  };
}

function supportedMimeType(): string {
  return [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}
