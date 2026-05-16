/* ══════════════════════════════════════════════════════════════════════════════
   TAB NAVIGATION
   ══════════════════════════════════════════════════════════════════════════════ */

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll("main[role='tabpanel']").forEach(m => m.classList.add("hidden"));
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
  });
});


/* ══════════════════════════════════════════════════════════════════════════════
   TAB 1 — ANALYSE VIDÉO
   ══════════════════════════════════════════════════════════════════════════════ */

let currentVideoId  = null;
let currentResults  = null;
let currentMode     = "summary";
let analysisSource  = null;

const dropZone       = document.getElementById("drop-zone");
const fileInput      = document.getElementById("file-input");
const filePreview    = document.getElementById("file-preview");
const fileName       = document.getElementById("file-name");
const fileSize       = document.getElementById("file-size");
const resetBtn       = document.getElementById("reset-btn");
const analyzeBtn     = document.getElementById("analyze-btn");
const progressSect   = document.getElementById("progress-section");
const progressTitle  = document.getElementById("progress-title");
const progressBar    = document.getElementById("progress-bar");
const progressCount  = document.getElementById("progress-counter");
const progressStatus = document.getElementById("progress-status");
const resultsSect    = document.getElementById("results-section");
const resultsTitle   = document.getElementById("results-title");
const resultsMeta    = document.getElementById("results-meta");
const outputArea     = document.getElementById("output-area");
const exportJsonBtn  = document.getElementById("export-json-btn");
const exportTxtBtn   = document.getElementById("export-txt-btn");
const newBtn         = document.getElementById("new-btn");
const errorBanner    = document.getElementById("error-banner");
const errorText      = document.getElementById("error-text");
const labelSummary   = document.getElementById("label-summary");
const labelNarrative = document.getElementById("label-narrative");

function formatBytes(b) {
  if (b < 1024) return b + " o";
  if (b < 1048576) return (b / 1024).toFixed(1) + " Ko";
  return (b / 1048576).toFixed(1) + " Mo";
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.remove("hidden");
  setTimeout(() => errorBanner.classList.add("hidden"), 12000);
}

function hideError() { errorBanner.classList.add("hidden"); }

function escapeHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

document.querySelectorAll('input[name="mode"]').forEach(r => {
  r.addEventListener("change", () => {
    currentMode = r.value;
    labelSummary.classList.toggle("active", currentMode === "summary");
    labelNarrative.classList.toggle("active", currentMode === "narrative");
  });
});

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", e => { e.preventDefault(); dropZone.classList.remove("dragover"); if (e.dataTransfer.files[0]) handleAnalyseFile(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleAnalyseFile(fileInput.files[0]); });

function handleAnalyseFile(file) {
  if (!file.type.startsWith("video/")) { showError("Fichier non supporté."); return; }
  hideError();
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  dropZone.classList.add("hidden");
  filePreview.classList.remove("hidden");
  fileInput._file = file;
}

resetBtn.addEventListener("click", () => {
  fileInput.value = ""; fileInput._file = null;
  filePreview.classList.add("hidden");
  dropZone.classList.remove("hidden");
  hideError();
});

analyzeBtn.addEventListener("click", async () => {
  const file = fileInput._file;
  if (!file) { showError("Sélectionnez d'abord une vidéo."); return; }
  analyzeBtn.disabled = true;
  hideError();
  progressSect.classList.remove("hidden");
  progressTitle.textContent = "Envoi de la vidéo…";
  progressStatus.textContent = "Transfert en cours…";
  progressBar.style.width = "0%";
  progressCount.textContent = "";

  const fd = new FormData();
  fd.append("file", file);
  let uploadRes;
  try {
    const r = await fetch("/upload", { method: "POST", body: fd });
    if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.detail || `Erreur HTTP ${r.status}`); }
    uploadRes = await r.json();
  } catch (e) {
    showError("Échec de l'envoi : " + e.message);
    resetAnalyseUI(); return;
  }

  currentVideoId = uploadRes.video_id;
  currentResults = { mode: currentMode, scenes: [] };
  outputArea.innerHTML = "";
  resultsSect.classList.add("hidden");
  progressTitle.textContent = "Analyse en cours…";

  if (currentMode === "narrative") {
    outputArea.className = "script-view";
    resultsTitle.textContent = "Script narratif";
  } else {
    outputArea.className = "timeline";
    resultsTitle.textContent = "Résultats de l'analyse";
  }

  analysisSource = new EventSource(`/analyze/${currentVideoId}?mode=${currentMode}`);
  analysisSource.onmessage = e => handleSSE(JSON.parse(e.data));
  analysisSource.onerror = () => { analysisSource.close(); showError("Connexion interrompue pendant l'analyse."); resetAnalyseUI(); };
});

