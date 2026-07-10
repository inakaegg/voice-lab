import { mountPublicPage } from "../shared/bootstrap";
import { activateCompactLayout, PageShell, ProductHeader, SampleAudio } from "../shared/components";

activateCompactLayout();

const Meter = ({ id }: { id: string }) => <span id={id} className="record-level-meter" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span className="record-level-bar" key={index} />)}</span>;

function RecordButton({ id, levelId, label, className = "" }: { id: string; levelId: string; label: string; className?: string }) {
  return <button id={id} className={`record-orb practice-record-orb ${className}`.trim()} type="button" aria-label={label}><span className="record-progress" aria-hidden="true"/><span className="record-waves" aria-hidden="true"/><span className="record-icon" aria-hidden="true"/><Meter id={levelId}/><span className="record-timer" aria-hidden="true">REC</span></button>;
}

function SpeakLoop() {
  return <PageShell className="practice-shell react-practice-shell">
    <ProductHeader product="SpeakLoop" title="言いたいことで発音練習" />
    <section className="react-intro-grid">
      <div className="react-intro-copy"><p className="react-step-label">Speak naturally. Learn actively.</p><h2>自分が言いたい文章だから、練習が続く。</h2><p>母国語で話すと、学習言語のお手本を生成します。聞いて、まねして、発音を比較できます。</p></div>
      <div className="react-status-stack"><SampleAudio feature="speakloop" label="SpeakLoop サンプル"/><p className="public-privacy-notice" data-public-privacy-notice>音声は外部の音声処理APIへ送信され、公開デモでは設定に応じて短い音声履歴を保存する場合があります。機密情報を含む音声は入力しないでください。</p></div>
    </section>
    <section className="practice-quick-settings react-toolbar" aria-label="練習設定"><label className="practice-current-language practice-language-select"><span>学習言語</span><select id="practice-target-language-select" aria-label="学習する言語"><option value="ja-JP">🇯🇵 日本語</option><option value="zh-CN">🇨🇳 中文</option><option value="en-US">🇺🇸 English</option></select></label><label id="practice-pinyin-setting" className="practice-inline-setting" hidden><input id="practice-pinyin-toggle" type="checkbox" defaultChecked/><span>ピンイン</span></label></section>
    <section className="practice-flow react-practice-flow" aria-label="れんしゅう">
      <article id="practice-native-panel" className="practice-card practice-card-primary react-flow-card" data-practice-record-slot="native"><div className="practice-step-number">1</div><div className="practice-card-copy"><p className="react-step-label">YOUR IDEA</p><h2 id="practice-record-title">言いたいことを話す</h2><p>いつもの言葉で、短く話してください。</p></div><div className="react-record-control"><RecordButton id="practice-native-record-button" levelId="practice-native-level" label="言いたいことを録音"/><span>タップして話す</span></div><div id="practice-native-transcript-panel" className="practice-native-transcript-panel" hidden><p id="practice-native-transcript-label" className="practice-mini-label">言ったこと</p><p id="practice-native-transcript" className="practice-native-transcript"/></div></article>
      <article id="practice-prompt-panel" className="practice-card practice-prompt-card react-flow-card" data-practice-record-slot="repeat" hidden><div className="practice-step-number">2</div><div className="practice-card-copy"><p className="react-step-label">LISTEN & REPEAT</p><h2>聞いて、まねする</h2><p id="practice-target-label">お手本</p></div><div className="practice-target-practice-row"><div className="practice-target-text-box"><p id="practice-target-text" className="practice-target-text"/><p id="practice-target-subtext" className="practice-target-subtext" hidden/></div><div className="react-record-control react-repeat-control"><RecordButton id="practice-repeat-record-button" levelId="practice-repeat-level" label="練習を録音" className="practice-repeat-record-button"/><span>録音して比べる</span></div></div>
        <div id="practice-result-panel" className="practice-result-inline react-result-panel" hidden><p id="practice-recognized-label" className="practice-section-label">聞こえた言葉</p><p id="practice-recognized-text" className="practice-recognized-text"/><div className="practice-result-summary"><div id="practice-grade-badge" className="practice-grade-badge">--</div><p id="practice-score" className="practice-score"/></div><div className="practice-score-bar" aria-hidden="true"><span id="practice-score-fill"/></div><audio id="practice-repeat-audio" hidden/></div>
        <div className="practice-model-controls"><button id="practice-play-model-button" className="practice-play-button" type="button"><span aria-hidden="true">▶</span><span>再生</span></button><label className="practice-auto-play-control"><input id="practice-auto-play-comparison" type="checkbox" defaultChecked/><span>練習終了後すぐ再生</span></label><label className="practice-speed-control"><span>速度</span><input id="practice-speed-slider" type="range" min="0.5" max="2" step="0.1" defaultValue="1"/><output id="practice-speed-value" htmlFor="practice-speed-slider">1.0x</output></label></div><p className="practice-grade-guide">判定: 99.5%以上: できました / 95%以上: いいかんじ / 90%以上: まあまあ / 90%未満: もう一回</p><audio id="practice-model-audio" hidden/>
      </article>
    </section>
    <div id="practice-progress" className="practice-progress" hidden><span id="practice-progress-fill"/></div><p id="practice-status" className="practice-status" role="status" aria-live="polite" hidden/><p id="practice-error" className="practice-error" hidden/>
  </PageShell>;
}

mountPublicPage(<SpeakLoop />, ["/static/app_public_session.js", "/static/app_public_sample_audio.js", "/static/app_practice.js"]);
