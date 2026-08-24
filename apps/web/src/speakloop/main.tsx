import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, PageShell, PrivacyNotice, ProductHeader, TechStackNote } from "../shared/components";
import { useT } from "../shared/i18n";

activateCompactLayout();

let toTraditionalChinese: ((text: string) => string) | null = null;
let traditionalChineseLoader: Promise<void> | null = null;
const chineseScriptBridge = window as typeof window & {
  voiceLabChineseScript?: { loadTraditional: () => Promise<void>; toTraditional: (text: string) => string };
};
chineseScriptBridge.voiceLabChineseScript = {
  loadTraditional: () => {
    traditionalChineseLoader ||= import("opencc-js/cn2t").then(({ Converter }) => {
      toTraditionalChinese = Converter({ from: "cn", to: "tw" });
    });
    return traditionalChineseLoader;
  },
  toTraditional: (text) => toTraditionalChinese?.(text) || text,
};

const Meter = ({ id }: { id: string }) => <span id={id} className="record-level-meter" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span className="record-level-bar" key={index} />)}</span>;

function RecordButton({ id, levelId, label, className = "" }: { id: string; levelId: string; label: string; className?: string }) {
  return <button id={id} className={`record-orb practice-record-orb ${className}`.trim()} type="button" aria-label={label}><span className="record-progress" aria-hidden="true"/><span className="record-waves" aria-hidden="true"/><span className="record-icon" aria-hidden="true"><svg className="record-microphone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg></span><Meter id={levelId}/><span className="record-timer" aria-hidden="true">REC</span></button>;
}

function CancelRecordingButton({ id }: { id: string }) {
  const t = useT();
  return <button id={id} className="practice-record-cancel-button" type="button" aria-label={t("shared.cancelRecording")} title={t("shared.cancelRecording")} hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>;
}

