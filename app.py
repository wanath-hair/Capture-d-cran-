import os
import re
import uuid
import json
import base64
import asyncio
import subprocess
import shutil
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import anthropic

app = FastAPI(title="Video Scene Analyzer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
FRAMES_DIR = Path("frames")
RESULTS_DIR = Path("results")

for d in [UPLOAD_DIR, FRAMES_DIR, RESULTS_DIR]:
    d.mkdir(exist_ok=True)

client = anthropic.Anthropic()
MAX_DURATION = 15 * 60  # 15 minutes
SCENE_THRESHOLD = 0.30  # Sensibilité détection de scène (0.0-1.0)


def get_video_duration(video_path: str) -> float:
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe error: {result.stderr}")
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def extract_scene_frames(video_path: str, output_dir: Path) -> list[dict]:
    """
    Extrait les frames aux changements de scène + toutes les 30s.
    Retourne [{"frame_path": str, "timestamp": float}]
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Passe 1 : détecter les scènes et récupérer les timestamps précis via showinfo
    showinfo_dir = output_dir / "raw"
    showinfo_dir.mkdir(exist_ok=True)

    vf = (
        f"select='gt(scene,{SCENE_THRESHOLD})+isnan(prev_selected_t)+"
        f"gte(t-prev_selected_t\\,30)',showinfo,"
        "scale=1280:720:force_original_aspect_ratio=decrease"
    )

    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-vf", vf,
        "-vsync", "vfr",
        "-q:v", "2",
        str(showinfo_dir / "%06d.jpg")
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    # Extraire les timestamps depuis la sortie stderr de showinfo
    timestamps: list[float] = []
    for line in result.stderr.split("\n"):
        if "pts_time" in line and "showinfo" in line.lower():
            m = re.search(r"pts_time:([\d.]+)", line)
            if m:
                timestamps.append(float(m.group(1)))

    frames = sorted(showinfo_dir.glob("*.jpg"))

    # Renommer avec timestamp encodé dans le nom pour tri
    scene_frames: list[dict] = []
    for i, frame in enumerate(frames):
        ts = timestamps[i] if i < len(timestamps) else None
        if ts is None:
            continue
        ts_str = f"{ts:012.4f}".replace(".", "_")
        dest = output_dir / f"scene_{ts_str}.jpg"
        frame.rename(dest)
        scene_frames.append({"frame_path": str(dest), "timestamp": ts})

    shutil.rmtree(showinfo_dir, ignore_errors=True)

    # Trier par timestamp
    scene_frames.sort(key=lambda x: x["timestamp"])
    return scene_frames


def format_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def analyze_frame(frame_path: str) -> str:
    with open(frame_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": image_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "Tu analyses une frame extraite d'une vidéo. "
                            "Décris précisément et de façon concise ce que tu vois : "
                            "personnes, actions, objets importants, lieu, ambiance. "
                            "Sois factuel et direct. Maximum 3 phrases courtes."
                        ),
                    },
                ],
            }
        ],
    )
    return message.content[0].text


async def analysis_stream(video_id: str, video_path: str) -> AsyncGenerator[str, None]:
    frames_dir = FRAMES_DIR / video_id

    def sse(data: dict) -> str:
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    try:
        # Durée
        yield sse({"type": "status", "message": "Vérification de la vidéo…"})
        await asyncio.sleep(0)

        try:
            duration = await asyncio.get_event_loop().run_in_executor(
                None, get_video_duration, video_path
            )
        except Exception as e:
            yield sse({"type": "error", "message": f"Impossible de lire la vidéo : {e}"})
            return

        if duration > MAX_DURATION:
            yield sse({
                "type": "error",
                "message": f"Vidéo trop longue ({format_timestamp(duration)}). Maximum 15 minutes."
            })
            return

        yield sse({
            "type": "info",
            "message": f"Durée : {format_timestamp(duration)} — Extraction des scènes…",
            "duration": duration,
            "duration_fmt": format_timestamp(duration),
        })
        await asyncio.sleep(0)

        # Extraction des frames
        try:
            scene_frames = await asyncio.get_event_loop().run_in_executor(
                None, extract_scene_frames, video_path, frames_dir
            )
        except Exception as e:
            yield sse({"type": "error", "message": f"Erreur extraction : {e}"})
            return

        if not scene_frames:
            yield sse({"type": "error", "message": "Aucune scène détectée dans la vidéo."})
            return

        yield sse({
            "type": "info",
            "message": f"{len(scene_frames)} scènes détectées. Analyse par Claude…",
            "total": len(scene_frames),
        })
        await asyncio.sleep(0)

        # Analyse de chaque frame
        results: list[dict] = []
        for i, frame in enumerate(scene_frames):
            ts = frame["timestamp"]
            ts_fmt = format_timestamp(ts)

            yield sse({
                "type": "progress",
                "current": i + 1,
                "total": len(scene_frames),
                "percent": round((i / len(scene_frames)) * 100),
                "timestamp": ts_fmt,
            })
            await asyncio.sleep(0)

            try:
                description = await asyncio.get_event_loop().run_in_executor(
                    None, analyze_frame, frame["frame_path"]
                )
                scene = {
                    "index": i + 1,
                    "timestamp": ts,
                    "timestamp_fmt": ts_fmt,
                    "description": description,
                }
                results.append(scene)
                yield sse({"type": "scene", "scene": scene})
                await asyncio.sleep(0)
            except Exception as e:
                yield sse({"type": "warning", "message": f"Frame {i+1} ignorée : {e}"})

        # Sauvegarde
        out = {
            "video_id": video_id,
            "duration": duration,
            "duration_fmt": format_timestamp(duration),
            "total_scenes": len(results),
            "scenes": results,
        }
        (RESULTS_DIR / f"{video_id}.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        yield sse({"type": "complete", "total_scenes": len(results), "video_id": video_id})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    allowed = {
        "video/mp4", "video/mpeg", "video/quicktime",
        "video/x-msvideo", "video/webm", "video/x-matroska",
    }
    content_type = file.content_type or ""
    if not content_type.startswith("video/") and content_type not in allowed:
        raise HTTPException(status_code=400, detail=f"Format non supporté : {content_type}")

    video_id = str(uuid.uuid4())
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = UPLOAD_DIR / f"{video_id}{suffix}"

    content = await file.read()
    video_path.write_bytes(content)

    return {"video_id": video_id, "filename": file.filename, "size": len(content)}


@app.get("/analyze/{video_id}")
async def analyze_video(video_id: str):
    matches = list(UPLOAD_DIR.glob(f"{video_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Vidéo introuvable")

    return StreamingResponse(
        analysis_stream(video_id, str(matches[0])),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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


app.mount("/", StaticFiles(directory="static", html=True), name="static")
