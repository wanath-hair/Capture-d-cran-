/* ─── State ─────────────────────────────────────────────────────────────────── */
let currentVideoId = null;
let currentResults = null;
let analysisSource = null;

/* ─── DOM refs ──────────────────────────────────────────────────────────────── */
const dropZone       = document.getElementById("drop-zone");
const fileInput      = document.getElementById("file-input");
const filePreview    = document.getElementById("file-preview");
const fileName       = document.getElementById("file-name");
const fileSize       = document.getElementById("file-size");
const resetBtn       = document.getElementById("reset-btn");
const analyzeBtn     = document.getElementById("analyze-btn");
const uploadSection  = document.getElementById("upload-section");
const progressSect   = document.getElementById("progress-section");
const progressTitle  = document.getElementById("progress-title");
const progressBar    = document.getElementById("progress-bar");
const progressCount  = document.getElementById("progress-counter");
const progressStatus = document.getElementById("progress-status");
const resultsSect    = document.getElementById("results-section");
const resultsMeta    = document.getElementById("results-meta");
const timeline       = document.getElementById("timeline");
const exportBtn      = document.getElementById("export-btn");
const newBtn         = document.getElementById("new-btn");
const errorBanner    = document.getElementById("error-banner");
const errorText      = document.getElementById("error-text");

/* ─── Helpers ───────────────────────────────────────────────────────────────── */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " o";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " Ko";
  return (bytes / 1048576).toFixed(1) + " Mo";
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.remove("hidden");
  setTimeout(() => errorBanner.classList.add("hidden"), 8000);
}

function hideError() {
  errorBanner.classList.add("hidden");
}

/* Format "HH:MM:SS.mmm" → split into main + ms part for display */
function splitTimestamp(ts) {
  const parts = ts.split(".");
  return { main: parts[0], ms: parts[1] ? "." + parts[1] : "" };
}

/* ─── Upload / Drop ─────────────────────────────────────────────────────────── */
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  if (!file.type.startsWith("video/")) {
    showError("Fichier non supporté. Sélectionnez une vidéo (MP4, MOV, AVI, WebM).");
    return;
  }
  hideError();
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  dropZone.classList.add("hidden");
  filePreview.classList.remove("hidden");
  fileInput._file = file;
}

resetBtn.addEventListener("click", () => {
  fileInput.value = "";
  fileInput._file = null;
  filePreview.classList.add("hidden");
  dropZone.classList.remove("hidden");
  hideError();
});

/* ─── Analyze ───────────────────────────────────────────────────────────────── */
analyzeBtn.addEventListener("click", async () => {
  const file = fileInput._file;
  if (!file) { showError("Sélectionnez d'abord une vidéo."); return; }

  analyzeBtn.disabled = true;
  hideError();

  /* 1. Upload */
  progressSect.classList.remove("hidden");
  progressTitle.textContent = "Envoi de la vidéo…";
  progressStatus.textContent = "Transfert en cours…";
  progressBar.style.width = "0%";
  progressCount.textContent = "";

  const formData = new FormData();
  formData.append("file", file);

  let uploadRes;
  try {
    const res = await fetch("/upload", { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Erreur HTTP ${res.status}`);
    }
    uploadRes = await res.json();
  } catch (e) {
    showError("Échec de l'envoi : " + e.message);
    resetUI();
    return;
  }

  currentVideoId = uploadRes.video_id;
  currentResults = { scenes: [] };

  /* 2. Stream analysis */
  progressTitle.textContent = "Analyse en cours…";
  timeline.innerHTML = "";
  resultsSect.classList.add("hidden");

  analysisSource = new EventSource(`/analyze/${currentVideoId}`);

  analysisSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleSSE(msg);
  };

  analysisSource.onerror = () => {
    analysisSource.close();
    showError("Connexion interrompue pendant l'analyse.");
    resetUI();
  };
});

function handleSSE(msg) {
  switch (msg.type) {

    case "status":
    case "info":
      progressTitle.textContent = msg.message;
      if (msg.total) progressCount.textContent = `0 / ${msg.total}`;
      break;

    case "progress":
      progressTitle.textContent = "Analyse des scènes…";
      progressBar.style.width = msg.percent + "%";
      progressCount.textContent = `${msg.current} / ${msg.total}`;
      progressStatus.textContent = `Scène ${msg.current} — t = ${msg.timestamp}`;
      break;

    case "scene": {
      const scene = msg.scene;
      if (!currentResults) currentResults = { scenes: [] };
      currentResults.scenes.push(scene);
      appendSceneCard(scene);

      /* Show results section on first scene */
      if (currentResults.scenes.length === 1) {
        resultsSect.classList.remove("hidden");
        resultsMeta.textContent = "Analyse en cours…";
      }
      break;
    }

    case "complete":
      analysisSource.close();
      progressSect.classList.add("hidden");
      resultsSect.classList.remove("hidden");
      resultsMeta.textContent =
        `${msg.total_scenes} scène${msg.total_scenes > 1 ? "s" : ""} détectée${msg.total_scenes > 1 ? "s" : ""}`;
      analyzeBtn.disabled = false;
      break;

    case "warning":
      console.warn("VideoScene warning:", msg.message);
      break;

    case "error":
      analysisSource.close();
      showError(msg.message);
      resetUI();
      break;
  }
}

function appendSceneCard(scene) {
  const { main, ms } = splitTimestamp(scene.timestamp_fmt);

  const card = document.createElement("div");
  card.className = "scene-card";
  card.style.animationDelay = "0.05s";
  card.innerHTML = `
    <div class="scene-ts">
      ${main}<span class="ts-ms">${ms}</span>
    </div>
    <div class="scene-dot"></div>
    <div class="scene-body">
      <div class="scene-index">Scène ${scene.index}</div>
      <div class="scene-desc">${escapeHtml(scene.description)}</div>
    </div>
  `;
  timeline.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ─── Export ────────────────────────────────────────────────────────────────── */
exportBtn.addEventListener("click", () => {
  if (!currentResults) return;
  const blob = new Blob([JSON.stringify(currentResults, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `videoscene_${currentVideoId?.slice(0, 8) || "export"}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ─── New video ─────────────────────────────────────────────────────────────── */
newBtn.addEventListener("click", () => {
  if (currentVideoId) {
    fetch(`/cleanup/${currentVideoId}`, { method: "DELETE" }).catch(() => {});
    currentVideoId = null;
  }
  currentResults = null;
  if (analysisSource) { analysisSource.close(); analysisSource = null; }
  timeline.innerHTML = "";
  resultsSect.classList.add("hidden");
  progressSect.classList.add("hidden");
  filePreview.classList.add("hidden");
  dropZone.classList.remove("hidden");
  fileInput.value = "";
  fileInput._file = null;
  analyzeBtn.disabled = false;
  hideError();
});

function resetUI() {
  analyzeBtn.disabled = false;
  progressSect.classList.add("hidden");
  progressBar.style.width = "0%";
}
