'use strict';

/**
 * Nexus Downloader - turn a file id into a signed CDN link, from inside the
 * logged-in Nexus page.
 *
 * Split out of content.js so the Collections queue can reuse exactly the same
 * GenerateDownloadUrl / fallback logic as the v0.2 one-click download. Every
 * request runs in the page context, so it carries the page's cookies and the
 * Cloudflare clearance the user already earned.
 */
(function (root) {
  const U = root.NexusDownloader;
  if (!U) return;

  const GENERATE_ENDPOINT = '/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl';
  const FETCH_TIMEOUT_MS = 15000;
  const REQUEST_HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest'
  };

  class LinkError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'NexusLinkError';
      this.code = code || 'unknown';
      if (extra) Object.assign(this, extra);
    }
  }

  // -------------------------------------------------------------------------
  // shared plumbing
  // -------------------------------------------------------------------------

  function markAdTimerCookie() {
    try {
      const now = Date.now();
      const until = Math.round((now + 5 * 60 * 1000) / 1000);
      const expires = new Date(now + 5 * 60 * 1000).toUTCString();
      document.cookie = `ab=0|${until};expires=${expires};domain=nexusmods.com;path=/;SameSite=Lax;Secure`;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function fetchText(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(
        url,
        Object.assign({ credentials: 'include' }, options, { signal: controller.signal })
      );
      if (response.type === 'opaqueredirect' || response.status === 0) return '';
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function retryAfterSeconds(response, text) {
    let header = '';
    try {
      header = response && response.headers ? response.headers.get('retry-after') || '' : '';
    } catch (_) {
      header = '';
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds);
    const match = String(text || '').match(/retry[- ]?after["'\s:=]+(\d{1,5})/i);
    if (match) return Number(match[1]);
    const wait = String(text || '').match(/wait\s+(\d{1,5})\s*(?:seconds|秒)/i);
    return wait ? Number(wait[1]) : 0;
  }

  function isChallengeResponse(response, text) {
    let mitigated = '';
    try {
      mitigated = response && response.headers ? response.headers.get('cf-mitigated') || '' : '';
    } catch (_) {
      mitigated = '';
    }
    if (/challenge/i.test(mitigated)) return true;
    if (U.isCloudflareChallenge(text)) return true;
    if (response && (response.status === 403 || response.status === 503)) {
      return U.isCloudflareChallenge(text) || /challenges\.cloudflare\.com/i.test(String(text || ''));
    }
    return false;
  }

  /**
   * Give the caller a code it can branch on instead of a raw message:
   * challenge | rate_limited | requires_login | not_found | moderation |
   * server_error | empty | no_link | network | timeout | unknown
   */
  function classify(response, text) {
    const status = response ? response.status : 0;
    const body = String(text || '');
    const retryAfter = retryAfterSeconds(response, body);

    if (isChallengeResponse(response, body)) {
      return { code: 'challenge', retryAfterSeconds: retryAfter, message: 'Nexus 要求人机验证（Cloudflare）' };
    }
    if (status === 429) {
      return { code: 'rate_limited', retryAfterSeconds: retryAfter, message: 'Nexus 限速了请求，需要等待' };
    }
    if (status === 401) return { code: 'requires_login', message: '需要登录 Nexus' };
    if (status === 404) return { code: 'not_found', message: 'Nexus 没有这个文件（404）' };
    if (status === 403 && /moderation/i.test(body)) {
      return { code: 'moderation', message: '该文件正在审核中' };
    }
    if (status === 403) return { code: 'access_denied', message: '没有权限获取该文件的下载链接' };
    if (status >= 500) return { code: 'server_error', message: 'Nexus 服务器暂时不可用（HTTP ' + status + '）' };
    if (!body.trim()) return { code: 'empty', message: 'Nexus 没有返回内容' };
    return { code: 'no_link', message: U.describeResponseError(body, status) || 'Nexus 没有返回下载链接' };
  }

  // -------------------------------------------------------------------------
  // link resolution
  // -------------------------------------------------------------------------

  async function callGenerateDownloadUrl(fileId, gameId, gameDomain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const body = U.buildGenerateBody({ fileId, gameId, gameDomain });
      let response;
      try {
        response = await fetch(GENERATE_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          redirect: 'follow',
          headers: Object.assign({ Range: 'bytes=0-0' }, REQUEST_HEADERS),
          body,
          signal: controller.signal
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw new LinkError('timeout', '请求 Nexus 超时');
        throw new LinkError('network', '请求 Nexus 失败：' + ((err && err.message) || String(err)));
      }

      if (U.isDirectCdnUrl(response.url)) {
        try {
          if (response.body) await response.body.cancel();
        } catch (_) {
          /* ignore */
        }
        return response.url;
      }
      if (response.type === 'opaqueredirect' || response.status === 0) {
        throw new LinkError('network', 'Nexus 返回了重定向，未能取得直链');
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const disposition = (response.headers.get('content-disposition') || '').toLowerCase();
      if (/octet-stream|application\/zip|application\/x-|binary\//.test(contentType) || disposition.includes('attachment')) {
        try {
          if (response.body) await response.body.cancel();
        } catch (_) {
          /* ignore */
        }
        throw new LinkError('no_link', 'Nexus 直接返回了文件流，未取得可交给 IDM 的直链');
      }

      const bodyText = await response.text();
      const url = U.parseDownloadUrlResponse(bodyText);
      if (url) return url;
      const verdict = classify(response, bodyText);
      throw new LinkError(verdict.code, verdict.message, {
        status: response.status,
        retryAfterSeconds: verdict.retryAfterSeconds
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchApiRoute(url, expectedFileId) {
    if (expectedFileId) {
      const routeFileId = U.fileIdFromHref(url);
      if (routeFileId && routeFileId !== expectedFileId) return '';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(url, location.href).href, {
        credentials: 'include',
        redirect: 'follow',
        signal: controller.signal
      });
      if (U.isDirectCdnUrl(response.url)) {
        try {
          if (response.body) await response.body.cancel();
        } catch (_) {
          /* ignore */
        }
        return response.url;
      }
      const text = await response.text();
      const found = U.parseDownloadUrlFromPageHtml(text);
      if (found) {
        const absolute = new URL(found, location.href).href;
        if (U.isDirectCdnUrl(absolute)) return absolute;
      }
      return '';
    } catch (_) {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  function filePageUrl(fileId, gameDomain, modId) {
    if (!fileId) return '';
    if (gameDomain && modId) {
      return (
        'https://www.nexusmods.com/' + gameDomain + '/mods/' + modId + '?tab=files&file_id=' + encodeURIComponent(fileId)
      );
    }
    const url = new URL(location.href);
    url.searchParams.set('tab', 'files');
    url.searchParams.set('file_id', fileId);
    url.searchParams.delete('nd_auto');
    url.searchParams.delete('nmm');
    return url.toString();
  }

  async function fetchFilePageDownloadUrl(fileId, gameDomain, modId) {
    const text = await fetchText(filePageUrl(fileId, gameDomain, modId));
    return U.parseDownloadUrlFromPageHtml(text);
  }

  /**
   * Resolve a link for exactly one file id. Every fallback the v0.2 click flow
   * uses, minus the DOM payloads (a collection page has no file widgets).
   *
   * @returns {{url: string, via: string} | {url: '', code: string, message: string, retryAfterSeconds: number}}
   */
  async function resolveByFileId(input, options) {
    const opts = options || {};
    const fileId = U.normalizeFileId(input && input.fileId);
    const gameId = U.digits(input && input.gameId);
    const gameDomain = String((input && input.gameDomain) || '').trim();
    if (!fileId) return { url: '', code: 'no_file_id', message: '没有 file_id' };

    let last = { url: '', code: 'unknown', message: '未能取得下载链接' };
    const attempt = async (via) => {
      const url = await callGenerateDownloadUrl(fileId, gameId, gameDomain);
      return { url, via };
    };

    try {
      return await attempt('api');
    } catch (err) {
      last = err;
    }

    if (last.code === 'rate_limited' || last.code === 'challenge' || last.code === 'requires_login') {
      // Do not paper over these: retrying makes the block worse.
      return {
        url: '',
        code: last.code,
        message: last.message,
        retryAfterSeconds: last.retryAfterSeconds || 0
      };
    }

    // A free account's first request may be answered with nothing until the
    // page's ad-timer cookie exists; mark it and retry once.
    if (markAdTimerCookie()) {
      try {
        return await attempt('api+ad-timer');
      } catch (err) {
        last = err;
        if (last.code === 'rate_limited' || last.code === 'challenge' || last.code === 'requires_login') {
          return {
            url: '',
            code: last.code,
            message: last.message,
            retryAfterSeconds: last.retryAfterSeconds || 0
          };
        }
      }
    }

    // The manual download page often carries the signed link even when the
    // generator refuses.
    try {
      const pageUrl = await fetchFilePageDownloadUrl(fileId, gameDomain, opts.modId);
      if (pageUrl) {
        const absolute = new URL(pageUrl, location.href).href;
        if (U.isDirectCdnUrl(absolute)) return { url: absolute, via: 'file-page' };
        if (U.isNexusApiFileRoute(absolute)) {
          const resolved = await fetchApiRoute(absolute, fileId);
          if (resolved) return { url: resolved, via: 'file-page-route' };
        }
      }
    } catch (_) {
      /* keep trying */
    }

    // /api/files/<uid>/download, uid = gameId * 2^32 + fileId.
    if (U.digits(gameId)) {
      try {
        const uid = (BigInt(gameId) * 4294967296n + BigInt(fileId)).toString();
        const resolved = await fetchApiRoute(location.origin + '/api/files/' + uid + '/download', fileId);
        if (resolved) return { url: resolved, via: 'api-route-uid' };
      } catch (_) {
        /* keep trying */
      }
    }

    // Old widget endpoints, last resort.
    for (const widget of ['DownloadPopUp', 'ModRequirementsPopUp']) {
      try {
        const widgetUrl =
          '/Core/Libs/Common/Widgets/' +
          widget +
          '?id=' +
          encodeURIComponent(fileId) +
          (gameId ? '&game_id=' + encodeURIComponent(gameId) : '');
        const text = await fetchText(widgetUrl);
        const url = U.parseDownloadUrlResponse(text);
        if (url) return { url, via: 'widget' };
      } catch (_) {
        /* keep trying */
      }
    }

    return {
      url: '',
      code: last.code || 'no_link',
      message: last.message || '未能取得下载链接',
      retryAfterSeconds: last.retryAfterSeconds || 0
    };
  }

  root.NexusFileLink = {
    GENERATE_ENDPOINT,
    FETCH_TIMEOUT_MS,
    LinkError,
    markAdTimerCookie,
    fetchText,
    callGenerateDownloadUrl,
    fetchApiRoute,
    fetchFilePageDownloadUrl,
    filePageUrl,
    classify,
    retryAfterSeconds,
    isChallengeResponse,
    resolveByFileId
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
