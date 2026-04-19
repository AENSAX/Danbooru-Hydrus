// ==UserScript==
// @name         PMDanBooruSpider
// @namespace    https://github.com/openai/codex-cli
// @version      0.2.0
// @description  在 Danbooru 帖子页和列表页将图片与标签发送到本地 PMTagger 服务，再由服务上传到 Hydrus
// @author       OpenAI Codex
// @match        https://danbooru.donmai.us/posts*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      danbooru.donmai.us
// @connect      cdn.donmai.us
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

  const STYLE_ID = "pmtagger-danbooru-uploader-style";
  const BUTTON_ID = "pmtagger-danbooru-uploader-button";
  const BATCH_BUTTON_ID = "pmtagger-danbooru-batch-button";
  const TOAST_ID = "pmtagger-danbooru-uploader-toast";

  let isUploading = false;
  let uiObserver = null;

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
            message += `，Hydrus 已连接`;
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
        border: 2px solid #ef6ba6;
        padding: 12px 18px;
        font-size: 14px;
        font-weight: 700;
        color: #7a214d;
        background: #fff5fa;
        box-shadow: 8px 8px 0 rgba(239, 107, 166, 0.18);
        cursor: pointer;
        font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      }

      #${BATCH_BUTTON_ID} {
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

      #${BUTTON_ID}:hover:not([disabled]),
      #${BATCH_BUTTON_ID}:hover:not([disabled]) {
        transform: translate(-1px, -1px);
        box-shadow: 10px 10px 0 rgba(239, 107, 166, 0.2);
      }

      #${BUTTON_ID}:active:not([disabled]),
      #${BATCH_BUTTON_ID}:active:not([disabled]) {
        transform: translate(1px, 1px);
        box-shadow: 4px 4px 0 rgba(239, 107, 166, 0.2);
      }

      #${BUTTON_ID}[disabled],
      #${BATCH_BUTTON_ID}[disabled] {
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
        max-width: 420px;
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

  function injectButton() {
    if (!isPostShowPage() || document.getElementById(BUTTON_ID)) {
      return;
    }

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "传送到 PMTagger";
    button.addEventListener("click", handleUploadClick);
    document.body.appendChild(button);
  }

  function injectBatchButton() {
    if (!isPostIndexPage() || document.getElementById(BATCH_BUTTON_ID)) {
      return;
    }

    const button = document.createElement("button");
    button.id = BATCH_BUTTON_ID;
    button.type = "button";
    button.textContent = "批量导入本页";
    button.addEventListener("click", handleBatchUploadClick);
    document.body.appendChild(button);
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

  function showToast(message, type = "info", duration = 3000) {
    const toast = ensureToast();
    toast.dataset.type = type;
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, duration);
  }

  function setButtonLoading(loading) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }
    button.disabled = loading;
    button.textContent = loading ? "上传中..." : "传送到 PMTagger";
  }

  function setBatchButtonLoading(loading) {
    const button = document.getElementById(BATCH_BUTTON_ID);
    if (!button) {
      return;
    }

    button.disabled = loading;
    button.textContent = loading ? "批量导入中..." : "批量导入本页";
  }

  function validateConfig(config) {
    if (!config.serviceBaseUrl) {
      throw new Error("请先在油猴菜单中设置 PMTagger 服务地址");
    }
  }

  function getCurrentPostId() {
    const match = window.location.pathname.match(/^\/posts\/(\d+)/);
    return match ? match[1] : null;
  }

  function isPostShowPage() {
    return /^\/posts\/\d+(?:\/|$)/.test(window.location.pathname);
  }

  function isPostIndexPage() {
    return /^\/posts\/?$/.test(window.location.pathname) && !getCurrentPostId();
  }

  async function handleUploadClick() {
    if (isUploading) {
      return;
    }

    const postId = getCurrentPostId();
    if (!postId) {
      showToast("当前页面不是 Danbooru 帖子页", "error");
      return;
    }

    const config = getConfig();

    try {
      validateConfig(config);
      isUploading = true;
      setButtonLoading(true);
      const post = await fetchDanbooruPost(postId);
      const result = await importDanbooruPost(post, config);
      showToast(`${result.summary}，服务收到 ${result.tagCount} 个标签`, "success", 5000);
    } catch (error) {
      showToast(getErrorMessage(error), "error", 6000);
    } finally {
      isUploading = false;
      setButtonLoading(false);
    }
  }

  async function handleBatchUploadClick() {
    if (isUploading) {
      return;
    }

    if (!isPostIndexPage()) {
      showToast("当前页面不是 Danbooru 列表页", "error");
      return;
    }

    const config = getConfig();

    try {
      validateConfig(config);
      isUploading = true;
      setBatchButtonLoading(true);
      showToast("正在读取当前页帖子列表...", "info");

      const posts = await fetchDanbooruPostsForCurrentPage();
      if (!posts.length) {
        throw new Error("当前页没有可导入的帖子");
      }

      const confirmed = window.confirm(`当前页共 ${posts.length} 张图片，是否开始批量导入？`);
      if (!confirmed) {
        showToast("已取消批量导入", "info");
        return;
      }

      let successCount = 0;
      let failureCount = 0;

      for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];
        const progress = `${index + 1}/${posts.length}`;
        showToast(`正在批量导入 ${progress}（post #${post.id}）...`, "info", 2500);

        try {
          await importDanbooruPost(post, config);
          successCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error(`批量导入失败 post #${post.id}:`, error);
        }
      }

      if (!successCount) {
        throw new Error(`批量导入失败，本页 ${failureCount} 张图片均未成功`);
      }

      showToast(
        `批量导入完成：成功 ${successCount} 张，失败 ${failureCount} 张`,
        failureCount ? "info" : "success",
        6000
      );
    } catch (error) {
      showToast(getErrorMessage(error), "error", 6000);
    } finally {
      isUploading = false;
      setBatchButtonLoading(false);
    }
  }

  async function fetchDanbooruPost(postId) {
    const response = await fetch(`/posts/${postId}.json`, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Danbooru 帖子信息读取失败：HTTP ${response.status}`);
    }

    return response.json();
  }

  async function fetchDanbooruPostsForCurrentPage() {
    const apiUrl = new URL("/posts.json", window.location.origin);
    const currentUrl = new URL(window.location.href);

    currentUrl.searchParams.forEach((value, key) => {
      apiUrl.searchParams.append(key, value);
    });

    const response = await fetch(apiUrl.toString(), {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Danbooru 列表读取失败：HTTP ${response.status}`);
    }

    const posts = await response.json();
    return Array.isArray(posts) ? posts : [];
  }

  function getPostFileUrl(post) {
    const fileUrl = post.file_url || post.large_file_url;
    if (!fileUrl) {
      throw new Error("当前帖子没有可导入的原图地址");
    }
    return fileUrl;
  }

  async function importDanbooruPost(post, config) {
    const fileUrl = getPostFileUrl(post);
    const fileBuffer = await downloadBinary(fileUrl);
    const tags = buildHydrusTags(post);
    const payload = {
      image_base64: arrayBufferToBase64(fileBuffer),
      filename: buildUploadFilename(post, fileUrl),
      tags,
    };

    const result = await serviceRequestJson("POST", "/api/v1/hydrus/upload/image", {
      config,
      body: payload,
    });

    if (!result || result.success === false) {
      throw new Error(result?.error || "PMTagger 服务上传失败");
    }

    return {
      hash: result.hydrus_hash || null,
      tagCount: Array.isArray(result.english_tags) ? result.english_tags.length : tags.length,
      summary: getImportSummary(result.hydrus_status),
    };
  }

  function buildUploadFilename(post, fileUrl) {
    const url = new URL(fileUrl, window.location.origin);
    const pathname = url.pathname || "";
    const pathParts = pathname.split("/");
    const originalName = pathParts[pathParts.length - 1] || "";
    if (originalName) {
      return originalName;
    }

    const extension = post?.file_ext ? `.${post.file_ext}` : "";
    return `${post?.id || "danbooru-post"}${extension}`;
  }

  function splitTagString(value) {
    return String(value || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function buildHydrusTags(post) {
    const tags = [
      ...splitTagString(post.tag_string_general),
      ...prefixTags(splitTagString(post.tag_string_artist), "artist"),
      ...prefixTags(splitTagString(post.tag_string_character), "character"),
      ...prefixTags(splitTagString(post.tag_string_copyright), "series"),
      ...prefixTags(splitTagString(post.tag_string_species), "species"),
      ...prefixTags(splitTagString(post.tag_string_lore), "lore"),
      ...splitTagString(post.tag_string_meta),
    ];

    if (!post.tag_string_general && post.tag_string) {
      tags.push(...splitTagString(post.tag_string));
    }

    if (post.rating) {
      tags.push(`rating:${mapRating(post.rating)}`);
    }

    if (post.id) {
      tags.push(`danbooru:${post.id}`);
    }

    return dedupeTags(tags);
  }

  function prefixTags(tags, namespace) {
    return tags.map((tag) => `${namespace}:${tag}`);
  }

  function dedupeTags(tags) {
    return [...new Set(tags.filter(Boolean).map((tag) => String(tag).trim()).filter(Boolean))];
  }

  function mapRating(rating) {
    const value = String(rating || "").toLowerCase();
    if (value === "s") {
      return "safe";
    }
    if (value === "q") {
      return "questionable";
    }
    if (value === "e") {
      return "explicit";
    }
    return value || "unknown";
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

  function renderUi() {
    injectStyle();
    injectButton();
    injectBatchButton();
  }

  function observeUi() {
    if (uiObserver || !document.body) {
      return;
    }

    uiObserver = new MutationObserver(() => {
      renderUi();
    });

    uiObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function init() {
    renderUi();
    observeUi();
    registerMenu();
  }

  init();
})();
