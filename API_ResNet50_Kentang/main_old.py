"""FastAPI for potato tuber visual quality + SQLite inspection history.

ResNet50 preprocessing matches the training notebook:
RGB [0,255] -> BGR and ImageNet mean subtraction via preprocess_input.
Sigmoid output: 1 = BAD.
"""
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import time

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Query
from pydantic import BaseModel, Field

MODEL_PATH = Path(os.getenv("MODEL_PATH", "resnet50_best.keras"))
DB_PATH = Path(os.getenv("DB_PATH", "potato_history.db"))
MAX_FILE_BYTES = 10 * 1024 * 1024
IMAGE_SIZE = (224, 224)
model = None


@contextmanager
def get_connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with get_connection() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS inspections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            filename TEXT NOT NULL,
            kondisi_visual TEXT NOT NULL CHECK(kondisi_visual IN ('GOOD','BAD')),
            probabilitas_good REAL NOT NULL,
            probabilitas_bad REAL NOT NULL,
            confidence REAL NOT NULL,
            threshold_bad REAL NOT NULL,
            berat_gram REAL,
            keputusan_sortir TEXT,
            golongan_ukuran TEXT,
            response_ms INTEGER
        )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_inspections_created_at ON inspections(created_at DESC)")
        conn.commit()


def save_inspection(filename: str, result: dict, response_ms: int):
    created_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    with get_connection() as conn:
        cur = conn.execute("""
            INSERT INTO inspections (
                created_at, filename, kondisi_visual, probabilitas_good,
                probabilitas_bad, confidence, threshold_bad, berat_gram,
                keputusan_sortir, golongan_ukuran, response_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            created_at, filename, result["kondisi_visual"],
            result["probabilitas_good"], result["probabilitas_bad"],
            result["confidence"], result["threshold_bad"],
            result.get("berat_gram"), result.get("keputusan_sortir"),
            result.get("golongan_ukuran"), response_ms
        ))
        conn.commit()
        return cur.lastrowid, created_at


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    init_db()
    if MODEL_PATH.exists():
        import tensorflow as tf
        model = tf.keras.models.load_model(str(MODEL_PATH), compile=False)
        if model.output_shape[-1] != 1:
            raise RuntimeError(f"Output model tidak sesuai sigmoid biner: {model.output_shape}")
        print(f"Model ResNet50 dimuat dari {MODEL_PATH}")
    else:
        print(f"PERINGATAN: model belum ada di {MODEL_PATH}; /predict dan /grade akan mengembalikan HTTP 503")
    print(f"SQLite history: {DB_PATH.resolve()}")
    yield
    model = None


app = FastAPI(
    title="API Klasifikasi Kentang — ResNet50 + SQLite",
    description="Good/Bad dari citra, penggolongan ukuran berdasarkan berat, dan riwayat pemeriksaan permanen di SQLite. Bukan sertifikasi mutu SNI.",
    version="1.1.0", lifespan=lifespan,
)


class PredictionResponse(BaseModel):
    kondisi_visual: str
    probabilitas_good: float = Field(ge=0, le=1)
    probabilitas_bad: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    threshold_bad: float
    model: str = "ResNet50"
    record_id: int | None = None
    created_at: str | None = None
    response_ms: int | None = None


class GradingResponse(PredictionResponse):
    berat_gram: float
    keputusan_sortir: str
    golongan_ukuran: str | None
    keterangan: str


def ensure_model():
    if model is None:
        raise HTTPException(503, detail="Model belum dimuat. Letakkan resnet50_best.keras sesuai MODEL_PATH dan restart server.")


async def read_photo(file: UploadFile) -> np.ndarray:
    if file.content_type and file.content_type not in ("image/jpeg", "image/png", "image/webp", "image/bmp"):
        raise HTTPException(415, detail="Gunakan JPG, PNG, WEBP, atau BMP.")
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, detail="File gambar maksimal 10 MB.")
    if not data:
        raise HTTPException(400, detail="File gambar kosong.")
    try:
        with Image.open(BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            im.load()
            rgb = im.convert("RGB").resize(IMAGE_SIZE, Image.Resampling.BILINEAR)
            arr = np.asarray(rgb, dtype=np.float32)[None, ...]
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(400, detail="Gambar tidak valid atau tidak dapat dibaca.") from exc
    from tensorflow.keras.applications.resnet50 import preprocess_input
    return preprocess_input(arr.copy())


async def classify(file: UploadFile, threshold_bad: float) -> dict:
    ensure_model()
    if not (0 < threshold_bad < 1):
        raise HTTPException(422, detail="threshold_bad harus lebih besar dari 0 dan lebih kecil dari 1.")
    x = await read_photo(file)
    p_bad = float(model(x, training=False).numpy().reshape(-1)[0])
    if not np.isfinite(p_bad):
        raise HTTPException(500, detail="Model menghasilkan output tidak valid.")
    p_bad = max(0.0, min(1.0, p_bad))
    is_bad = p_bad >= threshold_bad
    return {
        "kondisi_visual": "BAD" if is_bad else "GOOD",
        "probabilitas_good": round(1.0 - p_bad, 6),
        "probabilitas_bad": round(p_bad, 6),
        "confidence": round(p_bad if is_bad else 1.0 - p_bad, 6),
        "threshold_bad": threshold_bad,
        "model": "ResNet50",
    }


def weight_group(grams: float) -> str:
    if grams <= 50:
        return "KECIL"
    if grams <= 100:
        return "SEDANG"
    if grams <= 300:
        return "BESAR"
    return "SANGAT BESAR"


@app.get("/health")
def health():
    return {
        "status": "ready" if model is not None else "model_not_loaded",
        "model": "ResNet50",
        "model_path": str(MODEL_PATH),
        "database": "connected" if DB_PATH.exists() else "initialized_on_startup",
    }


@app.post("/predict", response_model=PredictionResponse)
async def predict(file: UploadFile = File(...), threshold_bad: float = Form(0.5)):
    started = time.perf_counter()
    result = await classify(file, threshold_bad)
    response_ms = round((time.perf_counter() - started) * 1000)
    record_id, created_at = save_inspection(file.filename or "upload", result, response_ms)

    buat_perintah(PerintahSortir(kondisi_visual=result["kondisi_visual"]))

    return {**result, "record_id": record_id, "created_at": created_at, "response_ms": response_ms}


@app.post("/grade", response_model=GradingResponse)
async def grade(file: UploadFile = File(...), berat_gram: float = Form(..., gt=0), threshold_bad: float = Form(0.5)):
    started = time.perf_counter()
    result = await classify(file, threshold_bad)
    if not np.isfinite(berat_gram):
        raise HTTPException(422, detail="berat_gram harus angka hingga/finite.")
    if result["kondisi_visual"] == "BAD":
        result = {**result, "berat_gram": berat_gram, "keputusan_sortir": "REJECT", "golongan_ukuran": None,
                  "keterangan": "Cacat visual menurut model; pada prototipe tidak dilanjutkan ke penggolongan ukuran."}
    else:
        group = weight_group(berat_gram)
        result = {**result, "berat_gram": berat_gram, "keputusan_sortir": "LANJUT SORTIR", "golongan_ukuran": group,
                  "keterangan": "Golongan ukuran berdasarkan berat, bukan penetapan Mutu I/II SNI. Untuk berat pecahan gram digunakan batas kontinu."}
    response_ms = round((time.perf_counter() - started) * 1000)
    record_id, created_at = save_inspection(file.filename or "upload", result, response_ms)
    return {**result, "record_id": record_id, "created_at": created_at, "response_ms": response_ms}


@app.get("/records")
def list_records(limit: int = Query(500, ge=1, le=5000), offset: int = Query(0, ge=0)):
    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) FROM inspections").fetchone()[0]
        rows = conn.execute(
            "SELECT * FROM inspections ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)
        ).fetchall()
    return {"total": total, "records": [dict(row) for row in rows]}


@app.delete("/records")
def clear_records():
    with get_connection() as conn:
        conn.execute("DELETE FROM inspections")
        conn.commit()
    return {"status": "cleared", "message": "Riwayat pemeriksaan berhasil dihapus."}



# ==========================================
# INTEGRASI HARDWARE ESP32 - POPTATO
# ==========================================

class DataLoadCell(BaseModel):
    berat_gram: float = Field(ge=0)


hardware_terakhir = None


@app.post("/hardware/berat")
def terima_berat(data: DataLoadCell):
    global hardware_terakhir

    if not np.isfinite(data.berat_gram):
        raise HTTPException(
            status_code=422,
            detail="Berat harus berupa angka finite."
        )

    kategori = weight_group(data.berat_gram)

    hardware_terakhir = {
        "berat_gram": data.berat_gram,
        "kategori": kategori,
        "waktu": datetime.now(
            timezone.utc
        ).isoformat()
    }

    print("Data dari ESP32:", hardware_terakhir)

    return {
        "status": "berhasil",
        "data": hardware_terakhir
    }


@app.get("/hardware/berat")
def lihat_berat():
    return {
        "data": hardware_terakhir
    }


# ==========================================
# PERINTAH SORTIR CNN UNTUK ESP32
# ==========================================

class PerintahSortir(BaseModel):
    kondisi_visual: str

perintah_sortir = None



@app.post("/hardware/perintah")
def buat_perintah(data: PerintahSortir):
    global perintah_sortir

    kondisi = data.kondisi_visual.upper()

    if kondisi not in ("GOOD", "BAD"):
        raise HTTPException(
            status_code=422,
            detail="Kondisi harus GOOD atau BAD"
        )

    # Jangan timpa perintah yang belum selesai
    if (
        perintah_sortir is not None
        and perintah_sortir["status"] in (
            "MENUNGGU_ESP32",
            "DIPROSES"
        )
    ):
        raise HTTPException(
            status_code=409,
            detail="Masih ada kentang yang menunggu atau sedang diproses"
        )

    perintah_sortir = {
        "id": time.time_ns(),
        "kondisi_visual": kondisi,
        "status": "MENUNGGU_ESP32"
    }

    return {
        "status": "berhasil",
        "perintah": perintah_sortir
    }



@app.get("/hardware/perintah")
def ambil_perintah():
    return {
        "perintah": perintah_sortir
    }



# ==========================================
# KONFIRMASI PERINTAH DARI ESP32
# ==========================================

class KonfirmasiPerintah(BaseModel):
    id: int


@app.post("/hardware/perintah/selesai")
def selesaikan_perintah(data: KonfirmasiPerintah):
    global perintah_sortir

    if perintah_sortir is None:
        raise HTTPException(
            status_code=404,
            detail="Tidak ada perintah aktif"
        )

    if perintah_sortir["id"] != data.id:
        raise HTTPException(
            status_code=409,
            detail="ID perintah tidak sesuai"
        )

    perintah_sortir["status"] = "SELESAI"

    return {
        "status": "berhasil",
        "perintah": perintah_sortir
    }



# ==========================================
# KUNCI PERINTAH SAAT DIPROSES ESP32
# ==========================================

@app.post("/hardware/perintah/{command_id}/mulai")
def mulai_perintah(command_id: int):
    global perintah_sortir

    if perintah_sortir is None:
        raise HTTPException(
            status_code=404,
            detail="Tidak ada perintah"
        )

    if perintah_sortir["id"] != command_id:
        raise HTTPException(
            status_code=409,
            detail="ID perintah tidak sesuai"
        )

    if perintah_sortir["status"] != "MENUNGGU_ESP32":
        raise HTTPException(
            status_code=409,
            detail="Perintah sudah diambil atau selesai"
        )

    perintah_sortir["status"] = "DIPROSES"

    return {
        "status": "berhasil",
        "perintah": perintah_sortir
    }

