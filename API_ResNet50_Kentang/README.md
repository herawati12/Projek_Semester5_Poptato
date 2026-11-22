# Poptato API — ResNet50 + SQLite

SQLite dibuat otomatis pada startup (`potato_history.db`). Prediksi sukses dari `POST /predict` dan `POST /grade` otomatis tersimpan.

Jalankan:
```bash
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Endpoints:
- `GET /health` status model dan database
- `POST /predict` klasifikasi gambar dan simpan riwayat
- `POST /grade` klasifikasi gambar + berat dan simpan riwayat
- `GET /records?limit=500&offset=0` daftar riwayat
- `DELETE /records` hapus seluruh riwayat

File database `potato_history.db` dibuat di folder kerja API. Gambar mentah tidak disimpan; database menyimpan metadata dan hasil pemeriksaan.
