# LP Monitoring

Bot untuk monitor posisi **Meteora DLMM** secara live, menghitung **historical cost basis**, mengevaluasi **PnL %**, dan **auto-close** saat TP/SL — dengan hasil swap kembali ke **SOL**.

## Fitur

- Monitor semua posisi DLMM di wallet secara real-time
- Reconstruct historical cost basis dari histori transaksi (add/remove liquidity)
- Estimasi nilai exit dalam SOL (termasuk fee/reward)
- Auto-close saat Take Profit (default +5%) atau Stop Loss (default -15%)
- Remove liquidity penuh + claim + close posisi
- Swap hasil posisi ke SOL via Jupiter
- Notifikasi Telegram
- `/scan_pools_ray`: top 10 Raydium CLMM berdasarkan estimasi yield fee LP/jam, TVL minimal US$5.000 dan volume aktual 1h minimal US$20.000
- Persistence SQLite (restart-safe)
- systemd service untuk Ubuntu VPS

## Cara Kerja

### Scanner Raydium

`/scan_pools_ray` menelusuri seluruh kandidat CLMM dengan TVL ≥ US$5.000 dari Raydium dan mengambil volume 1 jam terakhir dari DEX Screener. Pool dengan volume < US$20.000/jam, dynamic fee, atau data wajib tidak valid dikecualikan. Hasil diurutkan berdasarkan estimasi fee LP selama satu jam dibagi TVL; fee dihitung dari volume aktual 1h × tarif fee konfigurasi pool × porsi LP setelah potongan protocol/fund. Volume harian tidak dibagi 24. Angka ini adalah estimasi tingkat pool, bukan hasil posisi dengan range tertentu.

Scan bersifat baca-saja, tidak memerlukan API key tambahan, dan memakai otorisasi Telegram yang sama dengan command lain. Scan luas dapat berlangsung beberapa menit dengan progres setiap menit. Hasil mencantumkan sumber, rentang waktu pengambilan, pengecualian, dan status parsial jika ada kegagalan. Request bersamaan berbagi satu scan dan hasil di-cache 60 detik.

### Monitoring posisi

1. Load wallet + koneksi RPC
2. Scan semua posisi DLMM milik wallet
3. Fetch histori transaksi untuk tiap posisi
4. Parse event: `ADD_LIQUIDITY`, `REMOVE_LIQUIDITY`, `CLAIM_FEE`, `CLAIM_REWARD`, dll.
5. Hitung historical cost basis dalam SOL
6. Pantau estimasi nilai exit terkini
7. Hitung PnL %
8. Jika TP/SL terpenuhi 2 siklus berturut-turut:
   - Remove liquidity (100%)
   - Claim & close position
   - Swap semua token non-SOL ke SOL via Jupiter
   - Kirim notifikasi Telegram

## Struktur Project

```
src/
  index.ts          Entry point
  config.ts         Config loader (.env)
  core.ts           Main loop + orchestrator
  pricing.ts        Harga token via Jupiter quote
  swap.ts           Swap token ke SOL via Jupiter
  telegram.ts       Notifikasi Telegram
  types.ts          Tipe data
  db/
    client.ts       SQLite connection
    schema.ts       Schema: positions, events, executions
  solana/
    connection.ts   RPC connection + fallback
    wallet.ts       Load private key (base58/JSON)
  meteora/
    discovery.ts    Cari & simpan posisi DLMM
    positions.ts    Pool & position detail via SDK
    valuation.ts    Estimasi exit value dalam SOL
    exit.ts         Remove liq + swap to SOL
  history/
    parser.ts       Parse transaksi untuk event
    ledger.ts       Reconstruct cost basis
  risk/
    rules.ts        TP/SL rule engine
```

## Instalasi

```bash
git clone https://github.com/kev212/lp-monitoring.git
cd lp-monitoring
npm install
cp .env.example .env
```

## Konfigurasi

Edit `.env`:

