"""Poptato FastAPI: ResNet50, SQLite, hardware HX711, and one-shot CNN commands.

Run from API_ResNet50_Kentang directory:
    python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

Prototype: single API worker + local trusted Wi-Fi only. Do not publish control routes.
"""
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import threading
import time
from uuid import uuid4

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Query
from pydantic import BaseModel, Field

MODEL_PATH = Path(os.getenv("MODEL_PATH", "resnet50_best.keras"))
DB_PATH = Path(os.getenv("DB_PATH", "potato_history.db"))
MAX_FILE_BYTES = 10 * 1024 * 1024
IMAGE_SIZE = (224, 224)
model = None

# One potato at a time. Command state is in memory (not durable on restart).
command_lock = threading.Lock()
perintah_sortir = None
hardware_terakhir = None


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


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
    created_at = now_iso()
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
        print(f"PERINGATAN: model belum ada di {MODEL_PATH}; /predict dan /grade HTTP 503")
    print(f"SQLite history: {DB_PATH.resolve()}")
    yield
    model = None


app = FastAPI(
    title="API Klasifikasi Kentang — ResNet50 + SQLite + ESP32",
    description="GOOD/BAD dari citra lalu timbang HX711 dan sortir fisik ESP32.",
    version="2.0.0", lifespan=lifespan,
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


class DataLoadCell(BaseModel):
    berat_gram: float = Field(ge=0, allow_inf_nan=False)


class PerintahSortir(BaseModel):
    kondisi_visual: str


class KonfirmasiPerintah(BaseModel):
    id: str
    berat_gram: float | None = Field(default=None, ge=0, allow_inf_nan=False)


def ensure_model():
    if model is None:
        raise HTTPException(503, detail="Model belum dimuat. Periksa MODEL_PATH dan restart server.")


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
        "probabilitas_good": round(1 - p_bad, 6),
        "probabilitas_bad": round(p_bad, 6),
        "confidence": round(p_bad if is_bad else 1 - p_bad, 6),
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


def assert_not_busy():
    if perintah_sortir is not None and perintah_sortir["status"] in ("MENUNGGU_ESP32", "DIPROSES"):
        raise HTTPException(409, detail="Masih ada kentang yang menunggu atau sedang diproses")


def new_command(kondisi: str, record_id: int | None = None):
    global perintah_sortir
    if kondisi not in ("GOOD", "BAD"):
        raise HTTPException(422, detail="Kondisi harus GOOD atau BAD")
    # Caller MUST hold command_lock.
    assert_not_busy()
    perintah_sortir = {
        "id": uuid4().hex,  # string ID: no precision loss in ArduinoJson
        "kondisi_visual": kondisi,
        "status": "MENUNGGU_ESP32",
        "record_id": record_id,
        "waktu": now_iso(),
    }
    return perintah_sortir.copy()


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
    # This endpoint is the automatic physical sorting mode.
    with command_lock:
        assert_not_busy()
    result = await classify(file, threshold_bad)
    response_ms = round((time.perf_counter() - started) * 1000)
    with command_lock:
        assert_not_busy()
        record_id, created_at = save_inspection(file.filename or "upload", result, response_ms)
        new_command(result["kondisi_visual"], record_id)
    return {**result, "record_id": record_id, "created_at": created_at, "response_ms": response_ms}


@app.post("/grade", response_model=GradingResponse)
async def grade(file: UploadFile = File(...), berat_gram: float = Form(..., gt=0), threshold_bad: float = Form(0.5)):
    # Existing manual simulation remains separate from physical sorting commands.
    started = time.perf_counter()
    result = await classify(file, threshold_bad)
    if not np.isfinite(berat_gram):
        raise HTTPException(422, detail="berat_gram harus finite")
    if result["kondisi_visual"] == "BAD":
        result = {**result, "berat_gram": berat_gram, "keputusan_sortir": "REJECT", "golongan_ukuran": None,
                  "keterangan": "Cacat visual menurut model; tidak disortir berdasarkan ukuran."}
    else:
        group = weight_group(berat_gram)
        result = {**result, "berat_gram": berat_gram, "keputusan_sortir": "LANJUT SORTIR", "golongan_ukuran": group,
                  "keterangan": "Golongan ukuran berdasarkan berat; bukan sertifikasi mutu SNI."}
    response_ms = round((time.perf_counter() - started) * 1000)
    record_id, created_at = save_inspection(file.filename or "upload", result, response_ms)
    return {**result, "record_id": record_id, "created_at": created_at, "response_ms": response_ms}


@app.get("/records")
def list_records(limit: int = Query(500, ge=1, le=5000), offset: int = Query(0, ge=0)):
    with get_connection() as conn:
        total = conn.execute("SELECT COUNT(*) FROM inspections").fetchone()[0]
        rows = conn.execute("SELECT * FROM inspections ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
    return {"total": total, "records": [dict(row) for row in rows]}


@app.delete("/records")
def clear_records():
    with get_connection() as conn:
        conn.execute("DELETE FROM inspections")
        conn.commit()
    return {"status": "cleared", "message": "Riwayat pemeriksaan berhasil dihapus."}


@app.post("/hardware/berat")
def terima_berat(data: DataLoadCell):
    global hardware_terakhir
    hardware_terakhir = {
        "berat_gram": data.berat_gram,
        "kategori": weight_group(data.berat_gram),
        "waktu": now_iso(),
    }
    return {"status": "berhasil", "data": hardware_terakhir}


@app.get("/hardware/berat")
def lihat_berat():
    return {"data": hardware_terakhir}


@app.post("/hardware/perintah")
def buat_perintah(data: PerintahSortir):
    # Swagger manual test; /predict already creates these automatically.
    with command_lock:
        cmd = new_command(data.kondisi_visual.upper())
    return {"status": "berhasil", "perintah": cmd}


@app.get("/hardware/perintah")
def ambil_perintah():
    with command_lock:
        cmd = perintah_sortir.copy() if perintah_sortir else None
    return {"perintah": cmd}


@app.post("/hardware/perintah/{command_id}/mulai")
def mulai_perintah(command_id: str):
    global perintah_sortir
    with command_lock:
        if perintah_sortir is None:
            raise HTTPException(404, detail="Tidak ada perintah")
        if perintah_sortir["id"] != command_id:
            raise HTTPException(409, detail="ID perintah tidak sesuai")
        if perintah_sortir["status"] != "MENUNGGU_ESP32":
            raise HTTPException(409, detail="Perintah sudah diambil atau selesai")
        perintah_sortir["status"] = "DIPROSES"
        cmd = perintah_sortir.copy()
    return {"status": "berhasil", "perintah": cmd}


@app.post("/hardware/perintah/selesai")
def selesaikan_perintah(data: KonfirmasiPerintah):
    global perintah_sortir
    with command_lock:
        if perintah_sortir is None:
            raise HTTPException(404, detail="Tidak ada perintah")
        if perintah_sortir["id"] != data.id:
            raise HTTPException(409, detail="ID perintah tidak sesuai")
        if perintah_sortir["status"] != "DIPROSES":
            raise HTTPException(409, detail="Perintah belum DIPROSES atau sudah selesai")
        if data.berat_gram is None:
            raise HTTPException(422, detail="berat_gram harus dikirim saat konfirmasi")
        kondisi = perintah_sortir["kondisi_visual"]
        record_id = perintah_sortir["record_id"]
        keputusan = "REJECT" if kondisi == "BAD" else "LANJUT SORTIR"
        golongan = None if kondisi == "BAD" else weight_group(data.berat_gram)
        if record_id is not None:
            with get_connection() as conn:
                conn.execute("""UPDATE inspections SET berat_gram=?, keputusan_sortir=?, golongan_ukuran=? WHERE id=?""",
                             (data.berat_gram, keputusan, golongan, record_id))
                conn.commit()
        perintah_sortir["status"] = "SELESAI"
        perintah_sortir["berat_gram"] = data.berat_gram
        perintah_sortir["selesai_pada"] = now_iso()
        cmd = perintah_sortir.copy()
    return {"status": "berhasil", "perintah": cmd}
