// 缓存前端主要节点，并维护当前选中的翻译文件、图片文件和最近一次打标结果。
const els = {
  serviceStatusText: document.getElementById("service-status-text"),
  deviceStatusText: document.getElementById("device-status-text"),
  hydrusStatusText: document.getElementById("hydrus-status-text"),
  hydrusTagServiceText: document.getElementById("hydrus-tag-service-text"),
  defaultModel: document.getElementById("default-model"),
  generalThreshold: document.getElementById("general-threshold"),
  characterThreshold: document.getElementById("character-threshold"),
  translationCsvFile: document.getElementById("translation-csv-file"),
  translationCsvDisplay: document.getElementById("translation-csv-display"),
  translationCsvMeta: document.getElementById("translation-csv-meta"),
  hydrusApiBaseUrl: document.getElementById("hydrus-api-base-url"),
  hydrusAccessKey: document.getElementById("hydrus-access-key"),
  hydrusTagServiceName: document.getElementById("hydrus-tag-service-name"),
  imageFolderInput: document.getElementById("image-folder-input"),
  imageFolderDisplay: document.getElementById("image-folder-display"),
  imageFolderMeta: document.getElementById("image-folder-meta"),
  summaryTotal: document.getElementById("summary-total"),
  summarySuccess: document.getElementById("summary-success"),
  summaryFailed: document.getElementById("summary-failed"),
  summaryUploaded: document.getElementById("summary-uploaded"),
  resultTableBody: document.getElementById("result-table-body"),
  logViewer: document.getElementById("log-viewer"),
  btnPickTranslationCsv: document.getElementById("btn-pick-translation-csv"),
  btnPickImageFolder: document.getElementById("btn-pick-image-folder"),
  btnCheckConnections: document.getElementById("btn-check-connections"),
  btnSaveConfig: document.getElementById("btn-save-config"),
  btnRefreshConfig: document.getElementById("btn-refresh-config"),
  btnModels: document.getElementById("btn-models"),
  btnWarmup: document.getElementById("btn-warmup"),
  btnProcessFolder: document.getElementById("btn-process-folder"),
  btnUploadHydrus: document.getElementById("btn-upload-hydrus"),
  btnClearTask: document.getElementById("btn-clear-task"),
  btnClearLogs: document.getElementById("btn-clear-logs"),
};

const SUPPORTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif"]);

let currentTranslationCsvPath = "";
let selectedTranslationFile = null;
let selectedImageFiles = [];
let lastTaggedItems = [];