```env
# === Solana RPC ===
# Primary RPC endpoint used for normal reads and transactions.
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# Optional WebSocket endpoint for fast confirmation notifications.
SOLANA_WS_URL=
# Optional HTTPS endpoint used when the primary RPC is unavailable.
SOLANA_RPC_FALLBACK_URL=
# Last-resort public Solana RPC. Use only when the configured providers fail.
SOLANA_RPC_SECONDARY_FALLBACK_URL=https://api.mainnet-beta.solana.com

# === Wallet ===
SOLANA_PRIVATE_KEY=

# === Jupiter Swap ===
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2

# === Telegram Notifications ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_USER_ID=
# Keep false until dashboard previews and limits have been verified.
TELEGRAM_MANUAL_TRADING_ENABLED=false
TELEGRAM_CONFIRM_TTL_MS=120000

# === Bot Config ===
DEFAULT_TP_PERCENT=10
DEFAULT_SL_PERCENT=-17
POLL_INTERVAL_MS=2500
TRIGGER_CONFIRMATIONS=2
MAX_RETRIES=3
EXIT_COOLDOWN_MS=15000
MAX_SWAP_SLIPPAGE_BPS=300
REMOVE_CONFIRM_TIMEOUT_MS=10000
SWAP_CONFIRM_TIMEOUT_MS=5000
EXIT_RECOVERY_POLL_MS=2000
EXIT_FINALITY_REVIEW_TIMEOUT_MS=60000
RECHECK_DELAY_MS=3000
TRAILING_ACTIVATION_PCT=3
TRAILING_STOP_DROP_PCT=1

# === LP Agent (optional diagnostic source) ===
LP_AGENT_API_KEY=

# === Bin Range Risk ===
BIN_RANGE_CLOSE_ENABLED=true
BIN_RANGE_PNL_THRESHOLD=1.5
BIN_RANGE_MAX_DISTANCE=7
BIN_RANGE_DISTANCE_RATIO=0.05

# === Drawdown Protection ===
MAX_DRAWDOWN_THRESHOLD=-6
# Default DD lock TP; can be changed later via Telegram /risk.
MAX_DRAWDOWN_TP_OVERRIDE=3

# === Flip Mode ===
FLIP_MODE_INITIAL_TRIGGER_PCT=40
FLIP_MODE_REPEAT_STEP_PCT=10

# === Auto Rebalance ===
REBALANCE_OOR_MINUTES=5

# === Telegram Open Position ===
OPEN_MAX_PRICE_MOVE_BINS=3
OPEN_SOL_FEE_RESERVE=0.02

# === Database ===
DB_PATH=./monitoring-lp.sqlite

# === Logging ===
LOG_LEVEL=info
```

### Private Key

Format `SOLANA_PRIVATE_KEY`:
- **base58**: `3ABC...xyz`
- **JSON array**: `[12,34,56,...]`

### Telegram (Opsional)

Kalau `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` tidak diisi, bot tetap jalan tanpa notif.

## Menjalankan Bot

```bash
npm start
```

### Development (auto-reload)

```bash
npm run dev
```

### Build Check

```bash
npm run check
npm run build
```

## Deploy ke Ubuntu VPS

### Manual

```bash
git clone https://github.com/kev212/lp-monitoring.git
cd lp-monitoring
npm install
cp .env.example .env
nano .env
npm start
```

### systemd (auto-restart)

```bash
sudo cp monitoring-lp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable monitoring-lp
sudo systemctl start monitoring-lp

# Lihat log
sudo journalctl -u monitoring-lp -f
```

## Database

SQLite (`monitoring-lp.sqlite`) menyimpan:

| Tabel | Isi |
|---|---|
| `positions` | Semua posisi yang ditemukan, basis cost, status |
| `position_events` | Riwayat transaksi per posisi |
| `executions` | Log eksekusi close (trigger type, tx signature) |
| `sync_state` | Checkpoint sinkronisasi history |

## Notifikasi Telegram

Bot mengirim alert saat:
- Bot mulai
- Posisi baru ditemukan
- TP/SL ter-trigger
- Exit sukses
- Exit gagal

## Build

```bash
npm run build
```

Compiled output ada di `dist/`.

## Log Output