function SpeakLoop() {
  const t = useT();
  return <PageShell className="practice-shell react-practice-shell">
    <ProductHeader product="SpeakLoop" title={t("speakloop.headerTitle")} githubLink />
    <section className="react-intro-grid">
      <div className="react-intro-copy"><p className="react-step-label">Speak naturally. Learn actively.</p><h2>{t("speakloop.tagline")}</h2><p>{t("speakloop.lead")}</p></div>
    </section>
    <section className="practice-quick-settings react-toolbar" aria-label={t("speakloop.settings")}>
      <label className="practice-current-language practice-language-select"><span>{t("speakloop.targetLanguage")}</span><select id="practice-target-language-select" aria-label={t("speakloop.targetLanguageAria")} defaultValue="en-US"><option value="en-US">🇺🇸 English</option><option value="zh-CN">🇨🇳 中文</option></select></label>
      <label id="practice-comparison-model-setting" className="practice-current-language practice-language-select practice-comparison-model" hidden><span>{t("speakloop.comparisonModel")}</span><select id="practice-comparison-model-select" aria-label={t("speakloop.comparisonModelAria")} defaultValue="gpt-5.6-terra"><option value="gpt-5.6-terra">Terra</option><option value="gpt-5.6-luna">Luna</option><option value="gpt-5.4-mini">5.4 mini</option><option value="gpt-5.4-nano">5.4 nano</option></select></label>
      <label id="practice-playback-padding-setting" className="practice-current-language practice-playback-padding" hidden><span>{t("speakloop.playbackPadding")}</span><input id="practice-playback-padding-slider" type="range" min="0" max="0.5" step="0.05" defaultValue="0.3"/><output id="practice-playback-padding-value" htmlFor="practice-playback-padding-slider">0.30{t("shared.secondsUnit")}</output></label>
      <fieldset id="practice-chinese-script-setting" className="practice-script-setting" hidden><legend>{t("speakloop.scriptLegend")}</legend><div className="practice-script-toggle" role="group" aria-label={t("speakloop.scriptAria")} data-script="simplified"><span className="practice-script-indicator" aria-hidden="true"/><button id="practice-script-simplified" type="button" aria-pressed="true">简体</button><button id="practice-script-traditional" type="button" aria-pressed="false">繁體</button></div></fieldset>
      <label id="practice-pinyin-setting" className="practice-inline-setting" hidden><input id="practice-pinyin-toggle" type="checkbox" defaultChecked/><span>{t("speakloop.pinyin")}</span></label>
      <div className="practice-own-voice-setting"><label className="practice-own-voice-control"><input id="practice-own-voice-toggle" type="checkbox" aria-describedby="practice-own-voice-tooltip"/><span className="practice-own-voice-switch" aria-hidden="true"/><span>{t("speakloop.ownVoice")}</span></label><p id="practice-own-voice-tooltip" className="practice-own-voice-tooltip" role="tooltip">{t("speakloop.ownVoiceTooltip")}</p></div>
    </section>
    <details id="practice-history-preview" className="practice-history-preview" hidden>
      <summary>{t("speakloop.historyPreview")}</summary>
      <div className="practice-history-preview-controls">
        <label><span>{t("speakloop.historyAttempts")}</span><select id="practice-history-preview-select" aria-label={t("speakloop.historyAttemptsAria")}/></label>
        <label className="practice-history-preview-source"><span>{t("speakloop.comparisonRange")}</span><select id="practice-history-preview-source-select" aria-label={t("speakloop.comparisonRangeAria")} defaultValue="saved"><option value="saved">{t("speakloop.comparisonSaved")}</option><option value="recomputed">{t("speakloop.comparisonRecomputed")}</option></select></label>
        <button id="practice-history-preview-button" type="button" disabled>{t("speakloop.historyShow")}</button>
      </div>
      <p id="practice-history-preview-status" role="status" aria-live="polite">{t("speakloop.historyLoading")}</p>
    </details>
    <section className="practice-flow react-practice-flow" aria-label={t("speakloop.flow")}>
      <article id="practice-native-panel" className="practice-card practice-card-primary react-flow-card" data-practice-record-slot="native"><div className="practice-step-number">1</div><div className="practice-card-copy"><p className="react-step-label">YOUR IDEA</p><h2 id="practice-record-title">{t("speakloop.step1Title")}</h2><p>{t("speakloop.step1Lead")}</p></div><div className="react-record-control"><RecordButton id="practice-native-record-button" levelId="practice-native-level" label={t("speakloop.recordNative")}/><span>{t("shared.tapToSpeak")}</span><CancelRecordingButton id="practice-native-cancel-button"/></div><div id="practice-native-transcript-panel" className="practice-native-transcript-panel" hidden><p id="practice-native-transcript-label" className="practice-mini-label">{t("speakloop.nativeTranscriptLabel")}</p><p id="practice-native-transcript" className="practice-native-transcript"/></div></article>
      <article id="practice-prompt-panel" className="practice-card practice-prompt-card react-flow-card" data-practice-record-slot="repeat" hidden><div className="practice-step-number">2</div><div className="practice-card-copy"><p className="react-step-label">LISTEN & REPEAT</p><h2>{t("speakloop.step2Title")}</h2><p id="practice-target-label">{t("speakloop.targetLabel")}</p></div><div className="practice-target-practice-row"><div className="practice-target-text-box"><p id="practice-target-text" className="practice-target-text"/><p id="practice-target-subtext" className="practice-target-subtext" hidden/></div><div className="react-record-control react-repeat-control"><RecordButton id="practice-repeat-record-button" levelId="practice-repeat-level" label={t("speakloop.recordRepeat")} className="practice-repeat-record-button"/><span>{t("speakloop.recordAndCompare")}</span><CancelRecordingButton id="practice-repeat-cancel-button"/></div></div>
        <div id="practice-result-panel" className="practice-result-inline react-result-panel" hidden><p id="practice-saved-result-notice" className="practice-saved-result-notice" hidden>{t("speakloop.savedResultNotice")}</p><p id="practice-recognized-label" className="practice-section-label">{t("speakloop.recognizedLabel")}</p><p id="practice-recognized-text" className="practice-recognized-text"/><div className="practice-result-summary"><div id="practice-grade-badge" className="practice-grade-badge">{t("speakloop.gradeBadge")}</div><p id="practice-score" className="practice-score"/></div><div className="practice-score-bar" aria-hidden="true"><span id="practice-score-fill"/></div><p id="practice-overall-comment" className="practice-overall-comment"/><ol id="practice-phrase-feedback" className="practice-phrase-feedback"/><p id="practice-comparison-note" className="practice-comparison-note" role="status" aria-live="polite" hidden/><audio id="practice-repeat-audio" hidden/></div>
        <div className="practice-model-controls"><button id="practice-play-model-button" className="practice-play-button" type="button" disabled><span aria-hidden="true">▶</span><span>{t("speakloop.playModel")}</span></button><button id="practice-play-model-only-button" className="practice-play-button practice-play-model-only-button" type="button" disabled hidden><span aria-hidden="true">▶</span><span>{t("speakloop.playModelOnly")}</span></button><label className="practice-speed-control"><span>{t("speakloop.speed")}</span><input id="practice-speed-slider" type="range" min="0.5" max="2" step="0.1" defaultValue="1"/><output id="practice-speed-value" htmlFor="practice-speed-slider">1.0x</output></label></div><audio id="practice-model-audio" hidden/>
      </article>
    </section>
    <section id="practice-job-status" className="practice-job-status" data-state="idle" role="status" aria-live="polite" hidden>
      <span className="practice-job-status-indicator" aria-hidden="true" />
      <div className="practice-job-status-copy">
        <strong id="practice-job-status-label">{t("speakloop.jobStatusInitial")}</strong>
        <span id="practice-job-status-model" className="practice-job-status-model" />
        <small id="practice-job-status-detail" className="practice-job-status-detail" />
      </div>
    </section>
    <div id="practice-progress" className="practice-progress" hidden><span id="practice-progress-fill"/></div><p id="practice-status" className="practice-status" role="status" aria-live="polite" hidden/><p id="practice-error" className="practice-error" hidden/>
    <TechStackNote className="mt-auto" items={["React", "Cloudflare Workers", "OpenAI API", "RunPod Serverless", "FunASR", "Seed-VC"]} />
    <PrivacyNotice />
  </PageShell>;
}

mountPublicPage(<SpeakLoop />, ["/static/app_public_session.js", "/static/app_public_sample_audio.js", "/static/practice_playback.js", "/static/app_practice.js"]);
