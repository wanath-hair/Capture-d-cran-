import re
import uuid
import json
import asyncio
import subprocess
import shutil
import base64
import os
from pathlib import Path
from typing import AsyncGenerator, Optional, Any

from fastapi import FastAPI, File, UploadFile, HTTPException, Query, Body
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from PIL import Image

app = FastAPI(title="VideoScene")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR    = Path("uploads")
FRAMES_DIR    = Path("frames")
RESULTS_DIR   = Path("results")
PHOTOS_DIR    = Path("photos")
SWAP_DIR      = Path("swaps")
FACE_DATA_DIR = Path("face_data")

for d in [UPLOAD_DIR, FRAMES_DIR, RESULTS_DIR, PHOTOS_DIR, SWAP_DIR, FACE_DATA_DIR]:
    d.mkdir(exist_ok=True)

_api_key = os.environ.get("GOOGLE_API_KEY", "")
gemini = genai.Client(api_key=_api_key) if _api_key else None

MAX_DURATION = 15 * 60
GEMINI_MODEL = "gemini-2.5-flash-lite"
RATE_DELAY   = 4.0

MODE_CONFIGS = {
    "summary": {
        "scene_threshold": 0.30,
        "interval_sec": 30,
        "prompt": (
            "Tu analyses une frame extraite d'une vidéo. "
            "Décris précisément et de façon concise ce que tu vois : "
            "personnes, actions, objets importants, lieu, ambiance. "
            "Sois factuel et direct. Maximum 3 phrases courtes."
        ),
    },
    "narrative": {
        "scene_threshold": 0.20,
        "interval_sec": 5,
        "prompt": (
            "Tu analyses une image extraite d'une vidéo.\n"
            "Décris de façon exhaustive et fluide tout ce que tu vois à l'écran, "
            "comme un narrateur qui décrit un film en temps réel.\n"
            "Couvre systématiquement :\n"
            "– Actions, mouvements, gestes des personnes présentes\n"
            "– Expressions du visage, postures, regards, interactions\n"
            "– Décors, environnement, arrière-plan, éclairage, ambiance visuelle\n"
            "– Angle de caméra, mouvement de caméra, profondeur de champ\n"
            "– Texte affiché à l'écran, graphiques, intertitres (si visibles)\n"
            "– Objets et éléments visuels importants au premier plan\n"
            "– Transitions, effets visuels\n\n"
            "NE TRANSCRIS PAS les dialogues, paroles ou voix off.\n"
            "Sois exhaustif : rien ne doit être résumé ou omis.\n"
            "Écris directement la narration en paragraphe continu, "
            "sans titre, sans liste à puces, sans préambule."
        ),
    },
}


# ─── Analyse helpers ──────────────────────────────────────────────────────────

def get_video_duration(video_path: str) -> float:
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", video_path]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe error: {result.stderr}")
    return float(json.loads(result.stdout)["format"]["duration"])


def extract_scene_frames(video_path, output_dir, scene_threshold, interval_sec):
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = output_dir / "raw"
    raw_dir.mkdir(exist_ok=True)

    vf = (
        f"select='gt(scene,{scene_threshold})+isnan(prev_selected_t)+"
        f"gte(t-prev_selected_t\\,{interval_sec})',showinfo,"
        "scale=1280:720:force_original_aspect_ratio=decrease"
    )
    cmd = ["ffmpeg", "-y", "-i", video_path, "-vf", vf, "-vsync", "vfr",
           "-q:v", "2", str(raw_dir / "%06d.jpg")]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    timestamps = []
    for line in result.stderr.split("\n"):
        if "pts_time" in line and "showinfo" in line.lower():
            m = re.search(r"pts_time:([\d.]+)", line)
            if m:
                timestamps.append(float(m.group(1)))

    frames = sorted(raw_dir.glob("*.jpg"))
    scene_frames = []
    for i, frame in enumerate(frames):
        ts = timestamps[i] if i < len(timestamps) else None
        if ts is None:
            continue
        ts_key = f"{ts:012.4f}".replace(".", "_")
        dest = output_dir / f"scene_{ts_key}.jpg"
        frame.rename(dest)
        scene_frames.append({"frame_path": str(dest), "timestamp": ts})

    shutil.rmtree(raw_dir, ignore_errors=True)
    scene_frames.sort(key=lambda x: x["timestamp"])
    return scene_frames


