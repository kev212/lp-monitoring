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
- Persistence SQLite (restart-safe)
- systemd service untuk Ubuntu VPS

## Cara Kerja

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
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_RPC_FALLBACK_URL=

# === Wallet ===
SOLANA_PRIVATE_KEY=

# === Jupiter Swap ===
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2

# === Telegram Notifications ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# === Bot Config ===
DEFAULT_TP_PERCENT=5
DEFAULT_SL_PERCENT=-15
POLL_INTERVAL_MS=5000
TRIGGER_CONFIRMATIONS=2
MAX_RETRIES=3
EXIT_COOLDOWN_MS=15000
MAX_SWAP_SLIPPAGE_BPS=300

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
