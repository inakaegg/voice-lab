"""Voice Labの構成図を生成する（mingrammer/diagrams、公式アイコン、単体で表示できるSVG）。

再生成:
    uv run --no-project --with diagrams python docs/diagrams/architecture.py
    （または pip install -e ".[docs]" の後に python docs/diagrams/architecture.py）

出力は次の2枚で、ノードと矢印の構造は共通、文言だけを差し替える。

    docs/diagrams/architecture.svg     README.md（英語）が参照する
    docs/diagrams/architecture.ja.svg  README.ja.md（日本語）が参照する

SVGを手で編集せず、このスクリプトを直して再生成する。

ノードはdiagrams既定の固定サイズの箱を使わず、GraphvizのHTMLラベルへ<IMG>を埋め込む。
アイコン（ICON_PX）と文字（TITLE_PT / SUB_PT）を別々に決められるため、文字を大きくしても
隣のノードと重ならない。
"""

import base64
import html
import re
import sys
from pathlib import Path

try:
    import diagrams
    from diagrams import Cluster, Diagram, Edge
    from diagrams.gcp.compute import Run
    from diagrams.generic.blank import Blank
    from diagrams.generic.compute import Rack
    from diagrams.generic.database import SQL
    from diagrams.generic.storage import Storage
    from diagrams.onprem.client import Users
    from diagrams.saas.cdn import Cloudflare
except ModuleNotFoundError as exc:  # pragma: no cover - 導入手順の案内だけを行う
    sys.exit(
        f"{exc.name} が見つかりません。図の生成には diagrams と Graphviz が要ります。\n"
        '  pip install -e ".[docs]"   # または uv run --no-project --with diagrams python <このファイル>\n'
        "  brew install graphviz      # macOS以外は各パッケージ管理で dot を入れる"
    )

HERE = Path(__file__).resolve().parent  # 出力先をスクリプトの場所に固定する
ICON_BASE = Path(diagrams.__file__).resolve().parent.parent  # diagrams同梱アイコンの場所

FONT = "Hiragino Sans"  # 生成時のフォント（Graphvizが文字幅を測るのに使う）
# SVGの文字は閲覧側のフォントで描かれるので、複数OSで日本語が出る候補を並べる
FONT_STACK = "Hiragino Sans, Noto Sans JP, Yu Gothic UI, Meiryo, sans-serif"
ICON_PX = 72
TITLE_PT = 16
SUB_PT = 13
SUB_COLOR = "#5E6B64"

SPEAKLOOP = "#1F7A6E"  # SpeakLoopだけが通る経路
ZOOVOICE = "#B4622A"  # Zoovoiceだけが通る経路
SHARED = "#4A5550"  # 両方が使う経路

# GitHubのdarkテーマでも黒文字が読めるよう、背景を白で塗る（透過にしない）
GRAPH = {
    "fontname": FONT,
    "fontsize": "15",
    "bgcolor": "white",
    "pad": "0.4",
    "nodesep": "0.45",
    "ranksep": "0.9",
    "splines": "spline",
}
NODE = {"fontname": FONT}
EDGE = {"fontname": FONT, "fontsize": "13"}
NEUTRAL_CLUSTER_FONT = "#1C2420"  # 通常clusterの見出し文字色。boundary/privateの色を子clusterへ継承させない
CLUSTER = {
    "fontname": FONT,
    "fontsize": "15",
    "bgcolor": "#F7F9F8",
    "pencolor": "#C7D0CC",
    "fontcolor": NEUTRAL_CLUSTER_FONT,
}
BOUNDARY_CLUSTER = {**CLUSTER, "pencolor": SPEAKLOOP, "fontcolor": SPEAKLOOP, "penwidth": "2"}
PRIVATE_CLUSTER = {**CLUSTER, "style": "dashed", "pencolor": "#8E9A94", "fontcolor": "#5E6B64"}