def format_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def format_script_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    if h > 0:
        return f"[{h:02d}:{m:02d}:{s:02d}]"
    return f"[{m:02d}:{s:02d}]"


def analyze_frame(frame_path: str, prompt: str) -> str:
    img = Image.open(frame_path)
    response = gemini.models.generate_content(model=GEMINI_MODEL, contents=[prompt, img])
    return response.text


async def analysis_stream(video_id, video_path, mode) -> AsyncGenerator[str, None]:
    frames_dir = FRAMES_DIR / video_id
    cfg = MODE_CONFIGS[mode]

    def sse(data):
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    if not gemini:
        yield sse({"type": "error", "message": "Clé API Google manquante."})
        return

    try:
        yield sse({"type": "status", "message": "Vérification de la vidéo…", "mode": mode})
        await asyncio.sleep(0)

        try:
            duration = await asyncio.get_event_loop().run_in_executor(None, get_video_duration, video_path)
        except Exception as e:
            yield sse({"type": "error", "message": f"Impossible de lire la vidéo : {e}"})
            return

        if duration > MAX_DURATION:
            yield sse({"type": "error", "message": f"Vidéo trop longue ({format_timestamp(duration)}). Maximum 15 minutes."})
            return

        interval = cfg["interval_sec"]
        label = "Script narratif" if mode == "narrative" else "Résumé par scène"
        yield sse({"type": "info", "message": f"Durée : {format_timestamp(duration)} — Extraction ({label}, 1 frame/{interval}s)…",
                   "duration": duration, "duration_fmt": format_timestamp(duration), "mode": mode})
        await asyncio.sleep(0)

        try:
            scene_frames = await asyncio.get_event_loop().run_in_executor(
                None, extract_scene_frames, video_path, frames_dir, cfg["scene_threshold"], interval)
        except Exception as e:
            yield sse({"type": "error", "message": f"Erreur extraction : {e}"})
            return

        if not scene_frames:
            yield sse({"type": "error", "message": "Aucune scène détectée dans la vidéo."})
            return

        yield sse({"type": "info", "message": f"{len(scene_frames)} instants à analyser. Gemini travaille…",
                   "total": len(scene_frames), "mode": mode})
        await asyncio.sleep(0)

        results = []
        for i, frame in enumerate(scene_frames):
            ts = frame["timestamp"]
            ts_fmt = format_timestamp(ts)
            ts_script = format_script_timestamp(ts)

            yield sse({"type": "progress", "current": i + 1, "total": len(scene_frames),
                       "percent": round((i / len(scene_frames)) * 100),
                       "timestamp": ts_fmt, "script_ts": ts_script, "mode": mode})
            await asyncio.sleep(0)

            try:
                description = await asyncio.get_event_loop().run_in_executor(
                    None, analyze_frame, frame["frame_path"], cfg["prompt"])
                scene = {"index": i + 1, "timestamp": ts, "timestamp_fmt": ts_fmt,
                         "script_ts": ts_script, "description": description}
                results.append(scene)
                yield sse({"type": "scene", "scene": scene, "mode": mode})
                await asyncio.sleep(0)
            except Exception as e:
                yield sse({"type": "warning", "message": f"Frame {i + 1} ignorée : {e}"})

            await asyncio.sleep(RATE_DELAY)

        out = {"video_id": video_id, "mode": mode, "duration": duration,
               "duration_fmt": format_timestamp(duration),
               "total_scenes": len(results), "scenes": results}
        (RESULTS_DIR / f"{video_id}.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        yield sse({"type": "complete", "total_scenes": len(results), "video_id": video_id, "mode": mode})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)


# ─── Analyse endpoints ────────────────────────────────────────────────────────

@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    content_type = file.content_type or ""
    if not content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail=f"Format non supporté : {content_type}")
    video_id = str(uuid.uuid4())
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = UPLOAD_DIR / f"{video_id}{suffix}"
    content = await file.read()
    video_path.write_bytes(content)
    return {"video_id": video_id, "filename": file.filename, "size": len(content)}