function nowLabel() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function log(message, level = "info", detail = "") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${level}`;

  const title = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = `[${nowLabel()}]`;
  title.appendChild(strong);
  title.append(` ${message}`);
  entry.appendChild(title);

  if (detail) {
    const body = document.createElement("div");
    body.textContent = detail;
    entry.appendChild(body);
  }

  els.logViewer.prepend(entry);
}

function maskSecret(value) {
  if (!value) {
    return value;
  }
  const text = String(value);
  if (text.length <= 8) {
    return "*".repeat(text.length);
  }
  return `${text.slice(0, 4)}...${text.slice(-4)} (len=${text.length})`;
}

function describeFile(file) {
  if (!(file instanceof File)) {
    return file;
  }
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    webkitRelativePath: file.webkitRelativePath || "",
  };
}

function sanitizeForConsole(value) {
  if (value instanceof File) {
    return describeFile(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForConsole(item));
  }

  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.includes("access_key")) {
        sanitized[key] = maskSecret(item);
      } else if (normalizedKey.includes("base64")) {
        sanitized[key] = item ? `[base64 length=${String(item).length}]` : item;
      } else {
        sanitized[key] = sanitizeForConsole(item);
      }
    }
    return sanitized;
  }

  return value;
}

function parseRequestBodyForConsole(body) {
  if (!body) {
    return null;
  }

  if (body instanceof FormData) {
    const entries = [];
    for (const [key, value] of body.entries()) {
      entries.push([key, value instanceof File ? describeFile(value) : value]);
    }
    return entries;
  }

  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch (_error) {
    return body;
  }
}

function reportActionError(actionName, error, detail = {}) {
  const message = error?.message || String(error);
  console.error(`[${actionName}] 执行失败`, {
    message,
    detail: sanitizeForConsole(detail),
    error,
  });
  log(`${actionName}失败`, "error", message);
}

async function fetchJson(url, options = {}, actionName = "请求") {
  log(`${actionName}开始`, "info", `${options.method || "GET"} ${url}`);
  const method = options.method || "GET";
  const isFormData = options.body instanceof FormData;
  const requestHeaders = {
    ...(options.headers || {}),
  };
  if (!isFormData && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }
  const requestBody = parseRequestBodyForConsole(options.body);

  console.groupCollapsed(`[${actionName}] ${method} ${url}`);
  console.info("Request", sanitizeForConsole({
    method,
    url,
    headers: requestHeaders,
    body: requestBody,
  }));

  try {
    const response = await fetch(url, {
      ...options,
      headers: requestHeaders,
    });

    const text = await response.text();
    let payload = text;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_error) {
      payload = text;
    }

    console.info("Response status", {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
    });
    console.info("Response raw text", text);
    console.info("Response parsed payload", sanitizeForConsole(payload));

    if (!response.ok) {
      const detail = typeof payload === "object" && payload ? payload.detail || JSON.stringify(payload) : String(payload);
      const error = new Error(detail || `${response.status} ${response.statusText}`);
      error.httpStatus = response.status;
      error.httpStatusText = response.statusText;
      error.url = response.url || url;
      error.method = method;
      error.responseText = text;
      error.payload = payload;
      error.requestBody = requestBody;
      console.error("Request failed", sanitizeForConsole({
        message: error.message,
        httpStatus: error.httpStatus,
        httpStatusText: error.httpStatusText,
        url: error.url,
        method: error.method,
        responseText: error.responseText,
        payload: error.payload,
        requestBody: error.requestBody,
      }));
      log(`${actionName}失败`, "error", detail || error.message);
      throw error;
    }

    log(`${actionName}成功`, "success");
    return payload;
  } catch (error) {
    if (!error?.httpStatus) {
      console.error("Request crashed", sanitizeForConsole({
        message: error?.message || String(error),
        method,
        url,
        requestBody,
      }), error);
    }
    throw error;
  } finally {
    console.groupEnd();
  }
}

function setSelectOptions(selectEl, models, selectedValue) {
  selectEl.innerHTML = "";
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selectedValue;
    selectEl.appendChild(option);
  }
}

function basenameFromPath(path) {
  if (!path) {
    return "";
  }
  const normalized = String(path).replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function formatFileSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function renderTranslationCsvState() {
  if (selectedTranslationFile) {
    els.translationCsvDisplay.textContent = selectedTranslationFile.name;
    els.translationCsvMeta.textContent = `已选择本地词表 ${formatFileSize(selectedTranslationFile.size)}，点击“保存配置”后生效`;
    els.translationCsvDisplay.title = selectedTranslationFile.name;
    return;
  }

  if (currentTranslationCsvPath) {
    const filename = basenameFromPath(currentTranslationCsvPath);
    els.translationCsvDisplay.textContent = filename;
    els.translationCsvMeta.textContent = `当前后端词表: ${currentTranslationCsvPath}`;
    els.translationCsvDisplay.title = currentTranslationCsvPath;
    return;
  }

  els.translationCsvDisplay.textContent = "当前沿用后端已加载词表";
  els.translationCsvMeta.textContent = "未重新选择文件";
  els.translationCsvDisplay.title = "";
}

function renderImageFolderState() {
  if (!selectedImageFiles.length) {
    els.imageFolderDisplay.textContent = "未选择文件夹";
    els.imageFolderMeta.textContent = "请选择本地图片文件夹后再开始打标";
    els.imageFolderDisplay.title = "";
    return;
  }

  const topFolderName = selectedImageFiles[0].relativePath.includes("/")
    ? selectedImageFiles[0].relativePath.split("/")[0]
    : "已选图片集";
  const totalBytes = selectedImageFiles.reduce((sum, item) => sum + item.file.size, 0);
  els.imageFolderDisplay.textContent = topFolderName;
  els.imageFolderMeta.textContent = `已选择 ${selectedImageFiles.length} 张图片，总大小 ${formatFileSize(totalBytes)}`;
  els.imageFolderDisplay.title = selectedImageFiles.map((item) => item.displayName).join("\n");
}

function applyRuntimeConfig(config) {
  setSelectOptions(els.defaultModel, config.available_models, config.default_model);
  els.generalThreshold.value = config.general_threshold;
  els.characterThreshold.value = config.character_threshold;
  els.hydrusApiBaseUrl.value = config.hydrus_api_base_url || "";
  els.hydrusAccessKey.value = config.hydrus_access_key || "";
  els.hydrusTagServiceName.value = config.hydrus_tag_service_name || "";
  currentTranslationCsvPath = config.translation_csv_path || "";
  renderTranslationCsvState();
}

function updateConnectionView(payload) {
  els.serviceStatusText.textContent = payload.service_available ? "可用" : "异常";
  els.deviceStatusText.textContent = payload.device || "-";
  els.hydrusStatusText.textContent = payload.hydrus_available ? "已连接" : "不可用";
  els.hydrusTagServiceText.textContent = payload.hydrus_tag_service_name || "-";
}

function updateSummary(total, succeeded, failed, uploaded = 0) {
  els.summaryTotal.textContent = total;
  els.summarySuccess.textContent = succeeded;
  els.summaryFailed.textContent = failed;
  els.summaryUploaded.textContent = uploaded;
}

function renderTaggedItems(items) {
  els.resultTableBody.innerHTML = "";

  if (!items.length) {
    els.resultTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">还没有打标数据</td>
      </tr>
    `;
    return;
  }

  for (const item of items) {
    const row = document.createElement("tr");
    const note = item.error || item.hydrus_hash || "-";
    row.innerHTML = `
      <td>${item.index + 1}</td>
      <td>${item.display_name || item.filename || "-"}</td>
      <td>${item.english_tags?.length || 0}</td>
      <td>${item.translated_tags?.length || 0}</td>
      <td>${item.hydrus_uploaded ? "已上传" : (item.success ? "待上传" : "失败")}</td>
      <td>${note}</td>
    `;
    els.resultTableBody.appendChild(row);
  }
}

