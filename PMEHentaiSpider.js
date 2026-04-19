// ==UserScript==
// @name         PMEHentaiSpider
// @namespace    https://github.com/openai/codex-cli
// @version      0.1.0
// @description  在 e-hentai / exhentai 的 gallery 页面批量抓取整本画廊图片并发送到本地 PMTagger
// @author       OpenAI Codex
// @match        https://e-hentai.org/g/*
// @match        https://exhentai.org/g/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      e-hentai.org
// @connect      exhentai.org
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

  const STYLE_ID = "pmtagger-ehentai-style";
  const BUTTON_ID = "pmtagger-ehentai-gallery-button";
  const TOAST_ID = "pmtagger-ehentai-toast";
  const MAX_REQUEST_RETRY = 2;
  const BATCH_ITEM_TIMEOUT_MS = 60000;

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
        let message = `服务可用，设备 ${health.device || "unknown"}`;

        try {
          const connection = await serviceRequestJson("GET", "/api/v1/connections/check", { config });
          if (connection.hydrus_available) {
            message += "，Hydrus 已连接";
          } else if (connection.hydrus_error) {
            message += `，Hydrus 未连接：${connection.hydrus_error}`;
          }
        } catch (error) {
          console.warn("连接检测接口调用失败：", error);
        }

        showToast(message, "success", 5000);
      } catch (error) {
        showToast(getErrorMessage(error), "error", 5000);
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
      #${BUTTON_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 99999;
        border: 2px solid #d84f90;
        padding: 12px 18px;
        font-size: 14px;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(180deg, #f062a1, #d94a8d);
        box-shadow: 8px 8px 0 rgba(239, 107, 166, 0.18);
        cursor: pointer;
        font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      }

      #${BUTTON_ID}:hover:not([disabled]) {
        transform: translate(-1px, -1px);
        box-shadow: 10px 10px 0 rgba(239, 107, 166, 0.2);
      }

      #${BUTTON_ID}:active:not([disabled]) {
        transform: translate(1px, 1px);
        box-shadow: 4px 4px 0 rgba(239, 107, 166, 0.2);
      }

      #${BUTTON_ID}[disabled] {
        opacity: 0.7;
        cursor: wait;
        box-shadow: none;
      }

      #${TOAST_ID} {
        position: fixed;
        right: 20px;
        bottom: 76px;
        z-index: 100000;
        min-width: 260px;
        max-width: 460px;
        padding: 12px 14px;
        color: #fff;
        font-size: 13px;
        line-height: 1.5;
        border: 2px solid #ef6ba6;
        box-shadow: 8px 8px 0 rgba(239, 107, 166, 0.18);
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
        font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      }

      #${TOAST_ID}.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${TOAST_ID}[data-type="info"] {
        background: rgba(100, 33, 66, 0.94);
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

  function injectButton() {
    if (!isGalleryPage() || document.getElementById(BUTTON_ID)) {
      return;
    }

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "抓取整本 Gallery";
    button.addEventListener("click", handleBatchGrabClick);
    document.body.appendChild(button);
  }

  function setButtonLoading(loading, label = "") {
    const button = document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }
    button.disabled = loading;
    button.textContent = loading ? label || "抓取中..." : "抓取整本 Gallery";
  }

  function isGalleryPage() {
    return /^\/g\/\d+\/[a-z0-9]+\/?(?:\?.*)?$/i.test(window.location.pathname + window.location.search);
  }

  function validateConfig(config) {
    if (!config.serviceBaseUrl) {
      throw new Error("请先在油猴菜单中设置 PMTagger 服务地址");
    }
  }

  async function handleBatchGrabClick() {
    if (isUploading) {
      return;
    }

    if (!isGalleryPage()) {
      showToast("当前页面不是 gallery 页面", "error");
      return;
    }

    const config = getConfig();

    try {
      validateConfig(config);
      isUploading = true;
      setButtonLoading(true, "读取 Gallery...");
      showToast("正在分析 gallery 页面...", "info", 2500);

      const galleryInfo = await collectGalleryInfo(window.location.href);
      if (!galleryInfo.imagePageUrls.length) {
        throw new Error("当前 gallery 没有找到可抓取的图片页链接");
      }

      const confirmed = window.confirm(
        `画廊《${galleryInfo.title}》共找到 ${galleryInfo.imagePageUrls.length} 张图片，是否开始抓取并发送到 PMTagger？`
      );
      if (!confirmed) {
        showToast("已取消抓取", "info");
        return;
      }

      let importedCount = 0;
      let duplicateCount = 0;
      let failureCount = 0;
      const failures = [];

      for (let index = 0; index < galleryInfo.imagePageUrls.length; index += 1) {
        const imagePageUrl = galleryInfo.imagePageUrls[index];
        const progressLabel = `抓取中 ${index + 1}/${galleryInfo.imagePageUrls.length}`;
        setButtonLoading(true, progressLabel);
        showToast(`正在抓取 ${index + 1}/${galleryInfo.imagePageUrls.length}`, "info", 2000);

        try {
          const result = await withTimeout(
            importGalleryImage({
              config,
              galleryInfo,
              imagePageUrl,
              index,
            }),
            BATCH_ITEM_TIMEOUT_MS,
            `图片页超时，已跳过：${imagePageUrl}`
          );
          if (isDuplicateHydrusStatus(result.hydrus_status)) {
            duplicateCount += 1;
          } else {
            importedCount += 1;
          }
        } catch (error) {
          failureCount += 1;
          failures.push(`- ${imagePageUrl}：${getErrorMessage(error)}`);
          console.error(`e-hentai 抓取失败 ${imagePageUrl}:`, error);
        }
      }

      const successCount = importedCount + duplicateCount;
      if (!successCount) {
        throw new Error(
          `整本抓取失败，共 ${failureCount} 张失败${failures.length ? `\n${failures.join("\n")}` : ""}`
        );
      }

      showToast(
        failureCount
          ? `抓取完成：新导入 ${importedCount} 张，重复 ${duplicateCount} 张，失败 ${failureCount} 张`
          : `抓取完成：新导入 ${importedCount} 张，重复 ${duplicateCount} 张`,
        failureCount ? "info" : "success",
        7000
      );
    } catch (error) {
      showToast(getErrorMessage(error), "error", 8000);
    } finally {
      isUploading = false;
      setButtonLoading(false);
    }
  }

  async function collectGalleryInfo(currentUrl) {
    const galleryUrl = normalizeGalleryUrl(currentUrl);
    const firstDocument = document;
    const title = extractGalleryTitle(firstDocument);
    const totalPages = getGalleryPageCount(firstDocument);
    const imagePageUrlSet = new Set(extractImagePageUrls(firstDocument, galleryUrl));

    for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
      const pageUrl = buildGalleryPageUrl(galleryUrl, pageIndex);
      const pageDocument = await fetchHtmlDocument(pageUrl);
      for (const imagePageUrl of extractImagePageUrls(pageDocument, galleryUrl)) {
        imagePageUrlSet.add(imagePageUrl);
      }
    }

    return {
      title,
      galleryUrl,
      imagePageUrls: Array.from(imagePageUrlSet),
    };
  }

  function extractGalleryTitle(doc) {
    const heading = doc.querySelector("h1#gn");
    if (heading?.textContent?.trim()) {
      return heading.textContent.trim();
    }

    const fallbackHeading =
      doc.querySelector("#gj") ||
      doc.querySelector("h1");
    return fallbackHeading?.textContent?.trim() || "未命名 Gallery";
  }

  function normalizeGalleryUrl(url) {
    const normalized = new URL(url, window.location.origin);
    normalized.search = "";
    normalized.hash = "";
    return normalized.toString().replace(/\/+$/, "/");
  }

  function buildGalleryPageUrl(galleryUrl, pageIndex) {
    const url = new URL(galleryUrl);
    if (pageIndex > 0) {
      url.searchParams.set("p", String(pageIndex));
    }
    return url.toString();
  }

  function getGalleryPageCount(doc) {
    const pageUrls = Array.from(doc.querySelectorAll(".ptt a[href], .ptb a[href]"))
      .map((anchor) => anchor.getAttribute("href") || "")
      .filter((href) => href.includes("/g/"));

    let maxPageIndex = 0;
    for (const href of pageUrls) {
      try {
        const url = new URL(href, window.location.origin);
        const pageValue = Number(url.searchParams.get("p") || "0");
        if (Number.isFinite(pageValue)) {
          maxPageIndex = Math.max(maxPageIndex, pageValue);
        }
      } catch (_error) {
        // 忽略无法解析的分页链接。
      }
    }
    return maxPageIndex + 1;
  }

  function extractImagePageUrls(doc, galleryUrl) {
    const anchors = Array.from(doc.querySelectorAll("#gdt a[href]"));
    return anchors
      .map((anchor) => anchor.getAttribute("href") || "")
      .filter((href) => /\/s\/[a-z0-9]+\/\d+-\d+/i.test(href))
      .map((href) => new URL(href, galleryUrl).toString());
  }

  async function importGalleryImage({ config, galleryInfo, imagePageUrl, index }) {
    const imagePageDocument = await retryRequest(
      () => fetchHtmlDocument(imagePageUrl),
      `读取图片页失败：${imagePageUrl}`
    );
    const imageUrl = extractOriginalImageUrl(imagePageDocument, imagePageUrl);
    const imageBuffer = await retryRequest(
      () => downloadBinary(imageUrl),
      `下载图片失败：${imageUrl}`
    );

    const payload = {
      image_base64: arrayBufferToBase64(imageBuffer),
      filename: buildUploadFilename(imageUrl, index + 1),
      tags: [],
      extra_tags: buildGalleryTags(galleryInfo),
      source_urls: buildSourceUrls(galleryInfo.galleryUrl, imagePageUrl, imageUrl),
    };

    const result = await serviceRequestJson("POST", "/api/v1/hydrus/upload/image", {
      config,
      body: payload,
    });

    if (!result || result.success === false) {
      throw new Error(result?.error || "PMTagger 上传失败");
    }

    return result;
  }

  function extractOriginalImageUrl(doc, imagePageUrl) {
    const directImage =
      doc.querySelector("#img") ||
      doc.querySelector("#i3 img") ||
      doc.querySelector("img#img");

    const source = directImage?.getAttribute("src") || "";
    if (!source) {
      throw new Error(`图片页没有找到可下载的图片：${imagePageUrl}`);
    }

    return new URL(source, imagePageUrl).toString();
  }

  function buildUploadFilename(imageUrl, index) {
    try {
      const url = new URL(imageUrl);
      const rawName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
      if (rawName) {
        return rawName;
      }
    } catch (_error) {
      // 兜底到序号文件名。
    }
    return `ehentai-${index}.jpg`;
  }

  function buildSourceUrls(galleryUrl, imagePageUrl, imageUrl) {
    return [...new Set([galleryUrl, imagePageUrl, imageUrl].filter(Boolean))];
  }

  function buildGalleryTags(galleryInfo) {
    const galleryNameTag = buildGalleryNameTag(galleryInfo?.title);
    return galleryNameTag ? [galleryNameTag] : [];
  }

  function buildGalleryNameTag(title) {
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) {
      return "";
    }
    return `gallery:${normalizedTitle}`;
  }

  async function fetchHtmlDocument(url) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`页面读取失败：HTTP ${response.status}`);
    }

    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function retryRequest(task, errorPrefix) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_REQUEST_RETRY; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`${errorPrefix} - ${getErrorMessage(lastError)}`);
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
      throw new Error("服务返回了无法解析的响应");
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

  function withTimeout(taskPromise, timeoutMs, timeoutMessage) {
    let timerId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = window.setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });

    return Promise.race([taskPromise, timeoutPromise]).finally(() => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    });
  }

  function getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || "未知错误");
  }

  function isDuplicateHydrusStatus(status) {
    return Number(status) === 2;
  }

  function init() {
    injectStyle();
    injectButton();
    registerMenu();
  }

  init();
})();