Contoh log saat runtime:

```
[wallet] loaded 7XYZ...
[discovery] found 3 total DLMM pairs on chain
[discovery] registered position abc... basis=2.4500: confidence=high
[monitor] position abc... pnl=+6.28% exit=2.604 SOL
[exit] executing TP for abc...
[exit] remove liq tx: 5nJ...
[exit] swap tx: 4mK...
[exit] completed, received 2.590 SOL
```

## Catatan Penting

- Bot melakukan **live execution**. Gunakan wallet khusus, bukan wallet utama.
- Historical basis menggunakan **best-effort reconstruction** dari histori transaksi.
- Confidence basis:
  - `high` — event terklasifikasi jelas, token flow terdeteksi
  - `medium` — sebagian event terklasifikasi
  - `low` — banyak event ambigu, tetap bisa execute
- Discovery awal membutuhkan waktu karena scan semua DLMM pairs.
- Pastikan wallet memiliki SOL untuk fee transaksi.

## Disclaimer

Bot ini mengeksekusi transaksi on-chain secara otomatis. Gunakan dengan risiko sendiri. Uji dengan jumlah kecil terlebih dahulu sebelum digunakan pada dana utama.

### Risk per posisi

Di Telegram, buka `/dashboard` → **Position Risk**, pilih pasangan/alamat posisi,
lalu gunakan tombol **Trailing → OFF/ON** dan **Bin Trigger → OFF/ON**.
OFF hanya berlaku pada posisi terpilih dan tersimpan setelah restart. ON mengikuti
pengaturan global serta aturan mode; BIN_RANGE tetap tidak berlaku untuk Auto
Rebalance dan posisi runner. TP/SL dan drawdown lock tetap aktif sesuai kebijakan.
Trailing yang dinyalakan kembali mulai dari valuasi valid berikutnya, tanpa peak
lama. Posisi baru mengikuti global, termasuk posisi pengganti hasil reopen.

### Auto Rebalance arah

Menu Telegram **Auto Rebalance** menyediakan mode **Up**, **Down**, dan **Both**.
Mode Up menunggu posisi keluar dari batas atas, sedangkan Down menunggu posisi
keluar dari batas bawah; Both mengaktifkan keduanya. Pilihan mode dan timer OOR
tersimpan per posisi. Mengubah mode menghapus timer lama agar pengukuran dimulai
kembali dari arah yang dipilih.

Kedua arah memakai `REBALANCE_OOR_MINUTES` (default 5 menit). Timer diulang
ketika posisi kembali in-range atau berpindah sisi OOR. Posisi lama tetap Up.
Durasi OOR dapat diubah dari menu Telegram **Auto Rebalance** melalui tombol
**Waktu Rebalance** dengan angka bulat 1–1440 menit. Nilai ini berlaku untuk
semua posisi dan semua arah (Up/Down/Both), tersimpan setelah restart, dan
menggantikan nilai awal `REBALANCE_OOR_MINUTES`. Mengubah durasi mereset timer
OOR yang masih menunggu; proses close/reopen yang sudah berjalan tetap
dilanjutkan dengan durasi terbaru untuk siklus berikutnya.

Down menutup tanpa swap, lalu mendepositkan token hasil close terkonfirmasi
(termasuk fee dalam token tersebut) dengan lebar bin yang sama dan lower bin
sama dengan current bin terbaru. Contoh: 3 bin dan current bin 90 menghasilkan
range 90–92. Saldo token lain di wallet tidak ikut didepositkan; hasil quote
tetap di wallet. Basis posisi baru memakai nilai token dalam quote saat reopen.

Saat Auto Rebalance membuka kembali posisi pengganti, flag risk per posisi
(**Trailing ON/OFF** dan **Bin Trigger ON/OFF**) diwariskan bersama mode rebalance
sejak posisi baru dicatat, termasuk saat recovery setelah restart. Peak PnL dan
aktivasi trailing dimulai ulang. Setting ON tetap mengikuti konfigurasi global;
Bin Trigger tetap tersimpan ON walaupun eksekusinya ditekan oleh Auto Rebalance.
Perubahan mode tidak dapat dilakukan ketika rebalance sedang berjalan atau posisi
sedang exit. Mode Down saat ini hanya dapat menggunakan posisi dengan quote side
Y (token side X); posisi dengan quote side X belum mendukung deposit token untuk
reopen Down.

