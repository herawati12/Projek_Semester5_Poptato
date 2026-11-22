# Poptato — Smart Potato Grading System

**Poptato** adalah prototipe sistem klasifikasi kondisi visual dan penggolongan berat kentang. Aplikasi web menerima foto kentang dari **webcam** atau unggahan gambar, mengirimkannya ke **FastAPI**, lalu menggunakan **CNN ResNet50** untuk memprediksi kondisi **GOOD** atau **BAD**. Riwayat pemeriksaan tersimpan di **SQLite**.

> **Status proyek:** Dashboard React, API inferensi, dan penyimpanan riwayat SQLite tersedia pada implementasi ini. Grading berat pada dashboard masih menggunakan **input berat manual (simulasi)**. Integrasi fisik **ESP32, load cell + HX711, dan servo** merupakan pengembangan lanjutan; jangan menganggapnya telah terhubung dengan aplikasi web.

## Teknologi

| Bagian | Teknologi | Kegunaan |
|---|---|---|
| Frontend | React 18, Vite 6, JavaScript (JSX), CSS, Lucide React | Dashboard, akses webcam, unggah gambar, dan visualisasi |
| Backend | Python, FastAPI, Uvicorn | REST API untuk prediksi, grading, dan riwayat |
| Machine learning | TensorFlow / Keras, ResNet50 | Klasifikasi kondisi visual GOOD/BAD |
| Pengolahan gambar | Pillow, NumPy | Membaca, mengubah ukuran, dan menyiapkan input model |
| Database | SQLite (`sqlite3`) | Penyimpanan metadata dan hasil pemeriksaan |
| Komunikasi | HTTP REST, `multipart/form-data`, JSON | Komunikasi frontend dan backend |
| Hardware (rencana) | ESP32, load cell, HX711, servo | Penimbangan dan sortasi fisik |

## Struktur proyek

```text
Poptato_Fullstack_React_FastAPI_SQLite/
├── API_ResNet50_Kentang/
│   ├── main.py                 # FastAPI dan inferensi ResNet50
│   ├── requirements.txt        # Dependensi Python
│   ├── README.md
│   ├── resnet50_best.keras      # File model lokal (tidak disertakan di Git)
│   └── potato_history.db       # Database dibuat otomatis (tidak disertakan di Git)
├── dashboard-kentang-react/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── styles.css
│   │   └── ProcessingSteps.jsx # Jika memakai versi visualisasi preprocessing
│   ├── package.json
│   ├── vite.config.js
│   └── index.html
└── README.md
```

> Nama `ProcessingSteps.jsx` hanya ada pada versi dashboard yang sudah ditambah fitur visualisasi preprocessing. Jika menggunakan versi dashboard sebelumnya, file tersebut tidak diperlukan.

## Persyaratan

- **Python** yang kompatibel dengan versi TensorFlow di `requirements.txt` (disarankan Python 3.11 atau 3.12).
- **Node.js** dan npm (disarankan Node.js 20 atau lebih baru yang kompatibel dengan Vite 6).
- Berkas model ResNet50 hasil pelatihan: **`resnet50_best.keras`**.
- Browser modern (Chrome/Edge) dan webcam (opsional jika menggunakan fitur unggah gambar).

## Instalasi dan menjalankan aplikasi

Buka **dua terminal** dari folder utama proyek: satu untuk backend dan satu untuk frontend.

### 1. Jalankan backend FastAPI

**Windows PowerShell:**

