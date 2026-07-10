import { mountPublicPage } from "../shared/bootstrap";

function Portal() {
  return <main className="react-portal-shell" aria-label="Voice Lab">
    <header className="react-portal-hero"><p className="react-eyebrow">Voice Lab</p><h1>声から、ことばの体験をつくる。</h1><p>話す、聞く、演じる。AI音声を使った2つの実験を、すぐに試せます。</p></header>
    <nav className="react-product-grid" aria-label="アプリ">
      <a className="react-product-card react-product-card-skit" href="/skitvoice"><span className="react-product-number">01</span><p>SkitVoice</p><h2>かんたんスキット生成</h2><span>台本と参照音声から、複数話者のセリフ音声を生成します。</span><strong>スキットをつくる →</strong></a>
      <a className="react-product-card react-product-card-speak" href="/speakloop"><span className="react-product-number">02</span><p>SpeakLoop</p><h2>言いたいことで発音練習</h2><span>母国語で話し、模範音声を聞いて、学習対象言語で復唱します。</span><strong>練習をはじめる →</strong></a>
    </nav>
  </main>;
}

mountPublicPage(<Portal />);
