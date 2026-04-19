// ==UserScript==
// @name         PMImageSpider
// @namespace    https://github.com/openai/codex-cli
// @version      0.1.0
// @description  在任意网页右键图片，一键发送到本地 PMTagger，并由 PMTagger 自动打标、翻译、上传到 Hydrus
// @author       OpenAI Codex
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEYS = {
    serviceBaseUrl: "pmtagger_service_base_url",
  };

  const DEFAULT_CONFIG = {
    serviceBaseUrl: "http://127.0.0.1:8000",
  };

  const STYLE_ID = "pmimage-spider-style";
  const MENU_ID = "pmimage-spider-menu";
  const TOAST_ID = "pmimage-spider-toast";

  let activeImageUrl = "";
  let activeImageAlt = "";
  let isUploading = false;

  function getConfig() {
    return {
      serviceBaseUrl: normalizeServiceBaseUrl(
        GM_getValue(STORAGE_KEYS.serviceBaseUrl, DEFAULT_CONFIG.serviceBaseUrl)
      ),
    };
  }

  function normalizeServiceBaseUrl(value) {
    return String(value || DEFAULT_CONFIG.serviceBaseUrl).trim().replace(/\/+$/, "");
  }

  function setConfigValue(key, value) {
    GM_setValue(key, value);
  }

  function registerMenu() {
    GM_registerMenuCommand("设置 PMTagger 服务地址", () => {
      const currentConfig = getConfig();
      const nextValue = window.prompt("输入 PMTagger 服务地址：", currentConfig.serviceBaseUrl);
      if (nextValue === null) {
        return;
      }
      setConfigValue(STORAGE_KEYS.serviceBaseUrl, normalizeServiceBaseUrl(nextValue));
      showToast("PMTagger 服务地址已保存", "success");
    });

    GM_registerMenuCommand("测试 PMTagger 服务连接", async () => {
      try {
        const config = getConfig();
        validateConfig(config);
        const health = await serviceRequestJson("GET", "/health", { config });
        showToast(`PMTagger 可用，设备 ${health.device || "unknown"}`, "success", 4500);
      } catch (error) {
        showToast(getErrorMessage(error), "error", 5500);
      }
    });
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${MENU_ID} {
        position: fixed;
        z-index: 2147483647;
        min-width: 180px;
        border: 2px solid #ef6ba6;
        background: #fff5fa;
        box-shadow: 8px 8px 0 rgba(239, 107, 166, 0.18);
        color: #642142;
        font: 13px/1.4 "Microsoft YaHei", "Segoe UI", sans-serif;
        display: none;
      }

      #${MENU_ID}.is-visible {
        display: block;
      }

      #${MENU_ID} button {
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        padding: 10px 12px;
        text-align: left;
        font: inherit;
        font-weight: 900;
        cursor: pointer;
      }

      #${MENU_ID} button:hover {
        background: #ffd7e8;
      }

      #${TOAST_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483647;
        min-width: 260px;
        max-width: 420px;
        padding: 12px 14px;
        color: #fff;
        background: rgba(30, 41, 59, 0.94);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
        font: 13px/1.5 "Microsoft YaHei", "Segoe UI", sans-serif;
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }

      #${TOAST_ID}.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${TOAST_ID}[data-type="success"] {
        background: rgba(22, 163, 74, 0.94);
      }

      #${TOAST_ID}[data-type="error"] {
        background: rgba(220, 38, 38, 0.95);
      }
    `;

    document.head.appendChild(style);
  }

  function ensureContextMenu() {
    let menu = document.getElementById(MENU_ID);
    if (menu) {
      return menu;
    }

    menu = document.createElement("div");
    menu.id = MENU_ID;

    const uploadButton = document.createElement("button");
    uploadButton.type = "button";
    uploadButton.textContent = "上传图片到 PMTagger";
    uploadButton.addEventListener("click", () => {
      hideContextMenu();
      uploadActiveImage().catch((error) => {
        showToast(getErrorMessage(error), "error", 6500);
      });
    });

    menu.appendChild(uploadButton);
    document.body.appendChild(menu);
    return menu;
  }

  function showContextMenu(x, y) {
    const menu = ensureContextMenu();
    menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 60)}px`;
    menu.classList.add("is-visible");
  }

  function hideContextMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu) {
      menu.classList.remove("is-visible");
    }
  }

  function ensureToast() {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.dataset.type = "info";
      document.body.appendChild(toast);
    }
    return toast;
  }

  function showToast(message, type = "info", duration = 3500) {
    const toast = ensureToast();
    toast.dataset.type = type;
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, duration);
  }

  function handleContextMenu(event) {
    const image = findImageFromTarget(event.target);
    if (!image) {
      hideContextMenu();
      return;
    }

    const imageUrl = resolveImageUrl(image);
    if (!imageUrl) {
      hideContextMenu();
      return;
    }

    activeImageUrl = imageUrl;
    activeImageAlt = image.getAttribute("alt") || image.getAttribute("title") || "";
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY);
  }

  function findImageFromTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    if (target instanceof HTMLImageElement) {
      return target;
    }

    return target.closest("img");
  }

  function resolveImageUrl(image) {
    const source =
      image.currentSrc ||
      image.src ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-original") ||
      "";
    if (!source) {
      return "";
    }

    try {
      return new URL(source, window.location.href).toString();
    } catch (_error) {
      return "";
    }
  }

  async function uploadActiveImage() {
    if (isUploading) {
      showToast("已有上传任务正在进行", "info");
      return;
    }

    if (!activeImageUrl) {
      throw new Error("没有可上传的图片");
    }

    const config = getConfig();
    validateConfig(config);

    try {
      isUploading = true;
      showToast("正在下载图片并发送到 PMTagger...", "info", 5000);
      const imageBuffer = await downloadBinary(activeImageUrl);
      const payload = {
        image_base64: arrayBufferToBase64(imageBuffer),
        filename: buildUploadFilename(activeImageUrl),
        tags: [],
      };

      const result = await serviceRequestJson("POST", "/api/v1/hydrus/upload/image", {
        config,
        body: payload,
      });

      if (!result || result.success === false) {
        throw new Error(result?.error || "PMTagger 上传失败");
      }

      const tagCount = Array.isArray(result.english_tags) ? result.english_tags.length : 0;
      showToast(`${getImportSummary(result.hydrus_status)}，写入 ${tagCount} 个标签`, "success", 6000);
    } finally {
      isUploading = false;
    }
  }

  function buildUploadFilename(imageUrl) {
    try {
      const url = new URL(imageUrl);
      const filename = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      if (filename) {
        return filename;
      }
    } catch (_error) {
      // 兜底到时间戳文件名。
    }
    return `pmimage-${Date.now()}.jpg`;
  }

  function validateConfig(config) {
    if (!config.serviceBaseUrl) {
      throw new Error("请先在油猴菜单中设置 PMTagger 服务地址");
    }
  }

  function downloadBinary(url) {
    return serviceCompatibleRequest({
      method: "GET",
      url,
      responseType: "arraybuffer",
    }).then((response) => response.response);
  }

  function serviceRequestJson(method, path, options = {}) {
    const config = options.config || getConfig();
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };

    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
    }

    return serviceCompatibleRequest({
      method,
      url: `${config.serviceBaseUrl}${path}`,
      headers,
      data: method === "GET" ? undefined : JSON.stringify(options.body || {}),
      responseType: "text",
    }).then((response) => parseJsonResponse(response.responseText));
  }

  function serviceCompatibleRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method,
        url: options.url,
        headers: options.headers,
        data: options.data,
        responseType: options.responseType,
        onload(response) {
          if (response && response.status >= 200 && response.status < 300) {
            resolve(response);
            return;
          }
          reject(new Error(extractResponseError(response)));
        },
        onerror() {
          reject(new Error(`请求失败：${options.url}`));
        },
        ontimeout() {
          reject(new Error(`请求超时：${options.url}`));
        },
      });
    });
  }

  function parseJsonResponse(text) {
    try {
      return text ? JSON.parse(text) : {};
    } catch (_error) {
      throw new Error("PMTagger 返回了无法解析的响应");
    }
  }

  function extractResponseError(response) {
    if (!response) {
      return "请求失败";
    }

    const prefix = `请求失败：HTTP ${response.status}`;
    if (!response.responseText) {
      return prefix;
    }

    try {
      const parsed = JSON.parse(response.responseText);
      if (parsed.detail) {
        return `${prefix} - ${parsed.detail}`;
      }
      if (parsed.error) {
        return `${prefix} - ${parsed.error}`;
      }
      if (parsed.note) {
        return `${prefix} - ${parsed.note}`;
      }
    } catch (_error) {
      return `${prefix} - ${String(response.responseText).slice(0, 200)}`;
    }

    return prefix;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }

  function getImportSummary(status) {
    if (Number(status) === 1) {
      return "文件已导入";
    }
    if (Number(status) === 2) {
      return "文件已存在，标签已补写";
    }
    return "操作完成";
  }

  function getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || "未知错误");
  }

  function init() {
    injectStyle();
    ensureContextMenu();
    registerMenu();
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("click", hideContextMenu, true);
    document.addEventListener("scroll", hideContextMenu, true);
    window.addEventListener("blur", hideContextMenu);
  }

  init();
})();
