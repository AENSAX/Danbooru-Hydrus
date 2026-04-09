// ==UserScript==
// @name         Danbooru -> Hydrus
// @namespace    https://github.com/openai/codex-cli
// @version      0.1.0
// @description  在 Danbooru 帖子页和列表页将图片与标签发送到本地 Hydrus
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
  'use strict';

  const STORAGE_KEYS = {
    apiBaseUrl: 'hydrus_api_base_url',
    accessKey: 'hydrus_access_key',
    tagServiceName: 'hydrus_tag_service_name',
    translationCsvUrl: 'hydrus_translation_csv_url',
    replaceExistingOnDuplicate: 'hydrus_replace_existing_on_duplicate',
  };

  const DEFAULT_CONFIG = {
    apiBaseUrl: 'http://127.0.0.1:45869',
    accessKey: '',
    tagServiceName: 'my tags',
    translationCsvUrl: '',
    replaceExistingOnDuplicate: false,
  };

  const STYLE_ID = 'hydrus-danbooru-uploader-style';
  const BUTTON_ID = 'hydrus-danbooru-uploader-button';
  const BATCH_BUTTON_ID = 'hydrus-danbooru-batch-button';
  const TOAST_ID = 'hydrus-danbooru-uploader-toast';

  let isUploading = false;
  const translationMapCache = new Map();
  const tagServiceKeyCache = new Map();
  let uiObserver = null;

  function getConfig() {
    return {
      apiBaseUrl: normalizeApiBaseUrl(GM_getValue(STORAGE_KEYS.apiBaseUrl, DEFAULT_CONFIG.apiBaseUrl)),
      accessKey: String(GM_getValue(STORAGE_KEYS.accessKey, DEFAULT_CONFIG.accessKey)).trim(),
      tagServiceName: String(GM_getValue(STORAGE_KEYS.tagServiceName, DEFAULT_CONFIG.tagServiceName)).trim() || DEFAULT_CONFIG.tagServiceName,
      translationCsvUrl: normalizeTranslationSourceUrl(GM_getValue(STORAGE_KEYS.translationCsvUrl, DEFAULT_CONFIG.translationCsvUrl)),
      replaceExistingOnDuplicate: Boolean(GM_getValue(STORAGE_KEYS.replaceExistingOnDuplicate, DEFAULT_CONFIG.replaceExistingOnDuplicate)),
    };
  }

  function normalizeApiBaseUrl(value) {
    return String(value || DEFAULT_CONFIG.apiBaseUrl).trim().replace(/\/+$/, '');
  }

  function normalizeTranslationSourceUrl(value) {
    return String(value || '').trim();
  }

  function setConfigValue(key, value) {
    GM_setValue(key, value);
  }

  function registerMenu() {
    GM_registerMenuCommand('设置 Hydrus API 地址', () => {
      const currentConfig = getConfig();
      const nextValue = window.prompt('输入 Hydrus Client API 地址：', currentConfig.apiBaseUrl);
      if (nextValue === null) {
        return;
      }
      setConfigValue(STORAGE_KEYS.apiBaseUrl, normalizeApiBaseUrl(nextValue));
      showToast('Hydrus API 地址已保存', 'success');
    });

    GM_registerMenuCommand('设置 Access Key', () => {
      const currentConfig = getConfig();
      const nextValue = window.prompt('输入 Hydrus Client API Access Key：', currentConfig.accessKey);
      if (nextValue === null) {
        return;
      }
      setConfigValue(STORAGE_KEYS.accessKey, String(nextValue).trim());
      showToast('Access Key 已保存', 'success');
    });

    GM_registerMenuCommand('设置标签服务名', () => {
      const currentConfig = getConfig();
      const nextValue = window.prompt('输入 Hydrus 标签服务名：', currentConfig.tagServiceName);
      if (nextValue === null) {
        return;
      }
      setConfigValue(STORAGE_KEYS.tagServiceName, String(nextValue).trim() || DEFAULT_CONFIG.tagServiceName);
      showToast('标签服务名已保存', 'success');
    });

    GM_registerMenuCommand('设置标签翻译地址', () => {
      const currentConfig = getConfig();
      const nextValue = window.prompt('输入标签翻译 CSV 链接（例如 http://127.0.0.1:8765/translations.csv，留空则关闭翻译）：', currentConfig.translationCsvUrl);
      if (nextValue === null) {
        return;
      }

      const normalizedValue = normalizeTranslationSourceUrl(nextValue);
      setConfigValue(STORAGE_KEYS.translationCsvUrl, normalizedValue);
      showToast(normalizedValue ? '标签翻译地址已保存' : '已关闭标签翻译', 'success');
    });

    GM_registerMenuCommand(`切换重复文件覆盖重传（当前：${getConfig().replaceExistingOnDuplicate ? '开' : '关'}）`, () => {
      const currentConfig = getConfig();
      const nextValue = !currentConfig.replaceExistingOnDuplicate;
      setConfigValue(STORAGE_KEYS.replaceExistingOnDuplicate, nextValue);
      showToast(nextValue ? '已开启重复文件覆盖重传' : '已关闭重复文件覆盖重传', 'success');
    });

    GM_registerMenuCommand('测试 Hydrus 连接', async () => {
      try {
        const config = getConfig();
        validateConfig(config);
        const result = await hydrusRequestJson('GET', '/api_version', { config });
        showToast(`Hydrus 已连接，API 版本 ${result.version}`, 'success');
      } catch (error) {
        showToast(getErrorMessage(error), 'error', 5000);
      }
    });
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 99999;
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        font-size: 14px;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(135deg, #4f46e5, #7c3aed);
        box-shadow: 0 10px 25px rgba(79, 70, 229, 0.35);
        cursor: pointer;
      }

      #${BATCH_BUTTON_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 99999;
        border: none;
        border-radius: 999px;
        padding: 12px 18px;
        font-size: 14px;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(135deg, #0f766e, #0ea5e9);
        box-shadow: 0 10px 25px rgba(14, 165, 233, 0.35);
        cursor: pointer;
      }

      #${BUTTON_ID}[disabled],
      #${BATCH_BUTTON_ID}[disabled] {
        opacity: 0.7;
        cursor: wait;
      }

      #${TOAST_ID} {
        position: fixed;
        right: 20px;
        bottom: 76px;
        z-index: 100000;
        min-width: 260px;
        max-width: 420px;
        padding: 12px 14px;
        border-radius: 12px;
        color: #fff;
        font-size: 13px;
        line-height: 1.5;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }

      #${TOAST_ID}.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${TOAST_ID}[data-type="info"] {
        background: rgba(30, 41, 59, 0.92);
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
    if (!isPostShowPage()) {
      return;
    }

    if (document.getElementById(BUTTON_ID)) {
      return;
    }

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '传送到 Hydrus';
    button.addEventListener('click', handleUploadClick);
    document.body.appendChild(button);
  }

  function injectBatchButton() {
    if (!isPostIndexPage()) {
      return;
    }

    if (document.getElementById(BATCH_BUTTON_ID)) {
      return;
    }

    const button = document.createElement('button');
    button.id = BATCH_BUTTON_ID;
    button.type = 'button';
    button.textContent = '批量导入本页';
    button.addEventListener('click', handleBatchUploadClick);
    document.body.appendChild(button);
  }

  function ensureToast() {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.dataset.type = 'info';
      document.body.appendChild(toast);
    }
    return toast;
  }

  function showToast(message, type = 'info', duration = 3000) {
    const toast = ensureToast();
    toast.dataset.type = type;
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.classList.remove('is-visible');
    }, duration);
  }

  function setButtonLoading(loading) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }
    button.disabled = loading;
    button.textContent = loading ? '上传中...' : '传送到 Hydrus';
  }

  function setBatchButtonLoading(loading) {
    const button = document.getElementById(BATCH_BUTTON_ID);
    if (!button) {
      return;
    }

    button.disabled = loading;
    button.textContent = loading ? '批量导入中...' : '批量导入本页';
  }

  function validateConfig(config) {
    if (!config.accessKey) {
      throw new Error('请先在油猴菜单中设置 Hydrus Access Key');
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
      showToast('当前页面不是 Danbooru 帖子页', 'error');
      return;
    }

    const config = getConfig();

    try {
      validateConfig(config);
      isUploading = true;
      setButtonLoading(true);
      const post = await fetchDanbooruPost(postId);
      const result = await importDanbooruPost(post, config, {
        pageUrl: window.location.href,
      });
      showToast(`${result.summary}，已写入 ${result.tagCount} 个标签`, 'success', 5000);
    } catch (error) {
      showToast(getErrorMessage(error), 'error', 6000);
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
      showToast('当前页面不是 Danbooru 列表页', 'error');
      return;
    }

    const config = getConfig();

    try {
      validateConfig(config);
      isUploading = true;
      setBatchButtonLoading(true);
      showToast('正在读取当前页帖子列表...', 'info');

      const posts = await fetchDanbooruPostsForCurrentPage();
      if (!posts.length) {
        throw new Error('当前页没有可导入的帖子');
      }

      const confirmed = window.confirm(`当前页共 ${posts.length} 张图片，是否开始批量导入？`);
      if (!confirmed) {
        showToast('已取消批量导入', 'info');
        return;
      }

      let successCount = 0;
      let failureCount = 0;

      for (let index = 0; index < posts.length; index += 1) {
        const post = posts[index];
        const progress = `${index + 1}/${posts.length}`;
        showToast(`正在批量导入 ${progress}（post #${post.id}）...`, 'info', 2500);

        try {
          await importDanbooruPost(post, config, {
            pageUrl: `${window.location.origin}/posts/${post.id}`,
          });
          successCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error(`批量导入失败 post #${post.id}:`, error);
        }
      }

      if (!successCount) {
        throw new Error(`批量导入失败，本页 ${failureCount} 张图片均未成功`);
      }

      showToast(`批量导入完成：成功 ${successCount} 张，失败 ${failureCount} 张`, failureCount ? 'info' : 'success', 6000);
    } catch (error) {
      showToast(getErrorMessage(error), 'error', 6000);
    } finally {
      isUploading = false;
      setBatchButtonLoading(false);
    }
  }

  async function fetchDanbooruPost(postId) {
    const response = await fetch(`/posts/${postId}.json`, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Danbooru 帖子信息读取失败：HTTP ${response.status}`);
    }

    return response.json();
  }

  async function fetchDanbooruPostsForCurrentPage() {
    const apiUrl = new URL('/posts.json', window.location.origin);
    const currentUrl = new URL(window.location.href);

    currentUrl.searchParams.forEach((value, key) => {
      apiUrl.searchParams.append(key, value);
    });

    const response = await fetch(apiUrl.toString(), {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
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
      throw new Error('当前帖子没有可导入的原图地址');
    }
    return fileUrl;
  }

  async function importDanbooruPost(post, config, options = {}) {
    const pageUrl = options.pageUrl || (post?.id ? `${window.location.origin}/posts/${post.id}` : window.location.href);
    const fileUrl = getPostFileUrl(post);
    const fileBuffer = await downloadBinary(fileUrl);
    const rawTags = buildHydrusTags(post);
    const translatedTags = await applyTagTranslations(rawTags, config);
    const cleanTags = await hydrusCleanTags(translatedTags, config);
    const tagServiceKey = await hydrusResolveTagServiceKey(config);

    const importResult = await hydrusUploadFileWithRecovery(fileBuffer, config);
    ensureImportSucceeded(importResult);

    const hash = importResult.hash;
    await hydrusAddTags(hash, cleanTags, tagServiceKey, config);
    await hydrusAssociateUrls(hash, [pageUrl, fileUrl], config);

    return {
      hash,
      tagCount: cleanTags.length,
      summary: getImportSummary(importResult.status),
    };
  }

  function splitTagString(value) {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function buildHydrusTags(post) {
    const tags = [
      ...splitTagString(post.tag_string_general),
      ...prefixTags(splitTagString(post.tag_string_artist), 'artist'),
      ...prefixTags(splitTagString(post.tag_string_character), 'character'),
      ...prefixTags(splitTagString(post.tag_string_copyright), 'series'),
      ...prefixTags(splitTagString(post.tag_string_species), 'species'),
      ...prefixTags(splitTagString(post.tag_string_lore), 'lore'),
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
    const value = String(rating || '').toLowerCase();
    if (value === 's') {
      return 'safe';
    }
    if (value === 'q') {
      return 'questionable';
    }
    if (value === 'e') {
      return 'explicit';
    }
    return value || 'unknown';
  }

  async function applyTagTranslations(tags, config) {
    if (!tags.length || !config.translationCsvUrl) {
      return tags;
    }

    const translationMap = await loadTranslationMap(config.translationCsvUrl);
    if (!translationMap.size) {
      return tags;
    }

    return dedupeTags(tags.map((tag) => appendTagTranslation(tag, resolveTagTranslation(tag, translationMap))));
  }

  function appendTagTranslation(tag, translation) {
    const normalizedTag = String(tag || '').trim();
    const normalizedTranslation = String(translation || '').trim();

    if (!normalizedTag || !normalizedTranslation || normalizedTranslation === normalizedTag) {
      return normalizedTag;
    }

    return `${normalizedTag} ${normalizedTranslation}`;
  }

  function resolveTagTranslation(tag, translationMap) {
    const normalizedTag = String(tag || '').trim();
    if (!normalizedTag) {
      return '';
    }

    if (translationMap.has(normalizedTag)) {
      return translationMap.get(normalizedTag);
    }

    const namespaceIndex = normalizedTag.indexOf(':');
    if (namespaceIndex > 0) {
      const plainTag = normalizedTag.slice(namespaceIndex + 1);
      if (translationMap.has(plainTag)) {
        return translationMap.get(plainTag);
      }
    }

    return '';
  }

  async function loadTranslationMap(csvUrl) {
    if (translationMapCache.has(csvUrl)) {
      return translationMapCache.get(csvUrl);
    }

    const response = await gmRequest({
      method: 'GET',
      url: csvUrl,
      headers: {
        Accept: 'text/csv, text/plain, */*',
      },
      responseType: 'text',
    });

    const translationMap = parseTranslationCsv(response.responseText || response.response || '');
    translationMapCache.set(csvUrl, translationMap);
    return translationMap;
  }

  function parseTranslationCsv(text) {
    const map = new Map();
    const rows = parseCsvRows(text);

    rows.forEach((row) => {
      if (!Array.isArray(row) || row.length < 3) {
        return;
      }

      const sourceTag = String(row[0] || '').trim();
      const separator = String(row[1] || '').trim();
      const translatedTag = String(row[2] || '').trim();

      if (!sourceTag || !translatedTag || separator !== '0') {
        return;
      }

      map.set(sourceTag, translatedTag);
    });

    return map;
  }

  function parseCsvRows(text) {
    const input = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];

      if (inQuotes) {
        if (char === '"') {
          if (input[index + 1] === '"') {
            currentCell += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          currentCell += char;
        }
        continue;
      }

      if (char === '"') {
        inQuotes = true;
        continue;
      }

      if (char === ',') {
        currentRow.push(currentCell);
        currentCell = '';
        continue;
      }

      if (char === '\n' || char === '\r') {
        if (char === '\r' && input[index + 1] === '\n') {
          index += 1;
        }

        currentRow.push(currentCell);
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
        continue;
      }

      currentCell += char;
    }

    if (currentCell || currentRow.length) {
      currentRow.push(currentCell);
      rows.push(currentRow);
    }

    return rows;
  }

  function downloadBinary(url) {
    return gmRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
    }).then((response) => response.response);
  }

  async function hydrusCleanTags(tags, config) {
    if (!tags.length) {
      return [];
    }

    const query = new URLSearchParams({
      tags: JSON.stringify(tags),
    });

    const result = await hydrusRequestJson('GET', `/add_tags/clean_tags?${query.toString()}`, { config });
    return Array.isArray(result.tags) ? result.tags : tags;
  }

  async function hydrusResolveTagServiceKey(config) {
    const cacheKey = `${config.apiBaseUrl}::${config.tagServiceName}`;
    if (tagServiceKeyCache.has(cacheKey)) {
      return tagServiceKeyCache.get(cacheKey);
    }

    const query = new URLSearchParams({
      service_name: config.tagServiceName,
    });

    const result = await hydrusRequestJson('GET', `/get_service?${query.toString()}`, { config });
    const serviceKey = result?.service?.service_key;

    if (!serviceKey) {
      throw new Error(`找不到标签服务：${config.tagServiceName}`);
    }

    tagServiceKeyCache.set(cacheKey, serviceKey);
    return serviceKey;
  }

  async function hydrusUploadFile(fileBuffer, config) {
    const response = await gmRequest({
      method: 'POST',
      url: `${config.apiBaseUrl}/add_files/add_file`,
      headers: {
        'Content-Type': 'application/octet-stream',
        Accept: 'application/json',
        'Hydrus-Client-API-Access-Key': config.accessKey,
      },
      data: fileBuffer,
      responseType: 'text',
    });

    return parseJsonResponse(response.responseText);
  }

  async function hydrusUploadFileWithRecovery(fileBuffer, config) {
    let importResult = await hydrusUploadFile(fileBuffer, config);

    if (Number(importResult?.status) === 3) {
      importResult = await hydrusRetryDeletedUpload(importResult, fileBuffer, config);
    }

    if (Number(importResult?.status) === 2 && config.replaceExistingOnDuplicate) {
      importResult = await hydrusReplaceExistingDuplicate(importResult, fileBuffer, config);

      if (Number(importResult?.status) === 3) {
        importResult = await hydrusRetryDeletedUpload(importResult, fileBuffer, config);
      }
    }

    return importResult;
  }

  async function hydrusRetryDeletedUpload(importResult, fileBuffer, config) {
    const hash = String(importResult?.hash || '').trim();
    if (!hash) {
      return importResult;
    }

    showToast('检测到文件曾被物理删除，正在清除删除记录并重试...', 'info', 4500);
    await hydrusClearFileDeletionRecord(hash, config);
    return hydrusUploadFile(fileBuffer, config);
  }

  async function hydrusReplaceExistingDuplicate(importResult, fileBuffer, config) {
    const hash = String(importResult?.hash || '').trim();
    if (!hash) {
      return importResult;
    }

    showToast('检测到重复文件，正在删除旧文件并重传...', 'info', 4500);
    await hydrusDeletePhysicalFile(hash, config);
    await hydrusClearFileDeletionRecord(hash, config);
    return hydrusUploadFile(fileBuffer, config);
  }

  async function hydrusClearFileDeletionRecord(hash, config) {
    if (!hash) {
      throw new Error('清除删除记录失败：缺少文件哈希');
    }

    await hydrusRequestJson('POST', '/add_files/clear_file_deletion_record', {
      config,
      body: {
        hash,
      },
    });
  }

  async function hydrusDeletePhysicalFile(hash, config) {
    if (!hash) {
      throw new Error('删除旧文件失败：缺少文件哈希');
    }

    await hydrusRequestJson('POST', '/add_files/delete_files', {
      config,
      body: {
        hash,
        file_service_name: 'hydrus local file storage',
        reason: 'reimport duplicate from Danbooru uploader',
      },
    });
  }

  function ensureImportSucceeded(importResult) {
    const status = Number(importResult?.status);

    if (status === 1 || status === 2) {
      return;
    }

    if (status === 3) {
      throw new Error('Hydrus 仍然记录该文件曾被删除，自动重试失败，请检查客户端删除记录状态');
    }

    if (status === 7) {
      throw new Error(`Hydrus 拒绝导入：${importResult.note || '命中文件导入规则'}`);
    }

    throw new Error(`Hydrus 导入失败：${importResult?.note || '未知错误'}`);
  }

  async function hydrusAddTags(hash, tags, tagServiceKey, config) {
    if (!hash || !tags.length) {
      return;
    }

    await hydrusRequestJson('POST', '/add_tags/add_tags', {
      config,
      body: {
        hash,
        service_keys_to_tags: {
          [tagServiceKey]: tags,
        },
      },
    });
  }

  async function hydrusAssociateUrls(hash, urls, config) {
    const validUrls = [...new Set(urls.filter(Boolean))];
    if (!hash || !validUrls.length) {
      return;
    }

    await hydrusRequestJson('POST', '/add_urls/associate_url', {
      config,
      body: {
        hash,
        urls_to_add: validUrls,
      },
    });
  }

  async function hydrusRequestJson(method, path, options = {}) {
    const config = options.config || getConfig();
    const headers = {
      Accept: 'application/json',
      'Hydrus-Client-API-Access-Key': config.accessKey,
      ...(options.headers || {}),
    };

    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }

    const response = await gmRequest({
      method,
      url: `${config.apiBaseUrl}${path}`,
      headers,
      data: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
      responseType: 'text',
    });

    return parseJsonResponse(response.responseText);
  }

  function parseJsonResponse(text) {
    try {
      return text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error('Hydrus 返回了无法解析的响应');
    }
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method,
        url: options.url,
        headers: options.headers,
        data: options.data,
      responseType: options.responseType,
      onload(response) {
          if (isSuccessfulResponse(response, options.url)) {
            resolve(response);
            return;
          }

          const errorMessage = extractResponseError(response);
          reject(new Error(errorMessage));
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

  function isSuccessfulResponse(response, url) {
    if (!response) {
      return false;
    }

    if (response.status >= 200 && response.status < 300) {
      return true;
    }

    return response.status === 0 && String(url || '').startsWith('file:');
  }

  function extractResponseError(response) {
    if (!response) {
      return '请求失败';
    }

    const prefix = `请求失败：HTTP ${response.status}`;
    if (!response.responseText) {
      return prefix;
    }

    try {
      const parsed = JSON.parse(response.responseText);
      if (parsed.error) {
        return `${prefix} - ${parsed.error}`;
      }
      if (parsed.note) {
        return `${prefix} - ${parsed.note}`;
      }
    } catch (error) {
      return `${prefix} - ${String(response.responseText).slice(0, 200)}`;
    }

    return prefix;
  }

  function getImportSummary(status) {
    if (Number(status) === 1) {
      return '文件已导入';
    }
    if (Number(status) === 2) {
      return '文件已存在，标签已补写';
    }
    return '操作完成';
  }

  function getErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || '未知错误');
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