# 製品名・サービス名は両言語で原文のまま使い、説明文だけを差し替える。
TEXT = {
    "en": {
        "title": "Voice Lab architecture   green = SpeakLoop   orange = Zoovoice   grey = shared",
        "browser": ("Browser", "/  ·  /speakloop  ·  /zoovoice"),
        "boundary": "Cloudflare  (no API key reaches the browser; keys live in Worker and Cloud Run secrets)",
        "worker": ("Cloudflare Worker", "Static Assets serve the UI", "Google login / quota / API relay"),
        "turnstile": ("Turnstile", "blocks automated Zoovoice access"),
        "google": ("Google", "OAuth sign-in (accounts.google.com)"),
        "google_token": ("Google token endpoint", "oauth2.googleapis.com/token", "ID-token cache miss only"),
        "storage": "Storage",
        "kv": ("Workers KV", "settings / short-lived jobs"),
        "d1": ("D1", "quota / audit / counters", "public-sample metadata"),
        "r2": ("R2", "admin-managed sample blobs (SpeakLoop, VC)"),
        "external": "External API",
        "openai": (
            "OpenAI API",
            "native/English ASR, translation, TTS",
            "comparison / scoring",
            "animal association",
        ),
        "runpod_cluster": "private RunPod Serverless",
        "runpod": ("GPU handler", "Chinese ASR (FunASR)", "voice conversion (Seed-VC)"),
        "cloudrun_cluster": "private Google Cloud Run",
        "cloudrun": ("Zoovoice Go service", "no unauthenticated access", "Japanese ASR → association → word splice"),
        "e_https": "HTTPS",
        "e_verify": "verify token",
        "e_widget": "widget script + challenge",
        "e_oauth": "OAuth sign-in",
        "e_openai": "ASR / translation / TTS / scoring",
        "e_runpod": "async job → polling",
        "e_idtoken": "call with ID token",
        "e_gtoken": "signed JWT ↔ ID token",
        "e_assoc": "pick requested animals",
    },
    "ja": {
        "title": "Voice Lab 構成図　　緑=SpeakLoopの経路　橙=Zoovoiceの経路　灰=共通",
        "browser": ("ブラウザ", "/  ・  /speakloop  ・  /zoovoice"),
        "boundary": "Cloudflare（APIキーはブラウザへ渡さず、Worker secretとCloud Run secretで管理）",
        "worker": ("Cloudflare Worker", "Static Assets で画面配信", "Googleログイン・quota・API中継"),
        "turnstile": ("Turnstile", "Zoovoiceの自動アクセス抑止"),
        "google": ("Google", "OAuthログイン（accounts.google.com）"),
        "google_token": ("Google token endpoint", "oauth2.googleapis.com/token", "ID tokenのcache miss時だけ利用"),
        "storage": "保存層",
        "kv": ("Workers KV", "設定・短期job"),
        "d1": ("D1", "quota・監査・counter", "公開sample metadata"),
        "r2": ("R2", "管理者管理のsample音声blob（SpeakLoop・VC）"),
        "external": "外部API",
        "openai": (
            "OpenAI API",
            "母語/英語ASR・翻訳・TTS",
            "比較・採点",
            "動物の連想",
        ),
        "runpod_cluster": "private RunPod Serverless",
        "runpod": ("GPU handler", "中国語ASR（FunASR）", "声質変換（Seed-VC）"),
        "cloudrun_cluster": "private Google Cloud Run",
        "cloudrun": ("Zoovoice Goサービス", "未認証アクセス不可", "日本語ASR → 連想 → 単語境界splice"),
        "e_https": "HTTPS",
        "e_verify": "token検証",
        "e_widget": "widgetスクリプト・challenge",
        "e_oauth": "OAuthログイン",
        "e_openai": "ASR・翻訳・TTS・採点",
        "e_runpod": "非同期job → polling",
        "e_idtoken": "ID token付きrequest",
        "e_gtoken": "署名付きJWT ↔ ID token",
        "e_assoc": "動物を指定数選ぶ",
    },
}


def unbranded(cls, title, *sub, color="#1C2420", sub_color=SUB_COLOR):
    """公式アイコンが同梱されていない対象向けの、枠線だけのノード（diagramsのblank iconは透明で枠が見えないため）。"""
    rows = [
        f'<TR><TD><FONT POINT-SIZE="{TITLE_PT}" COLOR="{color}">{html.escape(title)}</FONT></TD></TR>',
    ]
    rows += [
        f'<TR><TD><FONT POINT-SIZE="{SUB_PT}" COLOR="{sub_color}">{html.escape(s)}</FONT></TD></TR>'
        for s in sub
    ]
    label = (
        '<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="8" COLOR="#8E9A94">'
        + "".join(rows)
        + "</TABLE>>"
    )
    return cls(label, image="", fixedsize="false", width="0", height="0", margin="0")


def svc(cls, title, *sub, color="#1C2420", sub_color=SUB_COLOR):
    """アイコン + タイトル + 補足行のノード。幅は文字に合わせて自動で決まる。"""
    icon = ICON_BASE / cls._icon_dir / cls._icon
    rows = [
        f'<TR><TD FIXEDSIZE="TRUE" WIDTH="{ICON_PX}" HEIGHT="{ICON_PX}">'
        f'<IMG SCALE="TRUE" SRC="{icon}"/></TD></TR>',
        f'<TR><TD><FONT POINT-SIZE="{TITLE_PT}" COLOR="{color}">{html.escape(title)}</FONT></TD></TR>',
    ]
    rows += [
        f'<TR><TD><FONT POINT-SIZE="{SUB_PT}" COLOR="{sub_color}">{html.escape(s)}</FONT></TD></TR>'
        for s in sub
    ]
    label = (
        '<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="1">'
        + "".join(rows)
        + "</TABLE>>"
    )
    return cls(label, image="", fixedsize="false", width="0", height="0", margin="0")