function setUploadButtonEnabled(enabled) {
  els.btnUploadHydrus.disabled = !enabled;
}

function clearPendingTranslationSelection() {
  selectedTranslationFile = null;
  els.translationCsvFile.value = "";
  renderTranslationCsvState();
}

function clearSelectedImageFiles() {
  selectedImageFiles = [];
  els.imageFolderInput.value = "";
  renderImageFolderState();
}

function createSelectedImageEntry(file, index) {
  const relativePath = (file.webkitRelativePath || file.name || `image-${index}`).replace(/\\/g, "/");
  return {
    id: `${relativePath}::${file.size}::${file.lastModified}::${index}`,
    file,
    relativePath,
    displayName: relativePath,
  };
}

function isSupportedImageFile(file) {
  const filename = file.name || "";
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) {
    return false;
  }
  const extension = filename.slice(dotIndex + 1).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
}

function currentUploadedCount() {
  return lastTaggedItems.filter((item) => item.hydrus_uploaded).length;
}

function makeTaggedItemFromResult(index, fileEntry, result) {
  return {
    index,
    file_id: fileEntry.id,
    filename: result.filename || fileEntry.file.name,
    display_name: fileEntry.displayName,
    success: true,
    english_tags: result.hydrus_tags || [],
    translated_tags: result.translated_tags || [],
    hydrus_uploaded: false,
    hydrus_hash: null,
    error: null,
  };
}

function makeTaggedItemFromError(index, fileEntry, error) {
  return {
    index,
    file_id: fileEntry.id,
    filename: fileEntry.file.name,
    display_name: fileEntry.displayName,
    success: false,
    english_tags: [],
    translated_tags: [],
    hydrus_uploaded: false,
    hydrus_hash: null,
    error: error?.message || String(error),
  };
}

