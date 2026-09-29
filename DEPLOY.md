# campus-info.lazyta-toru.net へのデプロイ

本番は cokoyo と同じ VPS に同居させます。`main` に push すると GitHub Actions が SSH で `deploy/update.sh` を動かし、VPS 上でビルドして入れ替えます。VPS を直接触るのは、下の「最初の1回だけ」の作業だけです。

```
GitHub (main へ push)
  └─ .github/workflows/deploy.yml
       └─ ssh deploy-campus@VPS  （鍵は update.sh しか動かせない）
            └─ /opt/campus-info/deploy/update.sh
                 ├─ Secrets から教室定員と healthchecks の URL を書く
                 ├─ git reset --hard origin/main
                 └─ docker compose up -d --build
                      ├─ dashboard（:3021、5分ごとの取得・取り直し・画面）  mem 256MB
                      └─ trainer  （毎朝4時に学習して予報）              mem 512MB
Apache (campus-info.lazyta-toru.net) → 127.0.0.1:3021
```

## 最初の1回だけ（VPS で手作業）

以下は root で行います。

### 1. デプロイ用のユーザーを作る

```sh
adduser --disabled-password --gecos "" deploy-campus
usermod -aG docker deploy-campus
mkdir -p /opt/campus-info && chown deploy-campus:deploy-campus /opt/campus-info
```

### 2. 手元でデプロイ用の鍵を作り、VPS に登録する

手元の Mac で:

```sh
ssh-keygen -t ed25519 -N "" -C "campus-info deploy" -f ~/.ssh/campus-info-deploy
cat ~/.ssh/campus-info-deploy.pub
```

VPS で、表示された公開鍵を **command= 付きで** 登録します（この鍵では update.sh 以外は何もできません）:

```sh
install -d -m 700 -o deploy-campus -g deploy-campus /home/deploy-campus/.ssh
cat >> /home/deploy-campus/.ssh/authorized_keys <<'EOF'
command="/opt/campus-info/deploy/update.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...（ここに公開鍵） campus-info deploy
EOF
chown deploy-campus:deploy-campus /home/deploy-campus/.ssh/authorized_keys
chmod 600 /home/deploy-campus/.ssh/authorized_keys
```

### 3. リポジトリを置く

```sh
sudo -u deploy-campus git clone https://github.com/Lazyturtle0852/campus-info.git /opt/campus-info
```

### 4. ポートが空いているか確かめる

```sh
ss -ltnp | grep ':3021 ' || echo "3021 は空いています"
```

使われていたら、`compose.yaml` の `APP_PORT` の既定値と `deploy/apache/campus-info.lazyta-toru.net.conf` の 3021 を別の番号にそろえて push します。

### 5. Cloudflare の DNS

`campus-info` の A レコードを `160.251.210.209` に向けます。**最初はプロキシなし（グレーの雲）** にしてください（certbot が HTTP で確認するため）。

### 6. Apache の vhost と証明書

```sh
cp /opt/campus-info/deploy/apache/campus-info.lazyta-toru.net.conf /etc/apache2/sites-available/
a2ensite campus-info.lazyta-toru.net
apache2ctl configtest && systemctl reload apache2
certbot --apache -d campus-info.lazyta-toru.net --redirect
```

証明書が取れたら、Cloudflare をオレンジの雲にしても構いません。その場合は SSL/TLS を **Full (strict)** にします。

## GitHub の設定（Lazyturtle0852/campus-info）

### Secrets（Settings → Secrets and variables → Actions）

| 名前 | 中身 |
|---|---|
| `DEPLOY_HOST` | `160.251.210.209` |
| `DEPLOY_SSH_KEY` | `~/.ssh/campus-info-deploy`（秘密鍵）の中身。`base64 -i ~/.ssh/campus-info-deploy` の1行でも可 |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 160.251.210.209` の出力 |
| `CLASSROOMS_B64` | `base64 -i private-data/kyousitu_size.json` の出力（教室定員。公開しない） |
| `HC_COLLECT_URL` | healthchecks.io の「取得」チェックの ping URL |
| `HC_TRAIN_URL` | healthchecks.io の「学習」チェックの ping URL |

### healthchecks.io のチェック

| チェック | Period | Grace | 知らせてくるもの |
|---|---|---|---|
| campus-info 取得 | 5 分 | 20 分 | 5分ごとの取得が止まった、または建物の値が1つも取れなかった（/fail） |
| campus-info 学習 | 1 日 | 2 時間 | 毎朝4時の学習が来ない、または失敗した（/fail） |

### Pages

Settings → Pages → Source を **GitHub Actions** にします（見本と説明ページが `https://lazyturtle0852.github.io/campus-info/` に出ます）。

## 初回のデプロイ

Secrets をそろえたら、Actions の **deploy** を手動で実行します（Run workflow）。最後に `/api/status` の中身とコンテナの状態が出れば成功です。

- 起動の1分後から、2026-07-15 以降の過去分の取り直しが始まります（1秒に1回、数時間）。進み具合は `/records` の「過去分の取り直し」で見られます。
- 学習は翌朝4時から。すぐに試すときは、VPS で一度だけ `docker compose -f /opt/campus-info/compose.yaml exec trainer bash run_daily.sh` を実行します。
- 翌朝 05:30 に **backup** が動き、データを `data` ブランチに保存します。

## 日々の運用

- 変更は `main` に push するだけです。
- ログ: `docker compose -f /opt/campus-info/compose.yaml logs -f dashboard`（VPS で）
- **`docker compose down -v` はデータの Volume ごと消えるので実行しないでください。** 消えても `data` ブランチから戻せます。