function handleSSE(msg) {
  switch (msg.type) {
    case "status":
    case "info":
      progressTitle.textContent = msg.message;
      if (msg.total) progressCount.textContent = `0 / ${msg.total}`;
      break;
    case "progress":
      progressBar.style.width = msg.percent + "%";
      progressCount.textContent = `${msg.current} / ${msg.total}`;
      progressStatus.textContent = msg.mode === "narrative"
        ? `t = ${msg.script_ts}  (${msg.current}/${msg.total})`
        : `Scène ${msg.current} — t = ${msg.timestamp}`;
      break;
    case "scene": {
      const { scene, mode } = msg;
      if (!currentResults) currentResults = { mode, scenes: [] };
      currentResults.scenes.push(scene);
      if (mode === "narrative") appendScriptLine(scene); else appendSceneCard(scene);
      if (currentResults.scenes.length === 1) { resultsSect.classList.remove("hidden"); resultsMeta.textContent = "Analyse en cours…"; }
      break;
    }
    case "complete":
      analysisSource.close();
      progressSect.classList.add("hidden");
      resultsSect.classList.remove("hidden");
      resultsMeta.textContent = `${msg.total_scenes} instant${msg.total_scenes > 1 ? "s" : ""} analysé${msg.total_scenes > 1 ? "s" : ""}`;
      analyzeBtn.disabled = false;
      break;
    case "warning":
      console.warn("VideoScene:", msg.message);
      break;
    case "error":
      analysisSource.close();
      showError(msg.message);
      resetAnalyseUI();
      break;
  }
}