### Raydium CLMM auto rebalance

Bot juga memonitor posisi **Raydium CLMM** milik wallet yang sama (posisi dibuat
manual di UI Raydium; bot tidak membuka posisi pertama). Semua posisi otomatis
muncul di `/dashboard` (read-only: pair, status in-range/OOR, ticks, current
tick, cooldown) walau auto rebalance sedang OFF.

Saat posisi OOR melewati window, bot menggantinya dengan posisi **double-sided
in-range**: range `[floor(currentTick/tickSpacing)*tickSpacing, +1 tickSpacing)`
sehingga current tick selalu di dalam range (1 tick wide). Karena hasil close
selalu single-sided, bot menyelesaikan kekurangan sisi lain dengan **swap**:

- Swap memakai **Raydium CLMM direct** di pool yang sama (satu hop, tanpa API
  eksternal), dengan solver rasio: ukuran swap dipilih agar saldo pasca-swap
  cocok dengan komposisi range, lalu range di-anchor ke tick pasca-swap.
- **Swap + open digabung dalam satu transaksi (atomic)** bila ukurannya ≤1232 B.
  Jika tidak muat, fallback otomatis: swap tx dulu, lalu open tx — keduanya
  durable (signed tx disimpan sebelum broadcast) dan bisa dilanjutkan setelah
  restart.
- **Sanity check Jupiter** (read-only): jika harga eksekusi Raydium direct >1%
  lebih buruk dari quote Jupiter, rebalance dibatalkan + notifikasi (dana aman di
  wallet).
- Buffer likuiditas 98% dan `amountMax` ber-slippage agar open tidak gagal saat
  harga bergerak; sisa kecil tetap di wallet.
- Cooldown per posisi (`RAYDIUM_REBALANCE_COOLDOWN_MS`) untuk meredam churn.
- Arah up/down hanya menentukan pemicu; range target sama untuk keduanya.

Env:

| Env | Default | Fungsi |
|---|---|---|
| `RAYDIUM_ENABLED` | `false` | Kill switch monitor + rebalance |
| `RAYDIUM_REBALANCE_MODE` | `both` | Arah trigger: `up`, `down`, `both` |
| `RAYDIUM_REBALANCE_WINDOW_MINUTES` | `5` | Window OOR khusus Raydium |
| `RAYDIUM_SLIPPAGE_BPS` | `100` | Toleransi `amountMin` saat close |
| `RAYDIUM_SWAP_SLIPPAGE_BPS` | `50` | Slippage maks swap (0.5%) |
| `RAYDIUM_SWAP_MAX_IMPACT_PCT` | `1` | Batas direct lebih buruk dari Jupiter (%) |
| `RAYDIUM_LIQUIDITY_BUFFER_PCT` | `98` | Buffer likuiditas saat open |
| `RAYDIUM_REBALANCE_COOLDOWN_MS` | `600000` | Cooldown per posisi setelah rebalance |
| `RAYDIUM_POLL_MS` | `15000` | Interval polling posisi/pool |
| `RAYDIUM_COMPUTE_UNIT_PRICE` | `100000` | Priority fee (microLamports/CU) |
| `RAYDIUM_CLOSE_COMPUTE_UNIT_LIMIT` | `80000` | CU limit tx close |
| `RAYDIUM_ATOMIC_COMPUTE_UNIT_LIMIT` | `400000` | CU limit tx swap+open |

Window OOR Raydium memakai `RAYDIUM_REBALANCE_WINDOW_MINUTES` (default **5
menit**), terpisah dari setting global Telegram yang dipakai Meteora. Jika close
berhasil tetapi saldo hasil belum terlihat, bot menyimpan baseline saldo sebelum
close dan mengukur ulang sampai 5 menit sebelum menyerah.