@app.get("/analyze/{video_id}")
async def analyze_video(video_id: str, mode: str = Query(default="summary", pattern="^(summary|narrative)$")):
    matches = list(UPLOAD_DIR.glob(f"{video_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Vidéo introuvable")
    return StreamingResponse(analysis_stream(video_id, str(matches[0]), mode),
                             media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/results/{video_id}")
async def get_results(video_id: str):
    path = RESULTS_DIR / f"{video_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Résultats introuvables")
    return JSONResponse(json.loads(path.read_text("utf-8")))


@app.delete("/cleanup/{video_id}")
async def cleanup(video_id: str):
    for f in UPLOAD_DIR.glob(f"{video_id}.*"):
        f.unlink(missing_ok=True)
    (RESULTS_DIR / f"{video_id}.json").unlink(missing_ok=True)
    return {"ok": True}


# ─── Face swap — models (lazy) ────────────────────────────────────────────────

_face_analyzer: Optional[Any] = None
_face_swapper:  Optional[Any] = None

def _load_face_models():
    global _face_analyzer, _face_swapper
    try:
        import insightface
        import numpy as np
        from insightface.app import FaceAnalysis
    except ImportError:
        raise RuntimeError(
            "InsightFace non installé. "
            "Lancez : pip install insightface onnxruntime opencv-python-headless"
        )
    if _face_analyzer is None:
        _face_analyzer = FaceAnalysis(name="buffalo_l")
        _face_analyzer.prepare(ctx_id=0, det_size=(320, 320))
    if _face_swapper is None:
        _face_swapper = insightface.model_zoo.get_model(
            "inswapper_128.onnx", download=True, download_zip=True
        )
    return _face_analyzer, _face_swapper


def _face_chip_b64(img, face) -> str:
    import cv2
    try:
        from insightface.utils import face_align
        chip = face_align.norm_crop(img, landmark=face.kps, image_size=112)
    except Exception:
        import numpy as np
        x1, y1, x2, y2 = face.bbox.astype(int)
        crop = img[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
        if crop.size == 0:
            return ""
        chip = cv2.resize(crop, (112, 112))
    _, buf = cv2.imencode(".jpg", chip, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode()


# ─── Face swap — in-memory assignments ───────────────────────────────────────
# { video_id: { "0": photo_id, "2": photo_id, ... } }
_ASSIGNMENTS: dict[str, dict[str, str]] = {}


# ─── Face swap endpoints ──────────────────────────────────────────────────────

@app.post("/swap/upload-video")
async def swap_upload_video(file: UploadFile = File(...)):
    content_type = file.content_type or ""
    if not content_type.startswith("video/"):
        raise HTTPException(400, f"Format non supporté : {content_type}")
    video_id = str(uuid.uuid4())
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    (UPLOAD_DIR / f"{video_id}{suffix}").write_bytes(await file.read())
    return {"video_id": video_id, "filename": file.filename}


@app.post("/swap/upload-photo")
async def swap_upload_photo(file: UploadFile = File(...)):
    ct = file.content_type or ""
    if not ct.startswith("image/"):
        raise HTTPException(400, f"Format non supporté : {ct}")
    photo_id = str(uuid.uuid4())
    suffix = Path(file.filename or "photo.jpg").suffix or ".jpg"
    (PHOTOS_DIR / f"{photo_id}{suffix}").write_bytes(await file.read())
    return {"photo_id": photo_id}


@app.get("/swap/detect/{video_id}")
async def swap_detect(video_id: str):
    """Detect unique faces across keyframes via embedding clustering."""
    matches = list(UPLOAD_DIR.glob(f"{video_id}.*"))
    if not matches:
        raise HTTPException(404, "Vidéo introuvable")

    def _run():
        import cv2
        import numpy as np
        face_app, _ = _load_face_models()

        cap = cv2.VideoCapture(str(matches[0]))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps   = cap.get(cv2.CAP_PROP_FPS) or 25.0

        # Sample up to 12 keyframes spread across the video
        n_samples = min(12, max(1, int(total // (fps * 5))))
        step = max(1, total // (n_samples + 1))
        positions = [step * (i + 1) for i in range(n_samples)]

        unique: list[dict] = []
        SIM = 0.40

        for pos in positions:
            cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
            ret, frame = cap.read()
            if not ret:
                continue
            for face in face_app.get(frame):
                emb = face.normed_embedding
                matched = False
                for cluster in unique:
                    if float(np.dot(emb, cluster["emb"])) > SIM:
                        # Update cluster centroid
                        c = cluster["emb"] + emb
                        cluster["emb"] = c / np.linalg.norm(c)
                        matched = True
                        break
                if not matched:
                    unique.append({
                        "index": len(unique),
                        "emb":   emb,
                        "chip":  _face_chip_b64(frame, face),
                    })
        cap.release()

        # Persist embeddings for later matching
        face_data = [{"index": u["index"], "embedding": u["emb"].tolist(), "chip": u["chip"]}
                     for u in unique]
        (FACE_DATA_DIR / f"{video_id}.json").write_text(
            json.dumps(face_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return [{"index": u["index"], "chip": u["chip"]} for u in unique]

    try:
        faces = await asyncio.get_event_loop().run_in_executor(None, _run)
    except RuntimeError as e:
        raise HTTPException(503, str(e))

    return {"faces": faces, "total": len(faces)}


@app.post("/swap/assign")
async def swap_assign(payload: dict = Body(...)):
    video_id   = str(payload.get("video_id", ""))
    face_index = payload.get("face_index")
    photo_id   = str(payload.get("photo_id", ""))
    if not video_id or face_index is None or not photo_id:
        raise HTTPException(400, "Paramètres manquants")
    if not list(PHOTOS_DIR.glob(f"{photo_id}.*")):
        raise HTTPException(404, "Photo introuvable")
    _ASSIGNMENTS.setdefault(video_id, {})[str(face_index)] = photo_id
    return {"ok": True, "count": len(_ASSIGNMENTS[video_id])}


@app.delete("/swap/unassign")
async def swap_unassign(video_id: str = Query(...), face_index: int = Query(...)):
    _ASSIGNMENTS.get(video_id, {}).pop(str(face_index), None)
    return {"ok": True}


async def swap_stream(video_id: str) -> AsyncGenerator[str, None]:
    import cv2
    import numpy as np

    def sse(data):
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    matches = list(UPLOAD_DIR.glob(f"{video_id}.*"))
    if not matches:
        yield sse({"type": "error", "message": "Vidéo introuvable"})
        return

    assignments = _ASSIGNMENTS.get(video_id, {})
    if not assignments:
        yield sse({"type": "error", "message": "Aucun remplacement assigné"})
        return

    face_data_path = FACE_DATA_DIR / f"{video_id}.json"
    if not face_data_path.exists():
        yield sse({"type": "error", "message": "Données de visage manquantes. Relancez la détection."})
        return

    swap_id    = str(uuid.uuid4())
    video_path = str(matches[0])

    try:
        yield sse({"type": "status",
                   "message": "Chargement des modèles IA… (1re utilisation : téléchargement ~1,2 Go, patientez)"})
        await asyncio.sleep(0)

        try:
            face_app, swapper = await asyncio.get_event_loop().run_in_executor(None, _load_face_models)
        except RuntimeError as e:
            yield sse({"type": "error", "message": str(e)})
            return

        yield sse({"type": "status", "message": "Chargement des photos de référence…"})
        await asyncio.sleep(0)

        face_data = json.loads(face_data_path.read_text())

        face_map: dict[int, dict] = {}

        def _load_source_faces():
            for face_idx_str, photo_id in assignments.items():
                fi = int(face_idx_str)
                photos = list(PHOTOS_DIR.glob(f"{photo_id}.*"))
                if not photos:
                    continue
                img = cv2.imread(str(photos[0]))
                if img is None:
                    continue
                ref_faces = face_app.get(img)
                if not ref_faces:
                    continue
                emb = None
                for fd in face_data:
                    if fd["index"] == fi:
                        emb = np.array(fd["embedding"])
                        break
                if emb is not None:
                    face_map[fi] = {"embedding": emb, "source": ref_faces[0]}

        await asyncio.get_event_loop().run_in_executor(None, _load_source_faces)

        if not face_map:
            yield sse({"type": "error", "message": "Impossible de charger les photos de référence. Vérifiez qu'un visage est bien visible."})
            return

        yield sse({"type": "info",
                   "message": f"{len(face_map)} visage(s) à remplacer sur {len(face_data)} détecté(s)"})
        await asyncio.sleep(0)

        cap    = cv2.VideoCapture(video_path)
        total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps    = cap.get(cv2.CAP_PROP_FPS) or 25.0
        width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()

        temp_dir   = SWAP_DIR / swap_id
        temp_dir.mkdir(parents=True, exist_ok=True)
        temp_video  = temp_dir / "temp.mp4"
        output_video = SWAP_DIR / f"{swap_id}.mp4"

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(temp_video), fourcc, fps, (width, height))

        SIM_THRESHOLD = 0.35

        def _process(frame):
            faces = face_app.get(frame)
            for face in faces:
                emb = face.normed_embedding
                best_src  = None
                best_sim  = SIM_THRESHOLD
                for fdata in face_map.values():
                    sim = float(np.dot(emb, fdata["embedding"]))
                    if sim > best_sim:
                        best_sim = sim
                        best_src = fdata["source"]
                if best_src is not None:
                    frame = swapper.get(frame, face, best_src, paste_back=True)
            return frame

        cap     = cv2.VideoCapture(video_path)
        n       = 0
        last_pct = -1

        yield sse({"type": "info",
                   "message": f"{total} frames · {fps:.0f} fps · {width}×{height}",
                   "total_frames": total})
        yield sse({"type": "status", "message": "Traitement des images…"})
        await asyncio.sleep(0)

        while True:
            ret, frame = cap.read()
            if not ret:
                break
            processed = await asyncio.get_event_loop().run_in_executor(None, _process, frame)
            writer.write(processed)
            n += 1
            pct = int((n / max(total, 1)) * 100)
            if pct != last_pct:
                last_pct = pct
                yield sse({"type": "progress", "current": n, "total": total, "percent": pct})
                await asyncio.sleep(0)

        cap.release()
        writer.release()

        yield sse({"type": "status", "message": "Encodage final et fusion audio…"})
        await asyncio.sleep(0)

        cmd = [
            "ffmpeg", "-y",
            "-i", str(temp_video),
            "-i", video_path,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-map", "0:v:0",
            "-map", "1:a:0?",
            "-shortest",
            str(output_video),
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=600)
        if r.returncode != 0:
            shutil.copy(str(temp_video), str(output_video))

        shutil.rmtree(temp_dir, ignore_errors=True)
        _ASSIGNMENTS.pop(video_id, None)

        yield sse({"type": "complete", "swap_id": swap_id})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        shutil.rmtree(SWAP_DIR / swap_id, ignore_errors=True)


@app.get("/swap/process/{video_id}")
async def swap_process(video_id: str):
    return StreamingResponse(
        swap_stream(video_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/swap/download/{swap_id}")
async def swap_download(swap_id: str):
    if not re.match(r"^[0-9a-f\-]{36}$", swap_id):
        raise HTTPException(400, "ID invalide")
    path = SWAP_DIR / f"{swap_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "Résultat introuvable")

    def _iter():
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        _iter(),
        media_type="video/mp4",
        headers={"Content-Disposition": f"attachment; filename=echange_{swap_id[:8]}.mp4"},
    )


@app.delete("/cleanup-swap/{swap_id}")
async def cleanup_swap(swap_id: str):
    if not re.match(r"^[0-9a-f\-]{36}$", swap_id):
        raise HTTPException(400, "ID invalide")
    (SWAP_DIR / f"{swap_id}.mp4").unlink(missing_ok=True)
    return {"ok": True}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
