# Raspberry Pi / Ubuntu Server での起動

> 本番（campus-info.lazyta-toru.net）は VPS で動かしています。手順は `DEPLOY.md` を見てください。ここは手元や Pi で1台だけ動かすときのメモです（`compose.yaml` は本番用に `trainer` と `APP_PORT`=3010 を含みます）。

`faapp_2.js` を単一のDockerコンテナとして動かします。ホストにNode.jsは不要ですが、Docker EngineとDocker Composeプラグインが必要です。

## ローカルデータの準備

この公開用構成には、実際の時刻表、教室情報、観測CSVを含めません。利用権限を確認したデータをPi上の `private-data/` に置きます。このフォルダはGit管理とDockerイメージの対象外です。

```sh
mkdir -p private-data
cp /path/to/your/kyousitu_size.json private-data/
cp /path/to/your/kanachu_jikoku_from_shonandai.json private-data/
```

形だけ試す場合は、`example-data/` にある架空のサンプルをコピーできます。ただし、バス情報は空です。

```sh
cp example-data/*.json private-data/
```

Composeはこれらをコンテナの `/app/private-data` に読み取り専用でマウントします。観測CSVは別の永続Volume `crowd_data` に保存されます。

## Dockerアプリを起動

プロジェクトのディレクトリで実行します。

```sh
docker compose up -d --build
docker compose logs -f dashboard
```

Pi自身で `curl -fsS http://127.0.0.1:3000/ >/dev/null` を実行して確認します。ポート3000はPiのlocalhostだけに公開され、LANの別端末から直接は接続できません。

`docker compose down` で停止します。**`docker compose down -v` はCSVを含むVolumeを削除するため実行しないでください。**

## Tailscaleで外出先から閲覧

TailscaleはDocker内ではなくPiのUbuntu Serverにインストールします。

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

`tailscale up` に表示されるURLからPiをtailnetに登録します。アクセスする端末にもTailscaleを入れ、同じtailnetへサインインしてください。Dockerアプリが起動していることを確かめたらServeを設定します。

```sh
sudo tailscale serve --bg 3000
tailscale serve status
```

初回はHTTPS証明書の有効化を求められる場合があります。表示されるURLはtailnet内向けです。Serveを止めるときは `sudo tailscale serve off` を使います。

## CSVとバックアップ

サーバーは起動時に観測CSVを読み込み、外部の混雑APIから5分間隔で収集します。CSVは `/app/data/crowd_snapshots.csv` と `/app/data/building_statistics.csv` です。

```sh
docker compose exec dashboard ls -lh /app/data
docker compose exec -T dashboard tar -C /app/data -czf - . > crowd-data-backup.tar.gz
```

既存の観測CSVを引き継ぐ場合は、初回起動前に `crowd_data` Volumeへ移してください。Gitリポジトリや公開Dockerイメージに実データを含めないでください。定期収集が各プロセスで動くため、コンテナは1つだけ起動します。