function getSelectedImageEntryById(fileId) {
  return selectedImageFiles.find((item) => item.id === fileId) || null;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function refreshRuntimeConfig() {
  try {
    const config = await fetchJson("/api/v1/ui/runtime-config", {}, "刷新配置");
    applyRuntimeConfig(config);
    return config;
  } catch (error) {
    reportActionError("刷新配置", error);
    throw error;
  }
}

async function refreshModels() {
  try {
    const models = await fetchJson("/api/v1/models", {}, "刷新模型列表");
    log("模型列表返回", "info", models.map((item) => item.name).join(", "));
    return models;
  } catch (error) {
    reportActionError("刷新模型列表", error);
    throw error;
  }
}

async function uploadTranslationCsvIfNeeded() {
  if (!selectedTranslationFile) {
    return null;
  }

  const formData = new FormData();
  formData.append("file", selectedTranslationFile, selectedTranslationFile.name);

  try {
    const config = await fetchJson(
      "/api/v1/ui/runtime-config/translation-csv",
      {
        method: "POST",
        body: formData,
      },
      "上传翻译词表",
    );
    clearPendingTranslationSelection();
    applyRuntimeConfig(config);
    return config;
  } catch (error) {
    reportActionError("上传翻译词表", error, describeFile(selectedTranslationFile));
    throw error;
  }
}

async function saveRuntimeConfig() {
  const payload = {
    default_model: els.defaultModel.value || null,
    general_threshold: Number(els.generalThreshold.value),
    character_threshold: Number(els.characterThreshold.value),
    hydrus_api_base_url: els.hydrusApiBaseUrl.value.trim(),
    hydrus_access_key: els.hydrusAccessKey.value.trim(),
    hydrus_tag_service_name: els.hydrusTagServiceName.value.trim(),
  };

  try {
    await uploadTranslationCsvIfNeeded();

    const config = await fetchJson(
      "/api/v1/ui/runtime-config",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      "保存配置",
    );

    applyRuntimeConfig(config);
  } catch (error) {
    reportActionError("保存配置", error, payload);
    throw error;
  }
}

async function checkConnections() {
  try {
    const result = await fetchJson("/api/v1/connections/check", {}, "检测连接");
    updateConnectionView(result);
    if (result.hydrus_error) {
      console.warn("[检测连接] Hydrus 返回错误", sanitizeForConsole(result));
      log("Hydrus 连接错误", "error", result.hydrus_error);
    }
  } catch (error) {
    reportActionError("检测连接", error);
    throw error;
  }
}

async function warmupModel() {
  const model = els.defaultModel.value;
  try {
    await fetchJson(
      `/api/v1/models/warmup?model=${encodeURIComponent(model)}`,
      { method: "POST", headers: {} },
      "预热模型",
    );
  } catch (error) {
    reportActionError("预热模型", error, { model });
    throw error;
  }
}

async function processFolder() {
  if (!selectedImageFiles.length) {
    log("开始打标失败", "error", "请先用浏览器选择图片文件夹");
    return;
  }

  lastTaggedItems = [];
  renderTaggedItems([]);
  updateSummary(selectedImageFiles.length, 0, 0, 0);
  setUploadButtonEnabled(false);

  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < selectedImageFiles.length; index += 1) {
    const fileEntry = selectedImageFiles[index];
    const formData = new FormData();
    formData.append("file", fileEntry.file, fileEntry.file.name);
    if (els.defaultModel.value) {
      formData.append("model", els.defaultModel.value);
    }
    if (els.generalThreshold.value) {
      formData.append("general_threshold", String(Number(els.generalThreshold.value)));
    }
    if (els.characterThreshold.value) {
      formData.append("character_threshold", String(Number(els.characterThreshold.value)));
    }

    try {
      const result = await fetchJson(
        "/api/v1/tags/upload",
        {
          method: "POST",
          body: formData,
        },
        `开始打标 ${fileEntry.displayName}`,
      );
      lastTaggedItems.push(makeTaggedItemFromResult(index, fileEntry, result));
      succeeded += 1;
    } catch (error) {
      lastTaggedItems.push(makeTaggedItemFromError(index, fileEntry, error));
      failed += 1;
      reportActionError(`开始打标 ${fileEntry.displayName}`, error, describeFile(fileEntry.file));
    }

    renderTaggedItems(lastTaggedItems);
    updateSummary(selectedImageFiles.length, succeeded, failed, 0);
  }

  setUploadButtonEnabled(lastTaggedItems.some((item) => item.success));
  log(
    `本地图片打标完成，共 ${selectedImageFiles.length} 张`,
    failed > 0 ? "error" : "success",
    `成功 ${succeeded}，失败 ${failed}`,
  );
}

