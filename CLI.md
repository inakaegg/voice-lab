| 操作 | コマンド |
|---|---|
| help | `./zoovoice --help` |
| 確認用音声を作る | `say -v Kyoko -o /tmp/zv-in.aiff "昨日の夜、屋根の上で何かがずっと鳴いていました" && ffmpeg -y -v error -i /tmp/zv-in.aiff -ar 16000 -ac 1 /tmp/zv-in.wav` |
| 標準のアニマル度で合成する | `./zoovoice preview -audio /tmp/zv-in.wav -out /tmp/zv-out.wav -species cat -intensity 50` |
| 2種で合成する | `./zoovoice preview -audio /tmp/zv-in.wav -out /tmp/zv-out-2.wav -species cat,dog -intensity 50` |
| 合成音声を再生する | `afplay /tmp/zv-out.wav` |