def flow(color, label):
    """機能ごとに色分けした矢印。色の意味は図のタイトルの凡例と対応する。"""
    return Edge(label=label, color=color, fontcolor=color, penwidth="2")


def finalize_svg(path: Path) -> None:
    """GraphvizのSVGはアイコンをローカルパスで参照するので、base64で埋めて単体表示できる形にする。"""
    svg = path.read_text()

    def embed(m):
        data = base64.b64encode(Path(m.group(1)).read_bytes()).decode()
        return f'xlink:href="data:image/png;base64,{data}"'

    svg = re.sub(r'xlink:href="(/[^"]+\.png)"', embed, svg)
    svg = svg.replace(f'font-family="{FONT}"', f'font-family="{FONT_STACK}"')
    svg = svg.replace('font-family="Sans-Serif"', f'font-family="{FONT_STACK}"')
    path.write_text(svg)


def build(lang: str) -> Path:
    """1つの言語ぶんのSVGを書き出す。構造は言語によらず同じにする。"""
    t = TEXT[lang]
    stem = "architecture" if lang == "en" else f"architecture.{lang}"

    with Diagram(
        t["title"],
        filename=str(HERE / stem),
        outformat="svg",
        show=False,
        direction="TB",
        graph_attr=GRAPH,
        node_attr=NODE,
        edge_attr=EDGE,
    ):
        browser = svc(Users, *t["browser"])
        # diagramsに公式Googleアイコンが同梱されていないため、枠線だけの汎用ノードで代用する。
        google = unbranded(Blank, *t["google"])
        # ブラウザ用のGoogle OAuthノードとは別に、Workerがサーバー側でCloud Run用ID tokenを
        # 取得するGoogle token endpointを分けて表す（productionCloudRunIdToken）。
        google_token = unbranded(Blank, *t["google_token"])

        with Cluster(t["boundary"], graph_attr=BOUNDARY_CLUSTER):
            turnstile = svc(Cloudflare, *t["turnstile"])
            worker = svc(Cloudflare, *t["worker"])

            with Cluster(t["storage"], graph_attr=CLUSTER):
                kv = svc(Storage, *t["kv"])
                d1 = svc(SQL, *t["d1"])
                r2 = svc(Storage, *t["r2"])

        with Cluster(t["external"], graph_attr=CLUSTER):
            openai = svc(Rack, *t["openai"])

        with Cluster(t["runpod_cluster"], graph_attr=PRIVATE_CLUSTER):
            runpod = svc(Rack, *t["runpod"])

        with Cluster(t["cloudrun_cluster"], graph_attr=PRIVATE_CLUSTER):
            cloudrun = svc(Run, *t["cloudrun"])

        browser >> Edge(label=t["e_https"], color=SHARED, fontcolor=SHARED, penwidth="2") >> worker
        # Turnstile widgetの読込・challengeはブラウザがCloudflareのchallenge serverと直接通信し、Workerを経由しない。
        browser >> flow(ZOOVOICE, t["e_widget"]) >> turnstile
        # Googleログインはredirectで、ブラウザがaccounts.google.comへ直接遷移して戻る。
        browser >> Edge(label=t["e_oauth"], color=SPEAKLOOP, fontcolor=SPEAKLOOP, penwidth="2", dir="both") >> google

        worker >> flow(ZOOVOICE, t["e_verify"]) >> turnstile
        worker >> Edge(color=SPEAKLOOP) >> kv
        worker >> Edge(color=SHARED) >> d1
        worker >> flow(SPEAKLOOP, "") >> r2

        worker >> flow(SPEAKLOOP, t["e_openai"]) >> openai
        worker >> flow(SPEAKLOOP, t["e_runpod"]) >> runpod
        # Cloud Runはprivateなので、Workerはcache missの際に署名付きservice account JWTを
        # Google token endpointへ送ってID tokenを受け取ってから中継する（productionCloudRunIdToken）。
        worker >> Edge(
            label=t["e_gtoken"],
            color=ZOOVOICE,
            fontcolor=ZOOVOICE,
            penwidth="2",
            dir="both",
        ) >> google_token
        worker >> flow(ZOOVOICE, t["e_idtoken"]) >> cloudrun
        # 動物連想のAPIキーはCloud Runのsecretで、Workerを経由しない（services/zoovoice/association.go）
        cloudrun >> flow(ZOOVOICE, t["e_assoc"]) >> openai

    out = HERE / f"{stem}.svg"
    finalize_svg(out)
    return out


for language in TEXT:
    print(f"wrote {build(language)}")