async function uploadToHydrus() {
  const uploadQueue = lastTaggedItems.filter((item) => item.success && !item.hydrus_uploaded);

  if (!uploadQueue.length) {
    log("上传已取消", "error", "当前没有可上传到 Hydrus 的打标结果");
    return;
  }

  const payloadItems = [];
  for (const item of uploadQueue) {
    const fileEntry = getSelectedImageEntryById(item.file_id);
    if (!fileEntry) {
      reportActionError("上传到 Hydrus", new Error("对应的本地文件已丢失"), item);
      continue;
    }

    payloadItems.push({
      image_base64: await fileToBase64(fileEntry.file),
      filename: fileEntry.displayName,
      tags: item.english_tags,
    });
  }

  if (!payloadItems.length) {
    log("上传已取消", "error", "没有可用于上传的图片二进制数据");
    return;
  }

  const payload = {
    items: payloadItems,
    model: els.defaultModel.value || null,
    general_threshold: els.generalThreshold.value ? Number(els.generalThreshold.value) : null,
    character_threshold: els.characterThreshold.value ? Number(els.characterThreshold.value) : null,
  };

  let result;
  try {
    result = await fetchJson(
      "/api/v1/hydrus/upload/images",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      "上传到 Hydrus",
    );
  } catch (error) {
    reportActionError("上传到 Hydrus", error, {
      item_count: payload.items.length,
      filenames: uploadQueue.map((item) => item.display_name),
    });
    throw error;
  }

  const uploadQueueByIndex = new Map(uploadQueue.map((item, index) => [index, item.file_id]));
  const uploadResultByFileId = new Map(
    result.items.map((item) => [uploadQueueByIndex.get(item.index), item])
  );

  lastTaggedItems = lastTaggedItems.map((item) => {
    const uploaded = uploadResultByFileId.get(item.file_id);
    if (!uploaded) {
      return item;
    }
    return {
      ...item,
      hydrus_uploaded: uploaded.success,
      hydrus_hash: uploaded.hydrus_hash,
      error: uploaded.error || item.error,
    };
  });

  renderTaggedItems(lastTaggedItems);
  updateSummary(
    lastTaggedItems.length,
    lastTaggedItems.filter((item) => item.success).length,
    lastTaggedItems.filter((item) => !item.success).length,
    currentUploadedCount(),
  );
  log(result.message, result.failed > 0 ? "error" : "success");
}

function clearTask() {
  clearSelectedImageFiles();
  lastTaggedItems = [];
  renderTaggedItems([]);
  updateSummary(0, 0, 0, 0);
  setUploadButtonEnabled(false);
  log("已清空本地图片处理任务", "info");
}

function clearLogs() {
  els.logViewer.innerHTML = "";
}

function handleTranslationCsvSelection(event) {
  const [file] = Array.from(event.target.files || []);
  if (!file) {
    return;
  }

  selectedTranslationFile = file;
  renderTranslationCsvState();
  log("已选择翻译词表", "info", `${file.name} / ${formatFileSize(file.size)}`);
}

function handleImageFolderSelection(event) {
  const files = Array.from(event.target.files || []);
  const imageFiles = files.filter((file) => isSupportedImageFile(file));

  if (!imageFiles.length) {
    clearSelectedImageFiles();
    log("图片文件夹选择失败", "error", "所选目录中没有支持的图片文件");
    return;
  }

  selectedImageFiles = imageFiles
    .map((file, index) => createSelectedImageEntry(file, index))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));

  renderImageFolderState();
  log("已选择图片文件夹", "info", `共 ${selectedImageFiles.length} 张图片`);
}

async function initialize() {
  renderTaggedItems([]);
  renderTranslationCsvState();
  renderImageFolderState();
  updateSummary(0, 0, 0, 0);
  setUploadButtonEnabled(false);

  try {
    await refreshRuntimeConfig();
  } catch (error) {
    reportActionError("初始加载配置", error);
  }

  try {
    await refreshModels();
  } catch (error) {
    reportActionError("初始加载模型列表", error);
  }

  try {
    await checkConnections();
  } catch (error) {
    reportActionError("初始连接检测", error);
  }
}

els.btnPickTranslationCsv.addEventListener("click", () => {
  els.translationCsvFile.value = "";
  els.translationCsvFile.click();
});
els.btnPickImageFolder.addEventListener("click", () => {
  els.imageFolderInput.value = "";
  els.imageFolderInput.click();
});
els.translationCsvFile.addEventListener("change", handleTranslationCsvSelection);
els.imageFolderInput.addEventListener("change", handleImageFolderSelection);
els.btnCheckConnections.addEventListener("click", () => checkConnections().catch(() => {}));
els.btnSaveConfig.addEventListener("click", () => saveRuntimeConfig().catch(() => {}));
els.btnRefreshConfig.addEventListener("click", () => refreshRuntimeConfig().catch(() => {}));
els.btnModels.addEventListener("click", () => refreshModels().catch(() => {}));
els.btnWarmup.addEventListener("click", () => warmupModel().catch(() => {}));
els.btnProcessFolder.addEventListener("click", () => processFolder().catch(() => {}));
els.btnUploadHydrus.addEventListener("click", () => uploadToHydrus().catch(() => {}));
els.btnClearTask.addEventListener("click", clearTask);
els.btnClearLogs.addEventListener("click", clearLogs);

initialize();