function appendSceneCard(scene) {
  const [main, ms] = scene.timestamp_fmt.split(".");
  const card = document.createElement("div");
  card.className = "scene-card";
  card.innerHTML = `
    <div class="scene-ts">${main}<span class="ts-ms">${ms ? "." + ms : ""}</span></div>
    <div class="scene-dot"></div>
    <div class="scene-body">
      <div class="scene-index">Scène ${scene.index}</div>
      <div class="scene-desc">${escapeHtml(scene.description)}</div>
    </div>`;
  outputArea.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function appendScriptLine(scene) {
  const line = document.createElement("div");
  line.className = "script-line";
  line.innerHTML = `<span class="script-ts">${escapeHtml(scene.script_ts)}</span><span class="script-text">${escapeHtml(scene.description)}</span>`;
  outputArea.appendChild(line);
  line.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

exportJsonBtn.addEventListener("click", () => {
  if (!currentResults) return;
  download(JSON.stringify(currentResults, null, 2), `videoscene_${(currentVideoId || "export").slice(0,8)}.json`, "application/json");
});

exportTxtBtn.addEventListener("click", () => {
  if (!currentResults?.scenes?.length) return;
  const lines = currentResults.scenes.map(s => `${s.script_ts} ${s.description}`);
  const header = `SCRIPT NARRATIF — VideoScene\nMode : ${currentResults.mode === "narrative" ? "Script narratif exhaustif" : "Résumé par scène"}\nInstants analysés : ${currentResults.scenes.length}\n${"─".repeat(40)}\n\n`;
  download(header + lines.join("\n\n"), `script_${(currentVideoId || "export").slice(0,8)}.txt`, "text/plain");
});

function download(content, filename, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([content], { type })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

newBtn.addEventListener("click", () => {
  if (currentVideoId) { fetch(`/cleanup/${currentVideoId}`, { method: "DELETE" }).catch(() => {}); currentVideoId = null; }
  currentResults = null;
  if (analysisSource) { analysisSource.close(); analysisSource = null; }
  outputArea.innerHTML = "";
  resultsSect.classList.add("hidden");
  progressSect.classList.add("hidden");
  filePreview.classList.add("hidden");
  dropZone.classList.remove("hidden");
  fileInput.value = ""; fileInput._file = null;
  analyzeBtn.disabled = false;
  hideError();
});

function resetAnalyseUI() {
  analyzeBtn.disabled = false;
  progressSect.classList.add("hidden");
  progressBar.style.width = "0%";
}


/* ══════════════════════════════════════════════════════════════════════════════
   TAB 2 — ÉCHANGE DE PERSONNAGE
   ══════════════════════════════════════════════════════════════════════════════ */

const sw = {
  videoId:    null,
  videoFile:  null,
  faces:      [],       // [{index, chip}]
  /* photo assignments: face_index(str) → {photoId, name, thumbSrc} */
  assignments: {},
  swapId:     null,
  source:     null,     // EventSource
};

/* ── DOM refs ──────────────────────────────────────────────────────────────── */
const swVideoDrop    = document.getElementById("sw-video-drop");
const swVideoInput   = document.getElementById("sw-video-input");
const swVideoReady   = document.getElementById("sw-video-ready");
const swVideoName    = document.getElementById("sw-video-name");
const swVideoSize    = document.getElementById("sw-video-size");
const swVideoReset   = document.getElementById("sw-video-reset");
const swDetectBtn    = document.getElementById("sw-detect-btn");
const swStepAssign   = document.getElementById("sw-step-assign");
const swFaceGrid     = document.getElementById("sw-face-grid");
const swLaunchBtn    = document.getElementById("sw-launch-btn");
const swRedetectBtn  = document.getElementById("sw-redetect-btn");
const swAssignCount  = document.getElementById("sw-assign-count");
const swStepProgress = document.getElementById("sw-step-progress");
const swProgTitle    = document.getElementById("sw-prog-title");
const swProgBar      = document.getElementById("sw-prog-bar");
const swProgCounter  = document.getElementById("sw-prog-counter");
const swProgStatus   = document.getElementById("sw-prog-status");
const swStepResult   = document.getElementById("sw-step-result");
const swDownloadBtn  = document.getElementById("sw-download-btn");
const swNewBtn       = document.getElementById("sw-new-btn");
const swErrorBanner  = document.getElementById("sw-error-banner");
const swErrorText    = document.getElementById("sw-error-text");

function swShowError(msg) {
  swErrorText.textContent = msg;
  swErrorBanner.classList.remove("hidden");
  setTimeout(() => swErrorBanner.classList.add("hidden"), 12000);
}

function swHideError() { swErrorBanner.classList.add("hidden"); }

/* ── Video upload ──────────────────────────────────────────────────────────── */
swVideoDrop.addEventListener("click", () => swVideoInput.click());
swVideoDrop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") swVideoInput.click(); });
swVideoDrop.addEventListener("dragover", e => { e.preventDefault(); swVideoDrop.classList.add("dragover"); });
swVideoDrop.addEventListener("dragleave", () => swVideoDrop.classList.remove("dragover"));
swVideoDrop.addEventListener("drop", e => { e.preventDefault(); swVideoDrop.classList.remove("dragover"); if (e.dataTransfer.files[0]) swHandleVideo(e.dataTransfer.files[0]); });
swVideoInput.addEventListener("change", () => { if (swVideoInput.files[0]) swHandleVideo(swVideoInput.files[0]); });

function swHandleVideo(file) {
  if (!file.type.startsWith("video/")) { swShowError("Fichier non supporté. Sélectionnez une vidéo."); return; }
  swHideError();
  sw.videoFile = file;
  swVideoName.textContent = file.name;
  swVideoSize.textContent = formatBytes(file.size);
  swVideoDrop.classList.add("hidden");
  swVideoReady.classList.remove("hidden");
}

swVideoReset.addEventListener("click", () => {
  swVideoInput.value = "";
  sw.videoFile = null;
  sw.videoId   = null;
  swVideoReady.classList.add("hidden");
  swVideoDrop.classList.remove("hidden");
  swStepAssign.classList.add("hidden");
  swHideError();
});

/* ── Detect faces ──────────────────────────────────────────────────────────── */
swDetectBtn.addEventListener("click", async () => {
  if (!sw.videoFile) { swShowError("Sélectionnez d'abord une vidéo."); return; }
  swHideError();
  swDetectBtn.disabled = true;
  swDetectBtn.textContent = "Upload en cours…";

  // Upload video
  const fd = new FormData();
  fd.append("file", sw.videoFile);
  let up;
  try {
    const r = await fetch("/swap/upload-video", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    up = await r.json();
  } catch (e) {
    swShowError("Erreur upload : " + e.message);
    swDetectBtn.disabled = false;
    swDetectBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Détecter les personnages`;
    return;
  }

  sw.videoId = up.video_id;
  swDetectBtn.textContent = "Détection des visages…";

  // Detect
  let det;
  try {
    const r = await fetch(`/swap/detect/${sw.videoId}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    det = await r.json();
  } catch (e) {
    swShowError("Erreur détection : " + e.message);
    swDetectBtn.disabled = false;
    swDetectBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Détecter les personnages`;
    return;
  }

  sw.faces = det.faces;
  sw.assignments = {};
  swDetectBtn.disabled = false;
  swDetectBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Détecter les personnages`;

  if (!sw.faces.length) {
    swShowError("Aucun visage détecté dans la vidéo. Vérifiez que des visages sont bien visibles.");
    return;
  }

  swRenderFaceGrid();
  swStepAssign.classList.remove("hidden");
  swStepAssign.scrollIntoView({ behavior: "smooth", block: "start" });
  swUpdateAssignUI();
});

/* ── Render face grid ──────────────────────────────────────────────────────── */
function swRenderFaceGrid() {
  swFaceGrid.innerHTML = "";
  sw.faces.forEach(face => {
    const card = document.createElement("div");
    card.className = "face-card";
    card.dataset.index = face.index;

    card.innerHTML = `
      <div class="face-chip-wrap">
        <img class="face-chip" src="${escapeHtml(face.chip)}" alt="Personne ${face.index + 1}" />
      </div>
      <div class="face-label">Personne ${face.index + 1}</div>
      <div class="face-assignment">
        <div class="assign-empty">
          <button class="btn-assign" data-index="${face.index}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Assigner une photo
          </button>
          <span class="muted" style="font-size:0.72rem">Laisser tel quel</span>
        </div>
        <div class="assign-set hidden">
          <div class="ref-thumb-wrap">
            <img class="ref-thumb" />
          </div>
          <div class="ref-arrow">↕</div>
          <span class="ref-name"></span>
          <button class="btn-unassign" data-index="${face.index}">Retirer</button>
        </div>
      </div>`;

    // Hidden file input for this face
    const photoInput = document.createElement("input");
    photoInput.type = "file";
    photoInput.accept = "image/*";
    photoInput.hidden = true;
    photoInput.dataset.index = face.index;
    photoInput.addEventListener("change", () => {
      if (photoInput.files[0]) swHandlePhotoAssign(face.index, photoInput.files[0]);
    });
    card.appendChild(photoInput);

    card.querySelector(".btn-assign").addEventListener("click", () => photoInput.click());
    card.querySelector(".btn-unassign").addEventListener("click", () => swUnassign(face.index, card));

    swFaceGrid.appendChild(card);
  });
}

/* ── Assign photo to a face ────────────────────────────────────────────────── */
async function swHandlePhotoAssign(faceIndex, file) {
  const card = swFaceGrid.querySelector(`[data-index="${faceIndex}"]`);
  const assignBtn = card.querySelector(".btn-assign");
  assignBtn.textContent = "Upload…";
  assignBtn.disabled = true;

  // Upload photo
  const fd = new FormData();
  fd.append("file", file);
  let up;
  try {
    const r = await fetch("/swap/upload-photo", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    up = await r.json();
  } catch (e) {
    swShowError("Erreur upload photo : " + e.message);
    assignBtn.disabled = false;
    assignBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Assigner une photo`;
    return;
  }

  // Register assignment server-side
  try {
    const r = await fetch("/swap/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: sw.videoId, face_index: faceIndex, photo_id: up.photo_id }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
  } catch (e) {
    swShowError("Erreur assignation : " + e.message);
    assignBtn.disabled = false;
    assignBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Assigner une photo`;
    return;
  }

  // Update local state & UI
  const reader = new FileReader();
  reader.onload = ev => {
    sw.assignments[String(faceIndex)] = { photoId: up.photo_id, name: file.name, thumbSrc: ev.target.result };
    swUpdateCardAssigned(faceIndex, ev.target.result, file.name);
    swUpdateAssignUI();
  };
  reader.readAsDataURL(file);
}

function swUpdateCardAssigned(faceIndex, thumbSrc, name) {
  const card = swFaceGrid.querySelector(`[data-index="${faceIndex}"]`);
  if (!card) return;
  card.classList.add("assigned");
  const emptyDiv = card.querySelector(".assign-empty");
  const setDiv   = card.querySelector(".assign-set");
  emptyDiv.classList.add("hidden");
  setDiv.classList.remove("hidden");
  setDiv.querySelector(".ref-thumb").src = thumbSrc;
  setDiv.querySelector(".ref-name").textContent = name;
}

async function swUnassign(faceIndex, card) {
  try {
    await fetch(`/swap/unassign?video_id=${sw.videoId}&face_index=${faceIndex}`, { method: "DELETE" });
  } catch (_) {}

  delete sw.assignments[String(faceIndex)];
  card.classList.remove("assigned");
  const emptyDiv = card.querySelector(".assign-empty");
  const setDiv   = card.querySelector(".assign-set");
  setDiv.classList.add("hidden");
  emptyDiv.classList.remove("hidden");
  const btn = emptyDiv.querySelector(".btn-assign");
  btn.disabled = false;
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Assigner une photo`;
  swUpdateAssignUI();
}

function swUpdateAssignUI() {
  const n = Object.keys(sw.assignments).length;
  swLaunchBtn.disabled = n === 0;
  if (n > 0) {
    swAssignCount.textContent = `${n} remplacement${n > 1 ? "s" : ""} assigné${n > 1 ? "s" : ""}`;
    swAssignCount.classList.remove("hidden");
    swAssignCount.classList.add("badge-green");
  } else {
    swAssignCount.classList.add("hidden");
  }
}

/* ── Redetect ──────────────────────────────────────────────────────────────── */
swRedetectBtn.addEventListener("click", () => {
  sw.assignments = {};
  sw.faces = [];
  sw.videoId = null;
  sw.videoFile = null;
  swVideoInput.value = "";
  swVideoReady.classList.add("hidden");
  swVideoDrop.classList.remove("hidden");
  swStepAssign.classList.add("hidden");
  swFaceGrid.innerHTML = "";
  swHideError();
});

/* ── Launch swap ───────────────────────────────────────────────────────────── */
swLaunchBtn.addEventListener("click", () => {
  if (!sw.videoId) { swShowError("Aucune vidéo chargée."); return; }
  if (!Object.keys(sw.assignments).length) { swShowError("Assignez au moins une photo."); return; }

  swStepAssign.classList.add("hidden");
  swStepProgress.classList.remove("hidden");
  swProgBar.style.width = "0%";
  swProgTitle.textContent = "Initialisation…";
  swProgCounter.textContent = "";
  swProgStatus.textContent = "";
  swHideError();

  sw.source = new EventSource(`/swap/process/${sw.videoId}`);
  sw.source.onmessage = e => swHandleSSE(JSON.parse(e.data));
  sw.source.onerror = () => {
    sw.source.close();
    swShowError("Connexion interrompue. Veuillez réessayer.");
    swStepProgress.classList.add("hidden");
    swStepAssign.classList.remove("hidden");
  };
});

function swHandleSSE(msg) {
  switch (msg.type) {
    case "status":
      swProgTitle.textContent = msg.message;
      break;
    case "info":
      swProgStatus.textContent = msg.message;
      if (msg.total_frames) swProgCounter.textContent = `0 / ${msg.total_frames}`;
      break;
    case "progress":
      swProgBar.style.width = msg.percent + "%";
      swProgCounter.textContent = `${msg.current} / ${msg.total}`;
      swProgStatus.textContent = `Frame ${msg.current} / ${msg.total} — ${msg.percent}%`;
      break;
    case "complete":
      sw.source.close();
      sw.swapId = msg.swap_id;
      swStepProgress.classList.add("hidden");
      swStepResult.classList.remove("hidden");
      swStepResult.scrollIntoView({ behavior: "smooth", block: "start" });
      break;
    case "error":
      sw.source.close();
      swShowError(msg.message);
      swStepProgress.classList.add("hidden");
      swStepAssign.classList.remove("hidden");
      break;
  }
}

/* ── Download ──────────────────────────────────────────────────────────────── */
swDownloadBtn.addEventListener("click", () => {
  if (!sw.swapId) return;
  const a = document.createElement("a");
  a.href = `/swap/download/${sw.swapId}`;
  a.download = `echange_${sw.swapId.slice(0, 8)}.mp4`;
  a.click();
});

/* ── New swap ──────────────────────────────────────────────────────────────── */
swNewBtn.addEventListener("click", () => {
  if (sw.swapId) {
    fetch(`/cleanup-swap/${sw.swapId}`, { method: "DELETE" }).catch(() => {});
    sw.swapId = null;
  }
  if (sw.source) { sw.source.close(); sw.source = null; }
  sw.videoId  = null;
  sw.videoFile = null;
  sw.faces    = [];
  sw.assignments = {};
  swVideoInput.value = "";
  swVideoReady.classList.add("hidden");
  swVideoDrop.classList.remove("hidden");
  swStepAssign.classList.add("hidden");
  swStepProgress.classList.add("hidden");
  swStepResult.classList.add("hidden");
  swFaceGrid.innerHTML = "";
  swHideError();
});
