import re
import uuid
import json
import base64
import asyncio
import subprocess
import shutil
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
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

MODE_CONFIGS = {
    "summary": {
        "scene_threshold": 0.30,
        "interval_sec": 30,
        "max_tokens": 512,
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
        "max_tokens": 1024,
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


def extract_scene_frames(
    video_path: str,
    output_dir: Path,
    scene_threshold: float,
    interval_sec: int,
) -> list[dict]:
    """
    Extrait les frames aux changements de scène + toutes les N secondes.
    Retourne [{"frame_path": str, "timestamp": float}]
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = output_dir / "raw"
    raw_dir.mkdir(exist_ok=True)

    vf = (
        f"select='gt(scene,{scene_threshold})+isnan(prev_selected_t)+"
        f"gte(t-prev_selected_t\\,{interval_sec})',showinfo,"
        "scale=1280:720:force_original_aspect_ratio=decrease"
    )

    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-vf", vf,
        "-vsync", "vfr",
        "-q:v", "2",
        str(raw_dir / "%06d.jpg")
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    timestamps: list[float] = []
    for line in result.stderr.split("\n"):
        if "pts_time" in line and "showinfo" in line.lower():
            m = re.search(r"pts_time:([\d.]+)", line)
            if m:
                timestamps.append(float(m.group(1)))

    frames = sorted(raw_dir.glob("*.jpg"))

    scene_frames: list[dict] = []
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
    """HH:MM:SS.mmm — used for internal storage and summary mode display."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def format_script_timestamp(seconds: float) -> str:
    """[MM:SS] or [HH:MM:SS] — used in narrative script output."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    if h > 0:
        return f"[{h:02d}:{m:02d}:{s:02d}]"
    return f"[{m:02d}:{s:02d}]"


def analyze_frame(frame_path: str, prompt: str, max_tokens: int) -> str:
    with open(frame_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=max_tokens,
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
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )
    return message.content[0].text


async def analysis_stream(
    video_id: str,
    video_path: str,
    mode: str,
) -> AsyncGenerator[str, None]:
    frames_dir = FRAMES_DIR / video_id
    cfg = MODE_CONFIGS[mode]

    def sse(data: dict) -> str:
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    try:
        yield sse({"type": "status", "message": "Vérification de la vidéo…", "mode": mode})
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
                "message": f"Vidéo trop longue ({format_timestamp(duration)}). Maximum 15 minutes.",
            })
            return

        interval = cfg["interval_sec"]
        label = "Script narratif" if mode == "narrative" else "Résumé par scène"
        yield sse({
            "type": "info",
            "message": (
                f"Durée : {format_timestamp(duration)} — "
                f"Extraction ({label}, 1 frame/{interval}s)…"
            ),
            "duration": duration,
            "duration_fmt": format_timestamp(duration),
            "mode": mode,
        })
        await asyncio.sleep(0)

        try:
            scene_frames = await asyncio.get_event_loop().run_in_executor(
                None,
                extract_scene_frames,
                video_path,
                frames_dir,
                cfg["scene_threshold"],
                interval,
            )
        except Exception as e:
            yield sse({"type": "error", "message": f"Erreur extraction : {e}"})
            return

        if not scene_frames:
            yield sse({"type": "error", "message": "Aucune scène détectée dans la vidéo."})
            return

        yield sse({
            "type": "info",
            "message": f"{len(scene_frames)} instants à analyser. Claude travaille…",
            "total": len(scene_frames),
            "mode": mode,
        })
        await asyncio.sleep(0)

        results: list[dict] = []
        for i, frame in enumerate(scene_frames):
            ts = frame["timestamp"]
            ts_fmt = format_timestamp(ts)
            ts_script = format_script_timestamp(ts)

            yield sse({
                "type": "progress",
                "current": i + 1,
                "total": len(scene_frames),
                "percent": round((i / len(scene_frames)) * 100),
                "timestamp": ts_fmt,
                "script_ts": ts_script,
                "mode": mode,
            })
            await asyncio.sleep(0)

            try:
                description = await asyncio.get_event_loop().run_in_executor(
                    None,
                    analyze_frame,
                    frame["frame_path"],
                    cfg["prompt"],
                    cfg["max_tokens"],
                )
                scene = {
                    "index": i + 1,
                    "timestamp": ts,
                    "timestamp_fmt": ts_fmt,
                    "script_ts": ts_script,
                    "description": description,
                }
                results.append(scene)
                yield sse({"type": "scene", "scene": scene, "mode": mode})
                await asyncio.sleep(0)
            except Exception as e:
                yield sse({"type": "warning", "message": f"Frame {i + 1} ignorée : {e}"})

        out = {
            "video_id": video_id,
            "mode": mode,
            "duration": duration,
            "duration_fmt": format_timestamp(duration),
            "total_scenes": len(results),
            "scenes": results,
        }
        (RESULTS_DIR / f"{video_id}.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        yield sse({"type": "complete", "total_scenes": len(results), "video_id": video_id, "mode": mode})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)


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
async def analyze_video(
    video_id: str,
    mode: str = Query(default="summary", pattern="^(summary|narrative)$"),
):
    matches = list(UPLOAD_DIR.glob(f"{video_id}.*"))
    if not matches:
        raise HTTPException(status_code=404, detail="Vidéo introuvable")

    return StreamingResponse(
        analysis_stream(video_id, str(matches[0]), mode),
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
