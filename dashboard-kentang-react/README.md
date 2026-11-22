# Poptato React Dashboard — SQLite Edition

Dashboard React + Vite untuk API FastAPI ResNet50. Riwayat pemeriksaan sekarang disimpan permanen oleh API ke SQLite, bukan hanya React state.

## Menjalankan

### 1. Jalankan API
Di folder `API_ResNet50_Kentang`, pastikan file model `resnet50_best.keras` tersedia, lalu:

```bash
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

API otomatis membuat `potato_history.db` saat startup.

### 2. Jalankan dashboard
Di folder `dashboard-kentang-react`:

```bash
npm install
npm run dev
```

Buka http://127.0.0.1:5173

Vite mem-proxy `/api` ke `http://127.0.0.1:8000`.
Di panel **Monitoring Kamera**, pilih webcam yang tersedia dari daftar perangkat. Browser akan meminta izin kamera; webcam hanya berfungsi pada localhost atau koneksi HTTPS.

## Penyimpanan database

Setiap prediksi sukses melalui `POST /predict` atau `POST /grade` otomatis disimpan ke tabel `inspections` pada `potato_history.db`. Dashboard memuat riwayat dari `GET /records`, sehingga data tetap ada setelah refresh atau browser ditutup.

Kolom mencakup waktu, nama file, Good/Bad, probabilitas Good/Bad, confidence, threshold, berat, keputusan sortir, golongan ukuran, dan waktu respons. Foto mentah tidak disimpan ke SQLite.

Endpoint database:
- `GET /records?limit=500&offset=0`
- `DELETE /records` (menghapus semua catatan; dashboard meminta konfirmasi)

Jangan menghapus `potato_history.db` jika riwayat masih dibutuhkan. Untuk backup, salin file tersebut saat API berhenti.