```powershell
cd API_ResNet50_Kentang
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Letakkan file **`resnet50_best.keras`** di folder `API_ResNet50_Kentang/`, sejajar dengan `main.py`. Kemudian jalankan:

```powershell
uvicorn main:app --host 127.0.0.1 --port 8000
```

Alamat backend:

- Pemeriksaan status: http://127.0.0.1:8000/health
- Dokumentasi API interaktif: http://127.0.0.1:8000/docs

Respons `/health` dengan `"status": "ready"` menandakan **model telah dimuat**. Jika `"status": "model_not_loaded"`, API dapat berjalan tetapi prediksi belum bisa dilakukan. Periksa lokasi file `.keras` lalu restart backend.

### 2. Jalankan frontend React

Di terminal kedua, dari folder utama proyek:

```powershell
cd dashboard-kentang-react
npm install
npm run dev
```

Buka **http://127.0.0.1:5173** di browser.

Frontend memakai **Vite proxy**: permintaan dari `/api/*` diteruskan ke `http://127.0.0.1:8000/*`. Pastikan backend aktif di port **8000**, seperti konfigurasi `vite.config.js`.

### 3. Gunakan aplikasi

1. Pilih tab **Webcam** dan klik **Aktifkan Kamera** (izinkan akses kamera), atau pilih **Upload Gambar**.
2. Klik **Ambil Gambar** jika menggunakan webcam.
3. Klik **Analisis Kentang** untuk mengirim foto ke `/predict`.
4. Lihat klasifikasi **GOOD/BAD**, confidence, dan probabilitas masing-masing kelas.
5. Jika ingin mensimulasikan penggolongan berat, aktifkan **simulasi grading berat** lalu isi berat kentang dalam gram sebelum analisis; aplikasi akan menggunakan `/grade`.
6. Buka **Riwayat Sortasi** untuk melihat hasil yang tersimpan di SQLite dan ekspor CSV.

> Akses webcam melalui browser biasanya memerlukan `localhost`/`127.0.0.1` atau HTTPS. Jika browser meminta izin kamera, pilih **Izinkan**.

## Alur sistem

```text
Webcam / Upload Foto
        |
        v
ReactJS (Vite)
        |
        | POST /api/predict (multipart/form-data)
        v
FastAPI (Python)
        |
        | RGB -> resize 224x224 -> float32
        | -> preprocess_input ResNet50 (RGB ke BGR + mean subtraction)
        v
ResNet50 (TensorFlow/Keras)
        |
        +---- GOOD --> Dapat dilanjutkan ke grading berat
        |
        +---- BAD  --> REJECT (keputusan logis)
        |
        v
SQLite (riwayat pemeriksaan)
        |
        v
Respons JSON -> Dashboard ReactJS
```

**Penting:** Preprocessing yang digunakan untuk inferensi model adalah preprocessing khusus **ResNet50**. Visualisasi tahapan preprocessing di browser (jika dipasang) merupakan ilustrasi yang dihitung terpisah dari inferensi server.

## Logika klasifikasi dan grading

- Output sigmoid model dibaca sebagai **probabilitas BAD** (`P(BAD)`).
- Dengan threshold default **0,5**: `P(BAD) >= 0.5` → **BAD**, selain itu → **GOOD**.
- Jika **BAD**, keputusan grading adalah **REJECT**, tanpa golongan ukuran.
- Jika **GOOD** dan berat diberikan melalui `/grade`, sistem mengelompokkan berat sebagai berikut:

| Berat | Golongan |
|---|---|
| ≤ 50 gram | KECIL |
| > 50–100 gram | SEDANG |
| > 100–300 gram | BESAR |
| > 300 gram | SANGAT BESAR |

Penggolongan ini adalah logika berbasis **berat** pada prototipe, bukan sertifikasi mutu kentang berdasarkan seluruh persyaratan SNI. Untuk input pecahan gram, backend menggunakan batas kontinu seperti tabel di atas.

## Endpoint API

| Metode | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/health` | Status API, model, dan database |
| `POST` | `/predict` | Prediksi GOOD/BAD dari gambar dan simpan hasil |
| `POST` | `/grade` | Prediksi dari gambar + `berat_gram` (simulasi) |
| `GET` | `/records?limit=500&offset=0` | Ambil riwayat pemeriksaan |
| `DELETE` | `/records` | Hapus seluruh riwayat pemeriksaan |
| `GET` | `/docs` | Swagger UI untuk mencoba API |

`POST /predict` menerima `file` dan `threshold_bad` (opsional, default 0,5). `POST /grade` menerima `file`, `berat_gram`, dan `threshold_bad` (opsional). Gambar diterima sebagai **`multipart/form-data`**, dan hasil dikembalikan sebagai **JSON**.

**Contoh pengujian:**

```bash
curl -X POST "http://127.0.0.1:8000/predict" \
  -F "file=@contoh_kentang.jpg" \
  -F "threshold_bad=0.5"
```

## Database

Backend membuat file **`potato_history.db`** otomatis di folder kerja backend saat server dijalankan. Tabel `inspections` menyimpan antara lain waktu pemeriksaan, nama file, prediksi, probabilitas, confidence, threshold, berat (bila ada), keputusan sortir, golongan ukuran, dan waktu respons API. **Foto asli tidak disimpan dalam database.**

## Masalah yang sering terjadi

| Masalah | Pemeriksaan |
|---|---|
| Dashboard menampilkan `API Offline` | Pastikan FastAPI berjalan di port 8000 dan Vite proxy aktif; periksa `http://127.0.0.1:8000/health`. |
| `/health` mengembalikan `model_not_loaded` | Pastikan `resnet50_best.keras` tersedia di folder backend atau atur environment variable `MODEL_PATH`, kemudian restart server. |
| Gagal menjalankan prediksi (`HTTP 503`) | Model belum berhasil dimuat oleh FastAPI. |
| Webcam tidak terdeteksi | Periksa izin kamera browser/Windows dan pastikan menggunakan localhost atau HTTPS. |
| Data riwayat kosong | Pemeriksaan berhasil baru tersimpan setelah request prediksi sukses. Periksa jalur database yang digunakan server. |

## Catatan untuk pengembangan berikutnya

Integrasi **load cell → HX711 → ESP32 → servo** akan digunakan untuk membaca berat secara otomatis dan mengarahkan kentang ke wadah sortir. Protokol komunikasi ESP32–backend belum ditetapkan sebagai implementasi aktif dalam kode dashboard yang tersedia; perlu pengujian integrasi tersendiri.

## Keamanan dan publikasi GitHub

Jangan unggah file rahasia, database lokal, dataset mentah berukuran besar, atau file model besar tanpa mempertimbangkan lisensi dan ukuran berkas. Contoh isi **`.gitignore`** di root proyek:

```gitignore
node_modules/
dist/
__pycache__/
*.pyc
.venv/
.env
.env.*
!.env.example
*.db
*.sqlite
*.sqlite3
*.keras
*.h5
datasets/
checkpoints/
```

Jika model tidak disertakan di repository, tambahkan petunjuk bagaimana anggota tim memperoleh model tersebut. Gunakan GitHub Release atau penyimpanan berkas/model yang disepakati tim sesuai ketentuan distribusinya.

---

**Poptato — PBL Smart Potato Grading System**  
Frontend: ReactJS | Backend: FastAPI | AI: ResNet50 | Database: SQLite
