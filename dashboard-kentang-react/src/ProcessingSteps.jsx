import React, { useEffect, useState } from 'react'

const SIZE = 224
const IMAGE_NET_BGR_MEANS = [103.939, 116.779, 123.68] // B, G, R

const fmt = v => Number(v).toFixed(2).replace('.', ',')
const clamp8 = v => Math.min(255, Math.max(0, Math.round(v)))

/**
 * Visualisasi ulang preprocessing berdasarkan file yang sama dengan prediksi.
 * Inferensi resmi tetap dilakukan oleh FastAPI/TensorFlow, bukan oleh komponen ini.
 * Browser Canvas menggunakan interpolasi gambar tersendiri; nilai numeriknya
 * merupakan contoh piksel pada versi browser, bukan salinan tensor backend.
 */
async function buildProcessing(file) {
  const url = URL.createObjectURL(file)
  try {
    const image = new window.Image()
    image.src = url
    await image.decode()

    const originalCanvas = document.createElement('canvas')
    originalCanvas.width = image.naturalWidth
    originalCanvas.height = image.naturalHeight
    // Canvas untuk gambar asli (dibatasi agar tidak membuat kanvas sangat besar)
    const originalUrl = url

    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, SIZE, SIZE)
    const rgbImage = ctx.getImageData(0, 0, SIZE, SIZE)
    const originalPixels = rgbImage.data
    const resizeUrl = canvas.toDataURL('image/png')

    const r = originalPixels[0]
    const g = originalPixels[1]
    const b = originalPixels[2]
    const bgr = [b, g, r]
    const centered = bgr.map((v, i) => v - IMAGE_NET_BGR_MEANS[i])

    // Pratinjau BGR: urutan kanal B,G,R ditampilkan sebagai warna RGB untuk ilustrasi.
    const swapped = new ImageData(SIZE, SIZE)
    const centeredView = new ImageData(SIZE, SIZE)
    for (let i = 0; i < originalPixels.length; i += 4) {
      const red = originalPixels[i]
      const green = originalPixels[i + 1]
      const blue = originalPixels[i + 2]
      swapped.data[i] = blue
      swapped.data[i + 1] = green
      swapped.data[i + 2] = red
      swapped.data[i + 3] = 255

      // Untuk diperlihatkan di layar, nilai negatif tensor digeser +128,
      // HANYA untuk visualisasi; bukan bagian dari tensor yang masuk ke model.
      centeredView.data[i] = clamp8(blue - IMAGE_NET_BGR_MEANS[0] + 128)
      centeredView.data[i + 1] = clamp8(green - IMAGE_NET_BGR_MEANS[1] + 128)
      centeredView.data[i + 2] = clamp8(red - IMAGE_NET_BGR_MEANS[2] + 128)
      centeredView.data[i + 3] = 255
    }
    ctx.putImageData(swapped, 0, 0)
    const bgrPreview = canvas.toDataURL('image/png')
    ctx.putImageData(centeredView, 0, 0)
    const centeredPreview = canvas.toDataURL('image/png')

    return {
      originalUrl,
      originalSize: `${image.naturalWidth} × ${image.naturalHeight}`,
      resized: resizeUrl,
      bgrPreview,
      centeredPreview,
      rgbSample: [r, g, b],
      floatSample: [Math.fround(r), Math.fround(g), Math.fround(b)],
      bgrSample: bgr,
      centeredSample: centered,
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

export default function ProcessingSteps({ file, result }) {
  const [view, setView] = useState(null)
  const [err, setErr] = useState('')
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    let active = true
    let currentUrl = null
    setView(null)
    setErr('')
    buildProcessing(file).then(v => {
      currentUrl = v.originalUrl
      if (active) setView(v)
      else URL.revokeObjectURL(v.originalUrl)
    }).catch(e => {
      if (active) setErr(e.message)
    })
    return () => {
      active = false
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [file, result])

  const steps = view ? [
    {
      title: '01. Citra asli (RGB)',
      subtitle: `Gambar hasil webcam / upload • ${view.originalSize} piksel`,
      src: view.originalUrl,
      detail: 'Ini citra asli yang dikirim ke FastAPI. Jika file grayscale/RGBA, backend mengonversinya menjadi 3 kanal RGB.',
      sample: `Contoh piksel (R,G,B): [${view.rgbSample.join(', ')}]`
    },
    {
      title: '02. Resize 224 × 224',
      subtitle: 'Penyamaan ukuran masukan model',
      src: view.resized,
      detail: 'Gambar disesuaikan ke 224 × 224 piksel. Backend menggunakan PIL dengan interpolasi bilinear.',
      sample: 'Bentuk data: 224 × 224 × 3'
    },
    {
      title: '03. Konversi tipe float32',
      subtitle: 'Nilai piksel siap diolah sebagai bilangan pecahan',
      src: view.resized,
      detail: 'Tampilan gambar tidak berubah. Tipe data piksel berubah dari uint8 menjadi float32 sebelum preprocessing ResNet50.',
      sample: `Contoh piksel float32: [${view.floatSample.map(fmt).join(', ')}]`
    },
    {
      title: '04. RGB → BGR',
      subtitle: 'Perubahan urutan kanal warna untuk ResNet50',
      src: view.bgrPreview,
      detail: 'Tensor RGB ditukar menjadi urutan B,G,R. Warna di kartu ini adalah ilustrasi ketika kanal BGR ditampilkan sebagai RGB.',
      sample: `Contoh piksel BGR: [${view.bgrSample.join(', ')}]`
    },
    {
      title: '05. ImageNet mean subtraction',
      subtitle: 'B−103,939 • G−116,779 • R−123,680',
      src: view.centeredPreview,
      detail: 'Setiap kanal dikurangi rata-rata ImageNet. Nilai bisa negatif; ilustrasi gambar digeser +128 agar dapat dilihat, tetapi tensor model tidak ditambah 128.',
      sample: `Contoh tensor BGR: [${view.centeredSample.map(fmt).join(', ')}]`
    }
  ] : []

  return <section className="card pcv-panel">
    <div className="pcv-top">
      <div>
        <div className="kicker">04 / IMAGE PREPROCESSING</div>
        <h2>Langkah Preprocessing Gambar Kentang</h2>
        <p>Ditampilkan setelah analisis berhasil. Foto yang sama direkonstruksi tahap demi tahap di browser.</p>
      </div>
      <button className="btn secondary" type="button" onClick={() => setExpanded(x => !x)}>
        {expanded ? 'Sembunyikan tahapan' : 'Lihat tahapan'}
      </button>
    </div>
    {expanded && <>
      {err && <p className="inline-error">Gagal menampilkan visualisasi: {err}</p>}
      {!view && !err && <p className="pcv-loading">Menyiapkan visualisasi citra...</p>}
      {!!view && <>
        <div className="pcv-steps">
          {steps.map((step, index) => <React.Fragment key={step.title}>
            <article className="pcv-step">
              <img src={step.src} alt={step.title} />
              <div className="pcv-step-content">
                <strong>{step.title}</strong>
                <small>{step.subtitle}</small>
                <p>{step.detail}</p>
                <code>{step.sample}</code>
              </div>
            </article>
            {index < steps.length - 1 && <span className="pcv-arrow" aria-hidden="true">→</span>}
          </React.Fragment>)}
        </div>
        <div className="pcv-result"><strong>Hasil akhir:</strong> Tensor 1 × 224 × 224 × 3 diproses oleh ResNet50 → <strong>{result.kondisi_visual}</strong>.</div>
        <p className="pcv-note">Catatan ilmiah: panel ini menampilkan visualisasi ulang di browser, bukan hasil tensor mentah dari server. Browser memakai Canvas, sedangkan backend memakai PIL, sehingga nilai piksel contoh bisa sedikit berbeda. Grayscale, segmentasi, dan filter tepi tidak ditampilkan karena bukan langkah preprocessing ResNet50 yang digunakan sistem ini.</p>
      </>}
    </>}
  </section>
}
