import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, PageShell, PrivacyNotice, ProductHeader } from "../shared/components";

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
  return <button id={id} className="practice-record-cancel-button" type="button" aria-label="録音をキャンセル" title="録音をキャンセル" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>;
}

function SpeakLoop() {
  return <PageShell className="practice-shell react-practice-shell">
    <ProductHeader product="SpeakLoop" title="言いたいことで発音練習" />
    <section className="react-intro-grid">
      <div className="react-intro-copy"><p className="react-step-label">Speak naturally. Learn actively.</p><h2>自分が言いたい文章だから、練習が続く。</h2><p>母国語で話すと、学習言語のお手本を生成します。聞いて、まねして、発音を比較できます。</p></div>
    </section>
    <section className="practice-quick-settings react-toolbar" aria-label="練習設定">
      <label className="practice-current-language practice-language-select"><span>学習言語</span><select id="practice-target-language-select" aria-label="学習する言語" defaultValue="en-US"><option value="en-US">🇺🇸 English</option><option value="zh-CN">🇨🇳 中文</option></select></label>
      <label className="practice-current-language practice-language-select practice-comparison-model"><span>比較モデル</span><select id="practice-comparison-model-select" aria-label="比較と採点に使うモデル" defaultValue="gpt-5.6-terra"><option value="gpt-5.6-terra">Terra</option><option value="gpt-5.6-luna">Luna</option><option value="gpt-5.4-mini">5.4 mini</option><option value="gpt-5.4-nano">5.4 nano</option></select></label>
      <label className="practice-current-language practice-playback-padding"><span>前後余白</span><input id="practice-playback-padding-slider" type="range" min="0" max="0.5" step="0.05" defaultValue="0.1"/><output id="practice-playback-padding-value" htmlFor="practice-playback-padding-slider">0.10秒</output></label>
      <fieldset id="practice-chinese-script-setting" className="practice-script-setting" hidden><legend>字形</legend><div className="practice-script-toggle" role="group" aria-label="中国語の字形" data-script="simplified"><span className="practice-script-indicator" aria-hidden="true"/><button id="practice-script-simplified" type="button" aria-pressed="true">简体</button><button id="practice-script-traditional" type="button" aria-pressed="false">繁體</button></div></fieldset>
      <label id="practice-pinyin-setting" className="practice-inline-setting" hidden><input id="practice-pinyin-toggle" type="checkbox" defaultChecked/><span>ピンイン</span></label>
      <div className="practice-own-voice-setting"><label className="practice-own-voice-control"><input id="practice-own-voice-toggle" type="checkbox" aria-describedby="practice-own-voice-tooltip"/><span className="practice-own-voice-switch" aria-hidden="true"/><span>自分の声</span></label><p id="practice-own-voice-tooltip" className="practice-own-voice-tooltip" role="tooltip">「自分の声」は、同じセッションであなたが最初に録音した音声からAI生成音声を作ります。</p></div>
    </section>
    <section className="practice-flow react-practice-flow" aria-label="れんしゅう">
      <article id="practice-native-panel" className="practice-card practice-card-primary react-flow-card" data-practice-record-slot="native"><div className="practice-step-number">1</div><div className="practice-card-copy"><p className="react-step-label">YOUR IDEA</p><h2 id="practice-record-title">言いたいことを話す</h2><p>いつもの言葉で、短く話してください。</p></div><div className="react-record-control"><RecordButton id="practice-native-record-button" levelId="practice-native-level" label="言いたいことを録音"/><span>タップして話す</span><CancelRecordingButton id="practice-native-cancel-button"/></div><div id="practice-native-transcript-panel" className="practice-native-transcript-panel" hidden><p id="practice-native-transcript-label" className="practice-mini-label">言ったこと</p><p id="practice-native-transcript" className="practice-native-transcript"/></div></article>
      <article id="practice-prompt-panel" className="practice-card practice-prompt-card react-flow-card" data-practice-record-slot="repeat" hidden><div className="practice-step-number">2</div><div className="practice-card-copy"><p className="react-step-label">LISTEN & REPEAT</p><h2>聞いて、まねする</h2><p id="practice-target-label">お手本</p></div><div className="practice-target-practice-row"><div className="practice-target-text-box"><p id="practice-target-text" className="practice-target-text"/><p id="practice-target-subtext" className="practice-target-subtext" hidden/></div><div className="react-record-control react-repeat-control"><RecordButton id="practice-repeat-record-button" levelId="practice-repeat-level" label="練習を録音" className="practice-repeat-record-button"/><span>録音して比べる</span><CancelRecordingButton id="practice-repeat-cancel-button"/></div></div>
        <div id="practice-result-panel" className="practice-result-inline react-result-panel" hidden><p id="practice-recognized-label" className="practice-section-label">聞こえた言葉</p><p id="practice-recognized-text" className="practice-recognized-text"/><div className="practice-result-summary"><div id="practice-grade-badge" className="practice-grade-badge">LLM採点</div><p id="practice-score" className="practice-score"/></div><div className="practice-score-bar" aria-hidden="true"><span id="practice-score-fill"/></div><p id="practice-overall-comment" className="practice-overall-comment"/><ol id="practice-phrase-feedback" className="practice-phrase-feedback"/><p id="practice-comparison-note" className="practice-comparison-note" role="status" aria-live="polite" hidden/><audio id="practice-repeat-audio" hidden/></div>
        <div className="practice-model-controls"><button id="practice-play-model-button" className="practice-play-button" type="button" disabled><span aria-hidden="true">▶</span><span>お手本を再生</span></button><button id="practice-play-model-only-button" className="practice-play-button practice-play-model-only-button" type="button" disabled hidden><span aria-hidden="true">▶</span><span>お手本だけ再生</span></button><label className="practice-speed-control"><span>速度</span><input id="practice-speed-slider" type="range" min="0.5" max="2" step="0.1" defaultValue="1"/><output id="practice-speed-value" htmlFor="practice-speed-slider">1.0x</output></label></div><audio id="practice-model-audio" hidden/>
      </article>
    </section>
    <section id="practice-job-status" className="practice-job-status" data-state="idle" role="status" aria-live="polite" hidden>
      <span className="practice-job-status-indicator" aria-hidden="true" />
      <div className="practice-job-status-copy">
        <strong id="practice-job-status-label">処理を準備しています</strong>
        <span id="practice-job-status-model" className="practice-job-status-model" />
        <small id="practice-job-status-detail" className="practice-job-status-detail" />
      </div>
    </section>
    <div id="practice-progress" className="practice-progress" hidden><span id="practice-progress-fill"/></div><p id="practice-status" className="practice-status" role="status" aria-live="polite" hidden/><p id="practice-error" className="practice-error" hidden/>
    <PrivacyNotice />
  </PageShell>;
}

mountPublicPage(<SpeakLoop />, ["/static/app_public_session.js", "/static/app_public_sample_audio.js", "/static/practice_playback.js", "/static/app_practice.js"]);
