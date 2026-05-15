/* ─── State ─────────────────────────────────────────────────────────────────── */
let currentVideoId = null;
let currentResults = null;
let currentMode    = "summary";
let analysisSource = null;

/* ─── DOM refs ──────────────────────────────────────────────────────────────── */
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

/* ─── Helpers ───────────────────────────────────────────────────────────────── */
function formatBytes(b) {
  if (b < 1024) return b + " o";
  if (b < 1048576) return (b / 1024).toFixed(1) + " Ko";
  return (b / 1048576).toFixed(1) + " Mo";
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.remove("hidden");
  setTimeout(() => errorBanner.classList.add("hidden"), 10000);
}

function hideError() { errorBanner.classList.add("hidden"); }

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ─── Mode toggle ───────────────────────────────────────────────────────────── */
document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener("change", () => {
    currentMode = radio.value;
    labelSummary.classList.toggle("active", currentMode === "summary");
    labelNarrative.classList.toggle("active", currentMode === "narrative");
  });
});

/* ─── Upload / Drop ─────────────────────────────────────────────────────────── */
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
dropZone.addEventListener("dragover", e => {
  e.preventDefault(); dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", e => {
  e.preventDefault(); dropZone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
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
  fileInput.value = ""; fileInput._file = null;
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

  /* Upload */
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
    resetUI(); return;
  }

  currentVideoId = uploadRes.video_id;
  currentResults = { mode: currentMode, scenes: [] };

  /* Prépare la zone de résultats */
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

  /* SSE */
  analysisSource = new EventSource(`/analyze/${currentVideoId}?mode=${currentMode}`);
  analysisSource.onmessage = e => handleSSE(JSON.parse(e.data));
  analysisSource.onerror = () => {
    analysisSource.close();
    showError("Connexion interrompue pendant l'analyse.");
    resetUI();
  };
});

/* ─── SSE handler ───────────────────────────────────────────────────────────── */
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
      progressStatus.textContent =
        msg.mode === "narrative"
          ? `t = ${msg.script_ts}  (${msg.current}/${msg.total})`
          : `Scène ${msg.current} — t = ${msg.timestamp}`;
      break;

    case "scene": {
      const { scene, mode } = msg;
      if (!currentResults) currentResults = { mode, scenes: [] };
      currentResults.scenes.push(scene);

      if (mode === "narrative") {
        appendScriptLine(scene);
      } else {
        appendSceneCard(scene);
      }

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
        `${msg.total_scenes} instant${msg.total_scenes > 1 ? "s" : ""} analysé${msg.total_scenes > 1 ? "s" : ""}`;
      analyzeBtn.disabled = false;
      break;

    case "warning":
      console.warn("VideoScene:", msg.message);
      break;

    case "error":
      analysisSource.close();
      showError(msg.message);
      resetUI();
      break;
  }
}

/* ─── Summary mode — carte timeline ────────────────────────────────────────── */
function appendSceneCard(scene) {
  const tsParts = scene.timestamp_fmt.split(".");
  const main = tsParts[0];
  const ms   = tsParts[1] ? "." + tsParts[1] : "";

  const card = document.createElement("div");
  card.className = "scene-card";
  card.innerHTML = `
    <div class="scene-ts">${main}<span class="ts-ms">${ms}</span></div>
    <div class="scene-dot"></div>
    <div class="scene-body">
      <div class="scene-index">Scène ${scene.index}</div>
      <div class="scene-desc">${escapeHtml(scene.description)}</div>
    </div>`;
  outputArea.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ─── Narrative mode — ligne de script ──────────────────────────────────────── */
function appendScriptLine(scene) {
  const line = document.createElement("div");
  line.className = "script-line";
  line.innerHTML =
    `<span class="script-ts">${escapeHtml(scene.script_ts)}</span>` +
    `<span class="script-text">${escapeHtml(scene.description)}</span>`;
  outputArea.appendChild(line);
  line.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ─── Exports ───────────────────────────────────────────────────────────────── */
exportJsonBtn.addEventListener("click", () => {
  if (!currentResults) return;
  download(
    JSON.stringify(currentResults, null, 2),
    `videoscene_${currentVideoId?.slice(0, 8) || "export"}.json`,
    "application/json"
  );
});

exportTxtBtn.addEventListener("click", () => {
  if (!currentResults || !currentResults.scenes.length) return;
  const lines = currentResults.scenes.map(s => `${s.script_ts} ${s.description}`);
  const header =
    `SCRIPT NARRATIF — VideoScene\n` +
    `Mode : ${currentResults.mode === "narrative" ? "Script narratif exhaustif" : "Résumé par scène"}\n` +
    `Durée : ${currentResults.scenes.at(-1)?.timestamp_fmt || "—"}\n` +
    `Instants analysés : ${currentResults.scenes.length}\n` +
    `─────────────────────────────────────────\n\n`;
  download(
    header + lines.join("\n\n"),
    `script_${currentVideoId?.slice(0, 8) || "export"}.txt`,
    "text/plain"
  );
});

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ─── Nouvelle vidéo ────────────────────────────────────────────────────────── */
newBtn.addEventListener("click", () => {
  if (currentVideoId) {
    fetch(`/cleanup/${currentVideoId}`, { method: "DELETE" }).catch(() => {});
    currentVideoId = null;
  }
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

function resetUI() {
  analyzeBtn.disabled = false;
  progressSect.classList.add("hidden");
  progressBar.style.width = "0%";
}
