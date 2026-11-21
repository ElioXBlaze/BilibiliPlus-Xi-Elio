// ==UserScript==
// @name         BilibiliPlus Xi/Elio · 哔哩哔哩 iPad 增强套件
// @namespace    https://bilipad.local/suite
// @version      2.0.5
// @description  iPad Pro / iPadOS / Safari / Stay 专用单脚本：零导航页内搜索、官方接口三连（无币自动补赞藏）、弹幕显示开关按真实状态载体校验（发弹幕完全交还 B 站官方输入框，不劫持 A / Shift+Enter）、R 键刷新推荐改为「点击后验证卡片真的变化」（不再假成功）、进播放页自动起播（静音起播 + 首次手势恢复音量 + 官方播放按钮兜底）、扩展倍速、全屏智能铺满、可避让专注条、分区与 UP 主屏蔽、无水印直链、截帧。单实例 + 命令总线 + 共享 Observer。
// @author       Xi/Elio X. Blaze
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://m.bilibili.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @inject-into  content
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 0. 单实例守卫 —— 这是"不互相冲突"的第一道闸
   * ============================================================ */
  const NS = '__BILIPAD_SUITE__';
  if (window[NS] && window[NS].booted) {
    console.warn('[BiliPad] 检测到重复实例，本次注入已跳过，避免倍速/快捷键/样式被二次覆盖。');
    return;
  }
  const CORE = window[NS] = {
    booted: false, version: '2.0.5', started: Date.now(), loginDiag: null,
    modules: new Map(), logs: [], hiddenCount: 0,
    // v1.7 倍速长按：rateHold=[ / ] 的按下状态；rightHold=右方向键按下状态；
    // officialHold=B 站官方「长按右方向键 3×」生效期间（脚本此间绝不写 playbackRate）。
    rateHold: null, rightHold: null, officialHold: null, rateDiag: null,
    // v1.8 原生搜索 toggle：open=脚本已唤出原生下拉；input=当前 B 站搜索框；
    // prevFocus / prevValue=按下前的焦点与输入内容，关闭时用于「复原」。
    nativeSearch: { open: false, input: null, prevFocus: null, prevValue: '',
      forced: [], revealed: false, revealAttempts: 0 },
    nativeSearchDiag: null,
    // v1.8.1 工具条二级菜单：显式开合状态 + 同手势去重
    dockOpen: false, dockToggledAt: 0,
    // v1.9 自绘浮层搜索：显式状态机，联想 / 分类 / 历史全在这里，避免散落全局
    floatSearch: { open: false, kw: '', tab: 'all', counts: null, results: [],
      suggest: [], sugIndex: -1, sugSeq: 0, sugChannel: '', history: [], hot: [],
      busy: false, lastError: '' },
    floatDiag: null,
    media: [], mediaMeta: null, previewBlob: null, userMuted: false,
    lastInputFocusAt: 0, lastRealTap: 0, searchLock: false, barPos: null,
    wbiKeys: null, wbiAt: 0,
    // v1.6.2：自动起播只负责「刚点开视频把画面跑起来」这一次。
    // apPlayed[k]=这个视频曾经真的播放过；apPaused[k]=用户主动暂停过。
    // 任一为真即永久收手（v1.6.3 已合并掉语义重复的 autoPlayDone）。
    apStart: {}, apTries: 0, apDiag: null, gestureSeen: false,
    apPlayed: {}, apPaused: {},
    // v1.6.3 音量：volSettable=特性探测缓存；applyingVolume=脚本写入时防止自反馈；
    // lastGestureAt=判断 volumechange 是否来自用户；lastMuted=仅用于诊断；
    // volDiag=音量诊断；volSaveTimer=拖动音量条时的写入防抖。
    volSettable: null, applyingVolume: false, lastGestureAt: 0, lastMuted: null,
    volDiag: null, volSaveTimer: null,
    results: [], switchDiag: null, refreshDiag: null, refreshLock: false,
  };
  const LOG = (tag, msg) => {
    const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + tag + ' · ' + msg;
    CORE.logs.push(line);
    if (CORE.logs.length > 80) CORE.logs.shift();
    try { console.debug('%c[BiliPad]', 'color:#fb7299', tag, msg); } catch (_) {}
  };

  /* ============================================================
   * 1. 能力探测 —— Stay 并非完整 Tampermonkey，逐项降级
   * ============================================================ */
  const CAP = {
    store: typeof GM_getValue === 'function' && typeof GM_setValue === 'function',
    style: typeof GM_addStyle === 'function',
    menu: typeof GM_registerMenuCommand === 'function',
    download: typeof GM_download === 'function',
    xhr: typeof GM_xmlhttpRequest === 'function',
    share: typeof navigator.share === 'function',
    clipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
    fullscreen: !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen),
    nativeVideoFullscreen: typeof document.createElement('video').webkitEnterFullscreen === 'function'
  };
  function pageWindow() {
    try { return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window; } catch (e) { return window; }
  }

  /* ============================================================
   * 2. 存储适配层（GM_* 优先，localStorage 兜底）
   * ============================================================ */
  const PREFIX = 'bpe.';
  const Store = {
    get(k, d) {
      try {
        const raw = CAP.store ? GM_getValue(PREFIX + k, null) : localStorage.getItem(PREFIX + k);
        if (raw === null || raw === undefined || raw === '') return d;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) { return d; }
    },
    set(k, v) {
      try {
        const raw = JSON.stringify(v);
        if (CAP.store) GM_setValue(PREFIX + k, raw);
        else localStorage.setItem(PREFIX + k, raw);
      } catch (e) { LOG('Store', '写入失败：' + e.message); }
    },
    del(k) {
      try { if (CAP.store && typeof GM_deleteValue === 'function') GM_deleteValue(PREFIX + k); else localStorage.removeItem(PREFIX + k); } catch (e) {}
    }
  };

  /* ============================================================
   * 3. 配置
   * ============================================================ */
  const ZONES = [
    { tid: 1, name: '动画' }, { tid: 3, name: '音乐' }, { tid: 4, name: '游戏' },
    { tid: 5, name: '娱乐' }, { tid: 11, name: '电视剧' }, { tid: 23, name: '电影' },
    { tid: 36, name: '知识' }, { tid: 119, name: '鬼畜' }, { tid: 129, name: '舞蹈' },
    { tid: 155, name: '时尚' }, { tid: 160, name: '生活' }, { tid: 177, name: '纪录片' },
    { tid: 181, name: '影视' }, { tid: 188, name: '科技' }, { tid: 202, name: '资讯' },
    { tid: 211, name: '美食' }, { tid: 217, name: '动物圈' }, { tid: 223, name: '汽车' },
    { tid: 234, name: '运动' }
  ];
  // 子分区 tid → 一级分区 tid（来源：bilibili-API-collect 分区表，2026 版）
  const TID_PARENT = (function () {
    const m = {};
    const put = (p, cs) => { m[p] = p; cs.forEach(c => { m[c] = p; }); };
    put(1, [24, 25, 47, 210, 86, 253]);
    put(3, [28, 31, 30, 194, 59, 193, 29]);
    put(4, [17, 171, 172, 65, 173, 121, 136, 19, 240]);
    put(5, [71, 241, 137]);
    put(36, [201, 124, 228, 207, 208, 209, 229, 122, 230, 231, 232]);
    put(188, [95, 189, 96, 97, 176]);
    put(234, [235, 249, 250, 251, 252]);
    put(160, [138, 239, 161, 162, 21]);
    put(211, [76, 212, 213]);
    put(217, [218, 219, 220, 221, 222]);
    put(119, [22, 26, 126, 127]);
    put(155, [157, 158, 159]);
    put(129, [20, 154, 156, 257, 258]);
    put(181, [182, 183, 184, 85]);
    [11, 23, 177, 202].forEach(t => { m[t] = t; });
    return m;
  })();

  const DEFAULTS = {
    schema: 13, enabled: true,
    // v1.8：S 键改为「唤出 B 站原生搜索下拉（搜索历史 / 热搜）」，再按一次关闭复原。
    // 关掉则回到 v1.3 的自绘零导航浮层（降级用）。
    nativeSearchToggle: true,
    // v1.9：S 找不到原生框时自动降级到自绘浮层（不再只提示失败）；
    // floatSearch 是「无论何时都画浮层」的独立快捷键。
    nativeFallbackFloat: true, floatSuggest: true, floatHot: true, floatHistory: true,
    rateEnabled: true, rememberRate: true, rate: 1,
    rateList: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5],
    // v1.7：长按「相反档键」取消倍速；长按右方向键松开回 1×（不恢复旧档）；
    // 学习模式隐藏时保留容器并显示占位文字。holdThresholdMs 为长按判定阈值。
    longPressCancelRate: true, officialHoldToNormal: true,
    hidePlaceholder: true, holdThresholdMs: 340,
    fillEnabled: true, fillMode: 'auto',
    // v1.6.3：preferredVolume 记住「用户最后一次调整」的数值（含 0%）；
    // rememberVolume 为总开关。volumeTouched 是从未被读取的死字段，已删除。
    autoPlay: true, autoUnmute: true, rememberVolume: true, preferredVolume: 0.8,
    learnMode: false, barMinimized: false, barAvoidSearch: true,
    // 学习模式默认屏蔽"非学习"分区，保留 知识36 / 科技188 / 资讯202 / 纪录片177
    blockedTids: [1, 3, 4, 5, 11, 23, 119, 129, 155, 160, 181, 211, 217, 223, 234],
    blockedUps: [], zoneLookup: true, showBlockButtons: true,
    // v1.6：A / Shift+Enter 不再占用，发弹幕完全交还 B 站官方输入框
    shortcuts: {
      refresh: 'r', danmu: 'd',
      searchZoom: 's', floatSearch: 'Shift+S', triple: 'b', capture: 'c',
      fullscreen: 'f', fillToggle: 'Shift+F', fillReset: 'Shift+R', mute: 'm',
      rateDown: '[', rateUp: ']', learn: 'g', nativeFullscreen: ''
    },
    confirmTriple: false,
    // 搜索：永远零导航，页内渲染结果；官方提交一律拦截
    searchMode: 'panel', searchNewTab: false, searchFallbackTab: false,
    captureMaxWidth: 1920, downloadEnabled: true
    // v2.0.5：blockAppBanner / blockAppJump 两个键已随整套功能删除
  };

  const savedCfg = Store.get('cfg', null);
  let CFG = Object.assign({}, DEFAULTS, savedCfg || {});
  CFG.shortcuts = Object.assign({}, DEFAULTS.shortcuts, (savedCfg && savedCfg.shortcuts) || {});
  // v1.0 → v1.1 迁移：旧版默认 contain 会留下上下黑边；旧版搜索跳 search.bilibili.com 会重定向循环
  const upgrading = savedCfg && (!savedCfg.schema || savedCfg.schema < 2);
  if (upgrading) {
    CFG.fillMode = 'cover';
    CFG.searchMode = 'mobile';   // 旧版跳 search.bilibili.com 在 iPad 上会「太多重定向」
    CFG.searchFallbackTab = false;
    CFG.schema = 2;
    CFG.shortcuts.fillToggle = CFG.shortcuts.fillToggle || 'Shift+F';
    LOG('Migrate', 'v1.0 → v1.1：裁切铺满 / 移动版搜索已启用（弹幕键位随后由 v1.3 统一）');
  }
  // v1.1 → v1.2 迁移：彻底废掉「叠加原生全屏 + fixed 容器」那套会黑屏的逻辑
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 3)) {
    CFG.fillMode = 'auto';            // 智能：横屏裁切 / 竖屏完整
    CFG.shortcuts = Object.assign({}, DEFAULTS.shortcuts, CFG.shortcuts);
    LOG('Migrate', 'v1.1 → v1.2：全屏改为「转发 B 站按钮 + video inline 样式」，已启用智能填充');
  }
  // v1.2 → v1.3 迁移：搜索彻底零导航、三连走官方接口、开启自动播放
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 4)) {
    CFG.searchMode = 'panel';        // 废弃 mobile / desktop / inpage 三种会跳转的落地方式
    CFG.searchFallbackTab = false;
    CFG.searchNewTab = false;
    CFG.autoPlay = true;
    LOG('Migrate', 'v1.2 → v1.3：零导航页内搜索 / 官方接口三连 / 自动播放');
  }
  // v1.5 → v1.6：用户要求彻底删掉自定义发弹幕，A / Shift+Enter 交还官方输入框；
  // 并修复「自动播放还得手点」（静音起播后立刻解除静音会被 iPad Safari 暂停）。
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 6)) {
    CFG.autoPlay = true;
    CORE.apStart = {}; CORE.apTries = 0;
    CORE.apPlayed = {}; CORE.apPaused = {};
    LOG('Migrate', 'v1.5 → v1.6：删除整套快捷发弹幕（交还官方）/ 自动起播改为静音起播 + 手势恢复音量');
  }
  // v1.6 → v1.6.1：R 键改为「点击后核对首屏卡片真的变化」，不再无条件报成功
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 7)) {
    CORE.refreshDiag = null;
    LOG('Migrate', 'v1.6 → v1.6.1：R 刷新推荐限定首页 / 找真实 button.roll-btn / 验证卡片变化');
  }
  // v1.6.1 → v1.6.2：自动起播成功后永久收手，删掉所有「补播 / 回退重播」逻辑
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 8)) {
    CORE.apPlayed = {}; CORE.apPaused = {};
    LOG('Migrate', 'v1.6.1 → v1.6.2：起播成功后永久收手 / 用户暂停绝不抢播');
  }
  // v1.6.2 → v1.6.3：音量记忆改为「用户调整即记」+ 特性探测 + 解除静音零延迟
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 9)) {
    CFG.rememberVolume = true;
    CORE.apPlayed = {}; CORE.apPaused = {};
    delete CFG.volumeTouched;
    LOG('Migrate', 'v1.6.2 → v1.6.3：音量记忆（用户调整即记 / 特性探测 / 防自反馈）+ 解除静音移出手势回调');
  }
  // v1.6.3 → v1.7.0：屏蔽占位文字 / 长按档键取消倍速 / 长按右方向键松开回原速
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 10)) {
    CFG.hidePlaceholder = true;
    CFG.longPressCancelRate = true;
    CFG.officialHoldToNormal = true;
    CFG.holdThresholdMs = 340;
    LOG('Migrate', 'v1.6.3 → v1.7：空白容器填「与学习无关」/ 长按相反档键回原速 / 官方长按 3× 松开回 1×');
  }
  // v1.7 → v1.8：搜索快捷键改为「原生搜索框 toggle」（弹出 / 再按关闭复原）
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 11)) {
    CFG.nativeSearchToggle = true;
    LOG('Migrate', 'v1.7 → v1.8：S 键改为唤出 B 站原生搜索下拉，再按一次关闭复原');
  }
  // v1.8.1 → v1.9：新增「浮层搜索」独立快捷键；S 找不到原生框时自动降级浮层
  if (savedCfg && (!savedCfg.schema || savedCfg.schema < 12)) {
    CFG.nativeFallbackFloat = true;
    CFG.floatSuggest = true; CFG.floatHot = true; CFG.floatHistory = true;
    LOG('Migrate', 'v1.8.1 → v1.9：Shift+S 浮层搜索 / S 无原生框自动降级 / 联想词 + 分类结果');
  }
  delete CORE.autoPlayDone;
  delete CFG.volumeTouched;
  CFG.schema = 15;
  // 无论旧配置存过什么，这版一律清干净，确保 A / Shift+Enter 不被任何残留键位占用
  ['dmQuick', 'dmQuickAlt', 'dmQuick2', 'danmuFocus', 'danmuQuick', 'danmuSend'].forEach(k => delete CFG.shortcuts[k]);
  CFG.shortcuts.floatSearch = CFG.shortcuts.floatSearch || 'Shift+S';
  ['dmColor', 'dmMode', 'dmFontsize', 'dmRemember', 'dmColorful', 'dmHex', 'dmAutoDowngrade'].forEach(k => delete CFG[k]);
  delete CFG.nativeFirst;
  CFG.rateList = (Array.isArray(CFG.rateList) && CFG.rateList.length) ? CFG.rateList : DEFAULTS.rateList.slice();
  CFG.blockedTids = Array.isArray(CFG.blockedTids) ? CFG.blockedTids : DEFAULTS.blockedTids.slice();
  CFG.blockedUps = Array.isArray(CFG.blockedUps) ? CFG.blockedUps : [];
  // v2.0.5：整套「防跳转 / 去 App 横幅」已删除，连旧配置键一起清掉，
  // 避免残留配置被旧逻辑或第三方读到，也避免迁移分支再引用已删字段。
  if (savedCfg && (savedCfg.blockAppBanner !== undefined || savedCfg.blockAppJump !== undefined)) {
    delete CFG.blockAppBanner;
    delete CFG.blockAppJump;
    LOG('Migrate', 'v2.0.5：已彻底移除防跳转 / 去 App 横幅全部功能、命令与配置键');
  }
  CORE.barPos = Store.get('barPos', null);
  // 旧版可能把专注条停在顶部搜索框附近，v1.3 一律复位到左下
  if (CORE.barPos && typeof CORE.barPos.y === 'number' && CORE.barPos.y < 160) {
    CORE.barPos = null; Store.del('barPos');
    LOG('Migrate', '已复位会遮挡搜索框的专注条位置');
  }
  let zoneCache = Store.get('zoneCache', {}) || {};
  const save = () => Store.set('cfg', CFG);

  /* ============================================================
   * 4. 通用工具
   * ============================================================ */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  let rootsCache = null, rootsAt = 0;
  function collectRoots() {
    const now = Date.now();
    if (rootsCache && now - rootsAt < 900) return rootsCache;
    const roots = [document];
    try { document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); }); } catch (e) {}
    rootsCache = roots; rootsAt = now;
    return roots;
  }
  function deepFind(sel) {
    const out = [];
    collectRoots().forEach(r => { try { out.push.apply(out, r.querySelectorAll(sel)); } catch (e) {} });
    return out;
  }
  function firstMatch(sels) {
    for (const s of sels) { try { const el = $(s) || deepFind(s)[0]; if (el) return el; } catch (e) {} }
    return null;
  }
  function addStyle(css, id) {
    if (document.getElementById(id)) return document.getElementById(id);
    if (CAP.style) {
      try { const el = GM_addStyle(css); if (el) { el.id = id; return el; } } catch (e) {}
    }
    const s = document.createElement('style');
    s.id = id; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  }
  function fire(el, type) {
    try {
      const E = (typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, view: window, pointerType: 'touch' }));
    } catch (e) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    }
  }
  async function copyText(text) {
    if (!text) return toast('没有可复制的内容');
    try {
      if (CAP.clipboard) await navigator.clipboard.writeText(text);
      else throw new Error('no clipboard api');
      toast('已复制到剪贴板');
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        toast('已复制到剪贴板');
      } catch (_) { toast('复制失败，请长按链接手动复制'); }
    }
  }
  function biliFetch(url) {
    return new Promise((resolve, reject) => {
      fetch(url, { credentials: 'include' })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
        .then(resolve)
        .catch(err => {
          if (CAP.xhr) {
            try {
              GM_xmlhttpRequest({
                method: 'GET', url: url,
                onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); } },
                onerror: () => reject(err)
              });
              return;
            } catch (e) {}
          }
          reject(err);
        });
    });
  }
  function currentBvid() {
    const m = (location.pathname + location.search).match(/BV[0-9A-Za-z]{10}/);
    if (m) return m[0];
    try { return pageWindow().__INITIAL_STATE__?.bvid || ''; } catch (e) { return ''; }
  }

  /* ============================================================
   * 4b. 官方接口工具：WBI 签名 / POST / Cookie / CID
   *     搜索与三连走这里，不再依赖 DOM 按钮（B 站前端改版也不怕）
   * ============================================================ */
  function getCookie(name) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function md5(str) {
    const b = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) b.push(c);
      else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        b.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    const bitLen = b.length * 8;
    b.push(0x80);
    while (b.length % 64 !== 56) b.push(0);
    for (let i = 0; i < 8; i++) b.push(Math.floor(bitLen / Math.pow(256, i)) & 255);
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
      4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const W = new Array(16);
    for (let off = 0; off < b.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = (b[off+i*4] | (b[off+i*4+1] << 8) | (b[off+i*4+2] << 16) | (b[off+i*4+3] << 24)) >>> 0;
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7*i) % 16; }
        const sum = (A + F + K[i] + W[g]) >>> 0;
        const rot = ((sum << S[i]) | (sum >>> (32 - S[i]))) >>> 0;
        const t = D; D = C; C = B; B = (B + rot) >>> 0; A = t;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const hex = n => { let s = ''; for (let i = 0; i < 4; i++) s += ((n >>> (i*8)) & 255).toString(16).padStart(2, '0'); return s; };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }
  const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,
    12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  async function getWbiKey() {
    if (CORE.wbiKeys && Date.now() - CORE.wbiAt < 3600000) return CORE.wbiKeys;
    const r = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
    const img = (r && r.data && r.data.wbi_img && (r.data.wbi_img.img_url || r.data.wbi_img.imgUrl)) || '';
    const sub = (r && r.data && r.data.wbi_img && (r.data.wbi_img.sub_url || r.data.wbi_img.subUrl)) || '';
    const ik = img.split('/').pop().split('.')[0], sk = sub.split('/').pop().split('.')[0];
    if (!ik || !sk) throw new Error('无法取得 WBI 密钥（可能未登录或网络受限）');
    const raw = ik + sk;
    CORE.wbiKeys = MIXIN_KEY_ENC_TAB.map(i => raw[i]).join('').slice(0, 32);
    CORE.wbiAt = Date.now();
    return CORE.wbiKeys;
  }
  function signWbi(params, mixin) {
    const p = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
    const q = Object.keys(p).sort().map(k =>
      encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))
    ).join('&');
    return q + '&w_rid=' + md5(q + mixin);
  }
  /* v1.4 关键修复：Safari/Stay 的 GM_xmlhttpRequest 走扩展自己的 Cookie 仓库，
     不带页面登录态 → POST 全部返回「账号未登录」，颜色/字号参数根本没送到 B 站。
     现在强制「页面 fetch 优先 + 主站/接口双通道」，GM_xhr 只在 fetch 全挂时兜底。 */
  const POST_BASES = ['https://www.bilibili.com', 'https://api.bilibili.com'];
  const postBody = obj => Object.keys(obj).map(k =>
    encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
  function biliPostOnce(url, obj) {
    return fetch(url, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: postBody(obj) })
      .then(r => r.text())
      .then(txt => {
        try { return JSON.parse(txt); }
        catch (e) { return { code: -999, message: '响应不是 JSON（可能被风控拦截或返回 HTML）' }; }
      });
  }
  async function biliPostSmart(path, obj) {
    let last = null, used = '';
    for (const base of POST_BASES) {
      const host = base.split('//')[1];
      try {
        const r = await biliPostOnce(base + path, obj);
        if (r && r.code === 0) { used = host; LOG('Post', '成功通道 ' + used); return Object.assign({}, r, { __via: used }); }
        last = r || last;
        LOG('Post', host + ' → code=' + (r && r.code) + ' ' + ((r && r.message) || ''));
      } catch (e) {
        last = { code: -998, message: e.message };
        LOG('Post', host + ' 请求失败：' + e.message);
      }
    }
    if (CAP.xhr && typeof GM_xmlhttpRequest === 'function') {
      try {
        const r = await new Promise(resolve => {
          GM_xmlhttpRequest({
            method: 'POST', url: 'https://api.bilibili.com' + path, data: postBody(obj),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded',
              'Cookie': document.cookie, 'Referer': 'https://www.bilibili.com/' },
            onload: x => { try { resolve(JSON.parse(x.responseText)); } catch (e) { resolve({ code: -999, message: '扩展通道响应异常' }); } },
            onerror: () => resolve({ code: -998, message: '扩展通道网络失败' })
          });
        });
        if (r && r.code === 0) { LOG('Post', '成功通道 GM_xhr（已补 Cookie 头）'); return Object.assign({}, r, { __via: 'GM_xhr' }); }
        last = r || last;
      } catch (e) { LOG('Post', 'GM_xhr 兜底异常：' + e.message); }
    }
    return last || { code: -998, message: '所有请求通道均失败' };
  }
  // 兼容完整 URL 调用
  function biliPost(url, obj) {
    try { const u = new URL(url, location.href); return biliPostSmart(u.pathname + u.search, obj); }
    catch (e) { return biliPostSmart(url, obj); }
  }

  /* ============================================================
   * 5. 页面级样式（light DOM）—— 全屏铺满 / 软隐藏 / 卡片按钮
   * ============================================================ */
  /* v1.2：全屏不再注入任何全局 CSS。铺满只通过 JS 给 <video> 加 inline style，
     不 fixed 容器、不加黑底覆盖层、不改 body —— 从根上杜绝「整页黑屏」。 */
  const PAGE_CSS = `
    /* v1.7：默认「彻底隐藏」；加 bpe-ph 后改为「保留容器几何 + 占位文字」。
       只软隐藏直接子元素（visibility 保留布局盒子），不改 display，
       所以卡片高度 / grid 占位完全不变，空白容器里就能填上文字。 */
    .bpe-hide:not(.bpe-ph) { display:none!important; }
    .bpe-hide.bpe-ph { position:relative!important; }
    .bpe-hide.bpe-ph > *:not(.bpe-hide-ph) { visibility:hidden!important; opacity:0!important; pointer-events:none!important; }
    .bpe-hide-ph { display:none!important; }
    .bpe-hide.bpe-ph > .bpe-hide-ph {
      display:flex!important; position:absolute!important; inset:0; z-index:20;
      flex-direction:column; align-items:center; justify-content:center; gap:5px;
      padding:8px; box-sizing:border-box; text-align:center; pointer-events:none;
      border:1px dashed rgba(127,130,145,.38); border-radius:12px;
      background:linear-gradient(135deg, rgba(127,130,145,.10), rgba(127,130,145,.035));
      backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px);
      color:inherit; opacity:.78; overflow:hidden;
    }
    .bpe-hide-ph .bpe-ph-ico { font-size:19px; line-height:1; opacity:.8; }
    .bpe-hide-ph .bpe-ph-txt { font-size:13px; font-weight:700; letter-spacing:.06em; }
    .bpe-hide-ph .bpe-ph-why { font-size:10.5px; line-height:1.4; opacity:.7;
      max-width:92%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .bpe-card { position:relative; }
    .bpe-blk { position:absolute; right:6px; top:6px; z-index:30; width:24px; height:24px; padding:0;
      border:none; border-radius:50%; background:rgba(0,0,0,.55); color:#fff; font-size:13px; line-height:24px;
      cursor:pointer; opacity:.62; backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); }
    .bpe-blk:hover { opacity:1; background:#fb7299; }
    /* 仅清除 v1.0/v1.1 残留，防止旧版留在 DOM 上的类继续制造黑屏 */
    html.bpe-fill::before { display:none!important; }
  `;

  /* ============================================================
   * 6. UI 样式（Shadow DOM 隔离，不污染 B 站、也不被 B 站污染）
   * ============================================================ */
  const UI_CSS = `
    :host { --pink:#fb7299; --pink2:#ff9db5; --bg:rgba(255,255,255,.86); --fg:#1b1c20;
      --sub:#71757f; --line:rgba(20,20,30,.09); --card:rgba(255,255,255,.72); --soft:rgba(118,120,135,.10);
      --shadow:0 24px 70px rgba(20,22,40,.22); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif; }
    @media (prefers-color-scheme:dark) { :host { --bg:rgba(26,27,33,.90); --fg:#f3f4f8; --sub:#9ba1ad;
      --line:rgba(255,255,255,.11); --card:rgba(44,46,55,.74); --soft:rgba(255,255,255,.08);
      --shadow:0 24px 70px rgba(0,0,0,.6); } }
    * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    .bpe-stage { position:fixed; inset:0; z-index:2147483600; pointer-events:none; color:var(--fg); font-size:14px; }
    .bpe-stage button, .bpe-stage input, .bpe-stage select { font-family:inherit; }
    .bpe-stage button { cursor:pointer; }
    /* v1.9.1：stage 内显式分四层，避免 dock 盖住设置页。
       旧版 setDock 给 .bpe-dock 写 z-index:2147483600，而 .bpe-panel 是 auto，
       于是二级菜单永远压在设置页上（实机截图里右侧一列按钮盖住正文）。
       现在：dock 2147483600 < mask 2147483605 < panel 2147483610 < toast 2147483620。 */
    .bpe-mask { position:fixed; inset:0; z-index:2147483605; background:rgba(10,12,22,.42); backdrop-filter:blur(8px);
      -webkit-backdrop-filter:blur(8px); pointer-events:auto; }
    .bpe-fab { position:fixed; right:18px; bottom:calc(18px + env(safe-area-inset-bottom)); width:56px; height:56px;
      border-radius:20px; border:1px solid rgba(255,255,255,.5); pointer-events:auto;
      background:linear-gradient(145deg,var(--pink),#f45c8f); color:#fff; font-size:23px;
      box-shadow:0 12px 34px rgba(251,114,153,.46); transition:transform .22s cubic-bezier(.2,.9,.3,1.3); }
    .bpe-fab:active { transform:scale(.9) rotate(-12deg); }
    .bpe-dock { position:fixed; right:20px; bottom:calc(84px + env(safe-area-inset-bottom)); pointer-events:auto;
      display:flex; flex-direction:column; gap:10px; align-items:flex-end; }
    .bpe-dock .bpe-mini { min-width:44px; height:44px; padding:0 12px; border-radius:14px; border:1px solid var(--line);
      background:var(--bg); color:var(--fg); font-size:13px; font-weight:600; backdrop-filter:blur(18px);
      -webkit-backdrop-filter:blur(18px); box-shadow:0 8px 24px rgba(0,0,0,.16); }
    .bpe-dock .bpe-mini.on { background:linear-gradient(145deg,var(--pink),#f45c8f); color:#fff; border-color:transparent; }
    .bpe-panel { position:fixed; right:14px; bottom:calc(84px + env(safe-area-inset-bottom)); z-index:2147483610;
      width:min(760px,calc(100vw - 28px)); height:min(620px,calc(100dvh - 120px)); pointer-events:auto;
      display:flex; flex-direction:column; border-radius:24px; overflow:hidden;
      background:var(--bg); backdrop-filter:blur(28px); -webkit-backdrop-filter:blur(28px);
      border:1px solid var(--line); box-shadow:var(--shadow); }
    .bpe-head { display:flex; align-items:center; gap:12px; padding:16px 18px; border-bottom:1px solid var(--line); }
    .bpe-logo { width:38px; height:38px; border-radius:13px; flex:0 0 38px; color:#fff; font-weight:800; font-size:20px;
      display:grid; place-items:center; background:linear-gradient(145deg,var(--pink),#f45c8f); box-shadow:0 6px 18px rgba(251,114,153,.4); }
    .bpe-title { font-size:16px; font-weight:750; letter-spacing:.2px; }
    .bpe-sub { font-size:11px; color:var(--sub); margin-top:2px; }
    .bpe-x { margin-left:auto; width:34px; height:34px; border-radius:11px; border:none; background:var(--soft); color:var(--fg); font-size:15px; }
    .bpe-body { display:flex; flex:1; min-height:0; }
    .bpe-nav { width:132px; flex:0 0 132px; padding:12px 8px; border-right:1px solid var(--line); overflow:auto; }
    .bpe-nav button { width:100%; display:flex; align-items:center; gap:8px; padding:10px 10px; margin-bottom:4px;
      border:none; border-radius:12px; background:transparent; color:var(--sub); font-size:12.5px; text-align:left; font-weight:600; }
    .bpe-nav button.active { background:linear-gradient(100deg,rgba(251,114,153,.18),rgba(251,114,153,.04)); color:var(--pink); }
    .bpe-content { flex:1; padding:18px 20px 26px; overflow:auto; -webkit-overflow-scrolling:touch; }
    .bpe-foot { padding:9px 18px; border-top:1px solid var(--line); font-size:10.5px; color:var(--sub); text-align:center; }
    /* v1.9.1 设置面板重构：页内快速跳转 / 分组 / 折叠更新日志 */
    .bpe-tabchips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 14px; }
    .bpe-tabchips button { border:1px solid var(--line); border-radius:999px; padding:6px 11px; font-size:11px;
      font-weight:600; background:var(--card); color:var(--sub); cursor:pointer; font-family:inherit; }
    .bpe-tabchips button.on { background:linear-gradient(145deg,var(--pink),#f45c8f); color:#fff; border-color:transparent; }
    .bpe-grouptitle { margin:18px 2px 8px; font-size:11px; font-weight:800; letter-spacing:.6px; color:var(--pink);
      text-transform:uppercase; display:flex; align-items:center; gap:8px; }
    .bpe-grouptitle::after { content:''; flex:1; height:1px; background:var(--line); }
    .bpe-details { margin-bottom:10px; border:1px solid var(--line); border-radius:14px; background:var(--card); overflow:hidden; }
    .bpe-details > summary { padding:12px 14px; font-size:12.5px; font-weight:700; cursor:pointer;
      list-style:none; display:flex; align-items:center; gap:8px; }
    .bpe-details > summary::-webkit-details-marker { display:none; }
    .bpe-details > summary::before { content:'▸'; color:var(--pink); transition:transform .2s; }
    .bpe-details[open] > summary::before { transform:rotate(90deg); }
    .bpe-details > .bpe-card { margin:0; border:0; border-top:1px solid var(--line); border-radius:0; background:transparent; }
    .bpe-log .bpe-card > p { font-size:11px; }
    .bpe-log .bpe-card > h3 { font-size:12.5px; }
    .bpe-nav .sep { height:1px; background:var(--line); margin:8px 6px; }
    /* v1.9.2：功能下方的简洁小字说明，替代原来的大段版本说明 / 黄框 note */
    .bpe-hint { margin:9px 2px 0; font-size:10.8px; line-height:1.6; color:var(--sub); }
    .bpe-hint b { color:var(--fg); font-weight:650; }
    .bpe-hint code { font-family:ui-monospace,Menlo,monospace; font-size:10px; padding:1px 4px;
      border-radius:5px; background:var(--soft); color:var(--fg); }
    /* v2.0.0：打赏页。二维码固定白底，深色模式下也能扫 */
    .bpe-donate { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-bottom:4px; }
    .bpe-donate .bpe-qr { display:flex; flex-direction:column; align-items:center; gap:9px; padding:14px;
      border-radius:18px; border:1px solid var(--line); background:#fff;
      box-shadow:0 8px 24px rgba(0,0,0,.08); }
    .bpe-donate .bpe-qr img { width:100%; max-width:280px; height:auto; display:block; border-radius:12px; }
    .bpe-donate .bpe-qr b { font-size:12.5px; color:#1b1c20; }
    .bpe-donate .bpe-qr small { font-size:11px; line-height:1.6; color:#71757f; text-align:center; }
    .bpe-h1 { font-size:19px; font-weight:780; margin:0 0 4px; }
    .bpe-lead { color:var(--sub); font-size:12.5px; line-height:1.65; margin:0 0 16px; }
    .bpe-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:10px; margin-bottom:16px; }
    .bpe-tile { padding:13px; border-radius:16px; border:1px solid var(--line); background:var(--card); }
    .bpe-tile b { display:block; font-size:12.5px; margin-bottom:5px; }
    .bpe-tile small { color:var(--sub); font-size:11px; line-height:1.5; display:block; }
    .bpe-tile .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#34c759; margin-right:6px; }
    .bpe-tile .dot.off { background:#ff9f0a; }
    .bpe-card { padding:14px 16px; border-radius:17px; border:1px solid var(--line); background:var(--card); margin-bottom:12px; }
    .bpe-card > h3 { margin:0 0 4px; font-size:13.5px; font-weight:720; }
    .bpe-card > p { margin:0 0 12px; font-size:11.5px; color:var(--sub); line-height:1.6; }
    .bpe-row { display:flex; align-items:center; gap:12px; padding:9px 0; border-top:1px solid var(--line); }
    .bpe-row:first-of-type { border-top:none; }
    .bpe-row-t { flex:1; min-width:0; }
    .bpe-row-t b { display:block; font-size:12.5px; font-weight:640; }
    .bpe-row-t small { display:block; color:var(--sub); font-size:10.8px; line-height:1.5; margin-top:2px; }
    .bpe-switch { position:relative; width:44px; height:26px; flex:0 0 44px; }
    .bpe-switch input { opacity:0; width:100%; height:100%; margin:0; position:absolute; z-index:2; }
    .bpe-switch span { position:absolute; inset:0; border-radius:20px; background:var(--soft); border:1px solid var(--line); transition:.2s; }
    .bpe-switch span::after { content:''; position:absolute; left:3px; top:3px; width:18px; height:18px; border-radius:50%; background:#fff; box-shadow:0 2px 6px rgba(0,0,0,.25); transition:.2s; }
    .bpe-switch input:checked + span { background:linear-gradient(145deg,var(--pink),#f45c8f); border-color:transparent; }
    .bpe-switch input:checked + span::after { transform:translateX(18px); }
    .bpe-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:9px 14px; min-height:36px;
      border-radius:12px; border:1px solid var(--line); background:var(--card); color:var(--fg); font-size:12px; font-weight:650; }
    .bpe-btn.primary { background:linear-gradient(145deg,var(--pink),#f45c8f); color:#fff; border-color:transparent; box-shadow:0 6px 18px rgba(251,114,153,.32); }
    .bpe-btn.ghost { background:transparent; }
    .bpe-btn.sm { padding:6px 10px; min-height:30px; font-size:11px; border-radius:10px; }
    .bpe-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .bpe-input, .bpe-select { padding:8px 11px; border-radius:11px; border:1px solid var(--line); background:var(--card); color:var(--fg);
      font-size:12px; outline:none; min-height:36px; }
    .bpe-input:focus { border-color:var(--pink); }
    .bpe-chips { display:flex; flex-wrap:wrap; gap:7px; margin-top:8px; }
    .bpe-chip { padding:6px 11px; border-radius:999px; border:1px solid var(--line); background:var(--card); color:var(--sub); font-size:11.5px; font-weight:600; }
    .bpe-chip.on { background:linear-gradient(145deg,var(--pink),#f45c8f); color:#fff; border-color:transparent; }
    .bpe-chip.cur { outline:2px solid var(--pink); outline-offset:2px; color:var(--pink); }
    .bpe-kbd { display:inline-block; min-width:24px; padding:3px 7px; border-radius:7px; background:var(--soft);
      border:1px solid var(--line); font-size:11px; font-weight:700; text-align:center; font-family:ui-monospace,Menlo,monospace; }
    .bpe-kt { width:100%; border-collapse:collapse; font-size:12px; }
    .bpe-kt td { padding:8px 4px; border-bottom:1px solid var(--line); }
    .bpe-kt td:last-child { text-align:right; }
    .bpe-note { padding:11px 13px; border-radius:13px; background:rgba(255,159,10,.10); border:1px solid rgba(255,159,10,.28);
      color:var(--fg); font-size:11.5px; line-height:1.65; margin:10px 0; }
    .bpe-note.pink { background:rgba(251,114,153,.10); border-color:rgba(251,114,153,.28); }
    .bpe-toast { position:fixed; left:50%; bottom:calc(96px + env(safe-area-inset-bottom)); z-index:2147483620;
      transform:translateX(-50%) translateY(10px);
      max-width:min(460px,86vw); padding:11px 17px; border-radius:14px; pointer-events:none; opacity:0;
      background:rgba(24,25,32,.92); color:#fff; font-size:12.5px; line-height:1.5; text-align:center;
      box-shadow:0 14px 40px rgba(0,0,0,.3); transition:.24s; }
    .bpe-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    /* 默认左下角，彻底避开顶部 B 站搜索框；可拖动，位置持久化 */
    .bpe-filterbar { position:fixed; left:14px; bottom:calc(14px + env(safe-area-inset-bottom));
      pointer-events:auto; display:flex; align-items:center; gap:8px; padding:7px 9px 7px 7px; border-radius:14px;
      background:var(--bg); border:1px solid var(--line); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
      box-shadow:0 10px 30px rgba(0,0,0,.18); font-size:11.5px; z-index:4; white-space:nowrap; touch-action:none;
      max-width:calc(100vw - 28px); transition:box-shadow .18s; }
    .bpe-filterbar.dragging { box-shadow:0 18px 44px rgba(0,0,0,.30); cursor:grabbing; opacity:.94; }
    .bpe-bar-handle { width:20px; height:28px; flex:0 0 20px; border-radius:8px; cursor:grab;
      background:repeating-linear-gradient(90deg,var(--sub) 0 2px,transparent 2px 5px); opacity:.45; }
    .bpe-filterbar.dragging .bpe-bar-handle { opacity:.8; }
    .bpe-filterbar button { border:none; background:var(--soft); color:var(--fg); border-radius:9px; padding:5px 9px; font-size:11px; font-weight:650; }
    .bpe-filterbar button.hi { background:var(--pink); color:#fff; }
    .bpe-filterbar.min { width:44px; height:44px; padding:0; border-radius:14px; justify-content:center; }
    .bpe-filterbar.min > *:not(.bpe-bar-restore) { display:none; }
    .bpe-bar-restore { width:100%; height:100%; border:none; background:transparent; color:var(--pink); font-size:20px; }
    /* 焦点在输入框时的提示，解释「为什么按键变成打字」 */
    .bpe-kbdstate { position:fixed; left:50%; bottom:calc(96px + env(safe-area-inset-bottom)); transform:translateX(-50%);
      pointer-events:none; padding:7px 13px; border-radius:999px; font-size:11px; font-weight:650; z-index:2147483620;
      background:rgba(24,25,32,.86); color:#fff; box-shadow:0 8px 24px rgba(0,0,0,.24); }
    /* v1.3：遮罩不再模糊背景，用户要求「看着清、不糊」 */
    .bpe-overlay { position:fixed; inset:0; background:rgba(10,12,22,.38);
      pointer-events:auto; display:grid; place-items:center; z-index:6; padding:20px; }
    .bpe-searchbox { width:min(620px,100%); padding:22px; border-radius:24px; background:var(--bg); border:1px solid var(--line);
      box-shadow:var(--shadow); }
    .bpe-searchbox h3 { margin:0 0 4px; font-size:16px; }
    .bpe-searchbox p { margin:0 0 16px; font-size:11.5px; color:var(--sub); }
    .bpe-search-input { width:100%; padding:15px 17px; font-size:19px; border-radius:15px; border:2px solid var(--line);
      background:var(--card); color:var(--fg); outline:none; }
    .bpe-search-input:focus { border-color:var(--pink); box-shadow:0 0 0 4px rgba(251,114,153,.16); }
    /* ============ v1.9 自绘浮层：尽量贴合 B 站原生深色搜索面板 ============
       固定深色而非跟随 --bg，和截图里 search.bilibili.com 的深色下拉一致；
       背景不模糊（v1.3 用户明确要求「看着清、不糊」）。 */
    .bpe-search.bpe-overlay { align-items:flex-start; padding:clamp(56px,9dvh,110px) 16px 20px;
      background:rgba(10,12,22,.42); backdrop-filter:none; -webkit-backdrop-filter:none; }
    .bpe-fs { width:min(780px,100%); max-height:min(76dvh,760px); display:flex; flex-direction:column;
      border-radius:16px; overflow:hidden; pointer-events:auto; color:#e3e5e7;
      background:#1f2027; border:1px solid rgba(255,255,255,.09);
      box-shadow:0 22px 60px rgba(0,0,0,.5); font-size:14px; }
    .bpe-fs-top { display:flex; gap:10px; padding:16px 16px 12px; align-items:center; flex:0 0 auto; }
    .bpe-fs-inwrap { flex:1; min-width:0; display:flex; align-items:center; gap:9px; height:44px;
      padding:0 14px; border-radius:8px; background:#2b2c35; border:1px solid rgba(255,255,255,.10); }
    .bpe-fs-inwrap:focus-within { border-color:#00aeec; background:#30313b; }
    .bpe-fs-ic { color:#9aa0aa; font-size:17px; flex:0 0 auto; }
    .bpe-fs-input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:#e3e5e7;
      font-size:16px; font-family:inherit; -webkit-appearance:none; }
    .bpe-fs-input::placeholder { color:#8b8f98; }
    .bpe-fs-clear { border:0; background:transparent; color:#9aa0aa; font-size:17px; cursor:pointer;
      padding:2px 4px; display:none; }
    .bpe-fs-clear.show { display:block; }
    .bpe-fs-go { height:44px; min-width:76px; padding:0 20px; border:0; border-radius:8px; cursor:pointer;
      background:#00aeec; color:#fff; font-size:15px; font-weight:600; font-family:inherit; flex:0 0 auto; }
    .bpe-fs-go:active { background:#009dd4; }
    .bpe-fs-sub { padding:0 16px 10px; font-size:11.5px; color:#8b8f98; flex:0 0 auto; }
    .bpe-fs-sub b { color:#00aeec; font-weight:600; }
    .bpe-fs-body { flex:1; min-height:0; overflow:auto; -webkit-overflow-scrolling:touch; padding:0 12px 14px; }
    .bpe-fs-tabs { display:flex; gap:2px; overflow-x:auto; border-bottom:1px solid rgba(255,255,255,.08);
      margin:0 -12px 10px; padding:0 12px; flex:0 0 auto; scrollbar-width:none; }
    .bpe-fs-tabs::-webkit-scrollbar { display:none; }
    .bpe-fs-tab { position:relative; white-space:nowrap; border:0; background:transparent; color:#a2a6ae;
      font-size:14px; font-family:inherit; padding:11px 13px 12px; cursor:pointer; }
    .bpe-fs-tab:hover { color:#e3e5e7; }
    .bpe-fs-tab.on { color:#00aeec; font-weight:650; }
    .bpe-fs-tab.on::after { content:''; position:absolute; left:13px; right:13px; bottom:0; height:3px;
      border-radius:3px 3px 0 0; background:#00aeec; }
    .bpe-fs-tab i { font-style:normal; font-size:10.5px; margin-left:4px; color:#7c818b; }
    .bpe-fs-sec { margin:6px 4px 9px; font-size:12px; color:#a2a6ae; display:flex; justify-content:space-between; align-items:center; }
    .bpe-fs-sec button { border:0; background:transparent; color:#8b8f98; font-size:11px; cursor:pointer; font-family:inherit; }
    .bpe-fs-chips { display:flex; flex-wrap:wrap; gap:8px; margin:0 4px 14px; }
    .bpe-fs-chip { border:0; border-radius:6px; background:#2b2c35; color:#c9ccd2; padding:7px 12px;
      font-size:13px; cursor:pointer; font-family:inherit; max-width:100%; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
    .bpe-fs-chip:active { background:#373944; }
    .bpe-fs-chip.hot b { color:#ff6b6b; font-weight:700; margin-right:6px; font-size:11px; }
    /* 实时联想词条：紧贴输入框下方，和原生下拉同一观感 */
    .bpe-fs-sug { margin:0 4px 12px; border-radius:10px; background:#26272f; overflow:hidden;
      border:1px solid rgba(255,255,255,.07); }
    .bpe-fs-sugrow { display:flex; align-items:center; gap:10px; padding:10px 13px; cursor:pointer;
      font-size:14px; color:#d6d8dd; border-bottom:1px solid rgba(255,255,255,.05); }
    .bpe-fs-sugrow:last-child { border-bottom:0; }
    .bpe-fs-sugrow:hover, .bpe-fs-sugrow.on { background:#33343e; color:#fff; }
    .bpe-fs-sugrow em { color:#00aeec; font-style:normal; }
    .bpe-fs-sugrow span { margin-left:auto; color:#7c818b; font-size:11px; }
    .bpe-fs-hint { padding:10px 13px; font-size:11px; color:#8b8f98; }
    .bpe-fs-res { display:flex; gap:11px; align-items:flex-start; padding:9px 7px; border-radius:10px; cursor:pointer; }
    .bpe-fs-res:hover { background:#2b2c35; }
    .bpe-fs-res img { width:120px; height:70px; object-fit:cover; border-radius:7px; background:#111;
      flex:0 0 120px; }
    .bpe-fs-res .ph { width:120px; height:70px; border-radius:7px; background:#111; flex:0 0 120px; }
    .bpe-fs-res .tx { min-width:0; flex:1; padding-top:2px; }
    .bpe-fs-res b { display:block; font-size:14px; line-height:1.45; margin-bottom:6px; color:#e3e5e7;
      font-weight:600; overflow:hidden; text-overflow:ellipsis; display:-webkit-box;
      -webkit-line-clamp:2; -webkit-box-orient:vertical; }
    .bpe-fs-res small { font-size:11.5px; color:#9297a0; display:block; line-height:1.6; }
    .bpe-fs-res .tag { display:inline-block; font-size:10px; color:#00aeec; border:1px solid rgba(0,174,236,.5);
      border-radius:4px; padding:0 5px; margin-right:6px; vertical-align:1px; }
    .bpe-fs-busy, .bpe-fs-empty { padding:22px 8px; text-align:center; font-size:12.5px; color:#9297a0; line-height:1.8; }
    .bpe-fs-foot { flex:0 0 auto; padding:9px 16px; border-top:1px solid rgba(255,255,255,.07);
      font-size:11px; color:#7c818b; display:flex; justify-content:space-between; gap:10px; }
    .bpe-fs-foot b { color:#a2a6ae; font-weight:600; }
    .bpe-preview img { max-width:100%; max-height:64dvh; border-radius:14px; display:block; margin:0 auto 14px; background:#000; }
    .bpe-code { display:block; padding:10px 12px; border-radius:11px; background:var(--soft); font-size:10.8px;
      font-family:ui-monospace,Menlo,monospace; word-break:break-all; line-height:1.6; margin:8px 0; }
    .bpe-hero { padding:18px; border-radius:20px; margin-bottom:16px; color:#fff;
      background:linear-gradient(125deg,#fb7299 0%,#f45c8f 42%,#8b7bff 100%); box-shadow:0 14px 38px rgba(180,90,150,.28); }
    .bpe-hero h2 { margin:0 0 6px; font-size:20px; font-weight:800; letter-spacing:.3px; }
    .bpe-hero p { margin:0; font-size:12px; line-height:1.6; opacity:.94; }
    .bpe-tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:12px; }
    .bpe-tags span { padding:4px 9px; border-radius:999px; background:rgba(255,255,255,.22); font-size:10.5px; font-weight:650; }
    [hidden] { display:none!important; }
    @media (max-width:560px) { .bpe-nav { width:56px; flex-basis:56px; } .bpe-nav button { justify-content:center; font-size:0; }
      .bpe-nav button::first-letter { font-size:16px; } .bpe-content { padding:14px; } }
  `;

  /* ============================================================
   * 7. 命令总线（所有快捷键 / 按钮都走这里，只有一处 keydown）
   * ============================================================ */
  const Bus = {
    handlers: new Map(),
    register(id, fn) { this.handlers.set(id, fn); CORE.modules.set(id, true); },
    exec(id, payload) {
      LOG('Cmd', id + (payload !== undefined ? ' ' + payload : ''));
      const h = this.handlers.get(id);
      if (!h) { toast('未注册命令：' + id); return; }
      try { return h(payload); }
      catch (e) { LOG('Error', id + ' → ' + e.message); toast('执行失败：' + e.message); }
    }
  };

  /* ============================================================
   * 8. 播放器接管：倍速仲裁 / 音量恢复 / 元素查找
   * ============================================================ */
  let curVideo = null, unmuteTries = 0;
  const Rate = {
    applying: false,
    apply(v, r, remember, quiet) {
      if (!v) return;
      const rate = Math.min(16, Math.max(0.0625, Number(r) || 1));
      if (Math.abs(v.playbackRate - rate) < 0.001) return false;
      this.applying = true;
      try { v.playbackRate = rate; } catch (e) {}
      setTimeout(() => { this.applying = false; }, 80);
      if (remember) { CFG.rate = rate; save(); }
      if (!quiet) toast('倍速 ' + rate + '×');
      LOG('Rate', '写入 ' + rate + '×' + (quiet ? '（静默）' : ''));
      return true;
    }
  };
  function findVideo() {
    const list = deepFind('video').filter(v => v.isConnected);
    if (!list.length) return curVideo;
    // 优先接管「可见 + 有播放源 + 已在播」的主播放器，别误接管预加载/隐藏的 video
    const score = x => {
      let s = (x.clientWidth * x.clientHeight) || (x.videoWidth * x.videoHeight) || 0;
      if (x.currentSrc || x.src) s += 200000;
      if (!x.paused) s += 500000;
      try { if (window.getComputedStyle && getComputedStyle(x).display === 'none') s -= 1000000; } catch (e) {}
      return s;
    };
    list.sort((a, b) => score(b) - score(a));
    const v = list[0] || null;
    if (v && v !== curVideo) {
      curVideo = v; unmuteTries = 0;
      attachVideo(v);
      LOG('Video', '接管 <video> ' + (v.videoWidth || '?') + '×' + (v.videoHeight || '?'));
    }
    return curVideo;
  }
  function userHasGesture() {
    if (CORE.gestureSeen) return true;
    try {
      const ua = navigator.userActivation;   // Safari 16.4+ 全支持（WebKit 用户激活 API）
      if (ua && (ua.isActive || ua.hasBeenActive)) return true;
    } catch (e) {}
    return CORE.lastGestureAt > 0 && (Date.now() - CORE.lastGestureAt) < 3000;
  }
  function apNote(msg, extra) {
    CORE.apDiag = Object.assign({
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), msg: msg,
      tries: CORE.apTries, gesture: userHasGesture()
    }, extra || {});
    LOG('AutoPlay', msg + (extra ? ' · ' + JSON.stringify(extra) : ''));
  }
  /* ============================================================
   * v1.6.3 音量模块（按 Apple / WebKit / MDN 资料重写）
   * ① Apple《为 Safari 传送视频内容》：只有不含音轨或 muted=true 才能无手势自动播放；
   *    「在没有用户手势的情况下取消了静音，播放就会暂停」→ unmute 必须在手势回调里同步做，
   *    不能放在 play().then() / setTimeout 里，这正是旧版「开播 1~2 秒才有声音」的根因。
   * ② Apple iOS-Specific Considerations：iOS/iPadOS 上 volume 只读、恒为 1，
   *    系统音量只由用户物理键 / 控制中心控制，硬件音量键不触发 volumechange；
   *    AudioSession API 只有 type/state，没有音量属性。→ 网页无权读写系统音量。
   * ③ MDN volumechange：volume 或 muted 任一变化都会触发 → 脚本自己写入必须屏蔽，
   *    否则把「脚本写回的记忆值」又当成用户调整记一遍（自反馈污染）。
   * 结论：记忆「用户最后一次调整的音量意图」；volume 可写时才写回；iPad 上只动 muted，
   *    绝不用 Web Audio GainNode 绕过（会破坏 iOS 的 per-element bless 模型）。
   * ============================================================ */
  function volumeIsSettable() {
    if (CORE.volSettable !== null) return CORE.volSettable;
    try {
      const probe = document.createElement('audio');
      probe.volume = 0.5;   // 不用 0/1：忽略写入的浏览器恰好会读回 1，会误判为可写
      CORE.volSettable = Math.abs(probe.volume - 0.5) < 0.001;
    } catch (e) { CORE.volSettable = false; }
    return CORE.volSettable;
  }
  function userAdjusting() {
    try { if (navigator.userActivation && navigator.userActivation.isActive) return true; } catch (e) {}
    return CORE.lastGestureAt > 0 && (Date.now() - CORE.lastGestureAt) < 1500;
  }
  function rememberVolume(val, src) {
    if (!CFG.enabled || !CFG.rememberVolume) return false;
    const x = Math.min(1, Math.max(0, Number(val)));
    if (!isFinite(x) || Math.abs(x - Number(CFG.preferredVolume)) < 0.001) return false;
    CFG.preferredVolume = x;
    CORE.volDiag = Object.assign({}, CORE.volDiag || {}, {
      savedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      savedValue: x, source: src, settable: volumeIsSettable()
    });
    // 拖音量条会连发几十次，写入防抖，避免频繁 save
    if (CORE.volSaveTimer) clearTimeout(CORE.volSaveTimer);
    CORE.volSaveTimer = setTimeout(() => { CORE.volSaveTimer = null; save(); }, 220);
    LOG('Volume', '已记住用户音量 ' + Math.round(x * 100) + '%（来源 ' + src + '）');
    return true;
  }
  function applyPreferredVolume(v) {
    if (!v || !CFG.rememberVolume || !volumeIsSettable()) return false;
    const x = Math.min(1, Math.max(0, Number(CFG.preferredVolume)));
    CORE.applyingVolume = true;
    try { v.volume = x; } catch (e) {}
    setTimeout(() => { CORE.applyingVolume = false; }, 0);
    return true;
  }
  /* v1.6.3：解除静音的唯一入口。只改 muted（volume 可写时才写回记忆值），
     绝不 play()、绝不 setTimeout 回退重播。调用点必须在用户手势回调内同步执行，
     或在 play() 之前（带声音起播路径）。 */
  function unmuteNow(v, why) {
    if (!CFG.enabled || !CFG.autoUnmute || CORE.userMuted || !v || !v.muted) return false;
    CORE.applyingVolume = true;
    try {
      v.muted = false;
      const wrote = applyPreferredVolume(v);
      LOG('Volume', '解除静音（' + why + '）· 记忆 ' + Math.round(CFG.preferredVolume * 100) + '% · volume 可写=' + volumeIsSettable());
      CORE.volDiag = Object.assign({}, CORE.volDiag || {}, {
        unmutedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        reason: why, muted: v.muted, actualVolume: v.volume,
        preferred: CFG.preferredVolume, wroteVolume: wrote,
        settable: volumeIsSettable(),
        systemVolume: '由 iPad 侧键 / 控制中心控制，网页脚本无权读取或设置'
      });
      return true;
    } finally { setTimeout(() => { CORE.applyingVolume = false; }, 0); }
  }
  function restoreRate(v) {
    // v1.7：官方「长按右方向键 3×」期间脚本绝不写 playbackRate，
    // 否则会把官方的临时 3× 覆盖成脚本记忆的旧档位。
    if (CORE.officialHold && CORE.officialHold.active) return;
    if (CFG.rateEnabled && CFG.rememberRate && Math.abs((CFG.rate || 1) - 1) > 0.001) Rate.apply(v, CFG.rate, false);
  }
  /* v1.7：统一的「回到 1× 原速」入口。关键是同时清掉 CFG.rate 记忆，
     否则下一次换视频 / playing / onMeta 时 restoreRate 又会把旧档位写回来。 */
  function resetRateToNormal(why) {
    CFG.rate = 1; save();                       // 必须：彻底抹掉「之前的档位」，换片也不会写回
    const v = findVideo();
    if (!v) { CORE.rateDiag = { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), reason: why, result: '未找到视频', rememberedRate: 1 }; return false; }
    const before = v.playbackRate;
    const changed = Rate.apply(v, 1, true, true);
    CORE.rateDiag = {
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), reason: why,
      before: before, after: v.playbackRate, changed: changed, rememberedRate: 1
    };
    LOG('Rate', '回到 1× 原速（' + why + '）· 之前 ' + before + '×');
    return true;
  }
  /* v1.7：长按「相反档键」判定。
     当前 >1× 时相反档键是降档 [，当前 <1× 时相反档键是升档 ]；
     长按它（repeat 或超过阈值）→ 直接回 1×，且只触发一次。 */
  function isOppositeStep(dir, cur) {
    return (cur > 1.001 && dir < 0) || (cur < 0.999 && dir > 0);
  }
  function maybeCancelOnLongPress(src) {
    const h = CORE.rateHold;
    if (!h || h.fired || !h.opposite) return false;
    h.fired = true;
    if (h.timer) { clearTimeout(h.timer); h.timer = null; }
    if (resetRateToNormal('长按相反档键 · ' + src)) toast('↩︎ 已取消倍速 · 回到 1× 原速');
    return true;
  }
  /* v1.7：官方长按右方向键 3× 松开后，强制回 1× 而不是「进入前的档位」。
     官方会在 keyup 后恢复到它自己记的旧倍速，所以分三次校正（立即 / 60ms / 180ms），
     最后一次统一提示，避免闪回 2× 或 toast 刷屏。 */
  function endOfficialHold() {
    const seen = CORE.officialHold && CORE.officialHold.official3xSeen;
    // 结束会清掉 officialHold，把结论落到 rateDiag 方便事后诊断
    CORE.rateDiag = Object.assign({}, CORE.rateDiag || {}, {
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      reason: '官方长按右方向键 3× 松开', official3xSeen: !!seen, rememberedRate: 1
    });
    CORE.officialHold = null;
    let announced = false, saved = false;
    const fix = (final) => {
      if (!saved) { CFG.rate = 1; save(); saved = true; }   // 三次校正只写一次配置
      const v = findVideo();
      if (v && Math.abs(v.playbackRate - 1) > 0.001) Rate.apply(v, 1, true, true);
      if (final && !announced) {
        announced = true;
        toast(seen ? '↩︎ 松开右方向键 · 已回到 1× 原速' : '↩︎ 松开右方向键 · 已回到 1×（未检测到官方 3×）');
        LOG('Rate', '官方长按 3× 结束 → 回到 1× 原速（不恢复之前档位）· 检测到官方 3×=' + !!seen);
      }
    };
    fix(false);
    setTimeout(() => fix(false), 60);
    setTimeout(() => fix(true), 180);
  }
  const AP_WINDOW = 20000, AP_TICK = 320;
  let apTimer = null;
  function apKey(v) {
    return (currentBvid() || 'anon') + '|' + String(v.currentSrc || v.src || '').slice(-30);
  }
  function stopAutoPlay() {
    if (apTimer) { clearTimeout(apTimer); apTimer = null; }
  }
  /* v1.6.2 核心：自动起播只被允许「刚点开、从未播放过、用户没暂停过」的这一次。
     任一收手标记为真，所有 play() 调用点（含 900ms 定时器、手势、重试 tick）全部失效。 */
  function apAllowed(v, key) {
    if (!CFG.enabled || !CFG.autoPlay || !v || !v.paused) return false;
    if (CORE.apPlayed[key] || CORE.apPaused[key]) return false;
    return true;
  }
  function clickOfficialPlay() {
    const btn = firstMatch([
      '.bpx-player-ctrl-btn.bpx-player-ctrl-play', '.bpx-player-ctrl-play',
      '[class*="player"] [class*="play-btn"]', '.bilibili-player-video-btn-start',
      '[class*="video-play"]', '[aria-label*="播放"]'
    ]);
    if (!btn) { apNote('未找到 B 站官方播放按钮（纯 play() 重试继续）', {}); return false; }
    try { btn.click(); apNote('已点 B 站官方播放按钮兜底', {}); return true; }
    catch (e) { apNote('点官方播放按钮失败：' + e.message, {}); return false; }
  }
  function tryPlayOnce(v, key) {
    if (!apAllowed(v, key)) return;   // 唯一硬门槛：所有调用都会过这一关
    CORE.apTries++;
    /* v1.6.3 零延迟关键：先试「带声音 + 记忆音量」起播。
       用户点开视频本身就是手势，Safari 允许 → 画面和声音同时开始。
       Apple 明确要求 unmute 与 play() 在同一手势上下文里同步完成，
       所以这里在 play() 之前设好 muted / volume，绝不在 play().then() 里 unmute。 */
    const audible = userHasGesture() && CFG.autoUnmute && !CORE.userMuted;
    CORE.applyingVolume = true;
    try {
      v.autoplay = true; v.playsInline = true;
      if (audible) { v.muted = false; applyPreferredVolume(v); }
      else { v.muted = true; }
    } catch (e) {}
    let p;
    try { p = v.play(); }
    catch (e) {
      CORE.applyingVolume = false;
      apNote('调用 play() 抛错', { err: e.message, readyState: v.readyState });
      return;
    }
    setTimeout(() => { CORE.applyingVolume = false; }, 0);
    if (p && typeof p.then === 'function') {
      p.then(() => {
        // play() 的 promise 可能晚于用户操作才 resolve：这时若用户已暂停，
        // 立刻把暂停状态还回去，绝不让「迟到的成功」把画面又拉起来。
        if (CORE.apPaused[key]) {
          try { v.pause(); } catch (e) {}
          stopAutoPlay();
          apNote('起播回调迟到，但检测到你已暂停 → 保持暂停', { key: key });
          return;
        }
        // 起播成功 → 标记「这个视频播放过了」并停掉重试链，此后暂停完全归用户
        CORE.apPlayed[key] = 1;
        stopAutoPlay();
        apNote(audible ? '✅ 已带声音起播（零延迟）· 此后暂停完全归你'
                       : '✅ 已静音起播 · 首次手势同步恢复声音',
          { readyState: v.readyState, muted: v.muted, volume: CFG.preferredVolume });
        // 注意：这里不再 setTimeout(restoreVolume, 60)。Apple：在 play().then() 里
        // 取消静音会被判定「无手势」，Safari 会暂停播放 —— 那正是旧版迟钝的根因。
      }).catch(err => {
        if (CORE.apPaused[key] || CORE.apPlayed[key]) return;
        const name = (err && err.name) || '';
        // 带声音被拒 → 立刻静音起播（静音自动播放不需要手势，合法），
        // 声音留到第一次真实手势里同步恢复；不提前标记收手，交给 playing / 重试链判断。
        if (audible && (name === 'NotAllowedError' || name === 'NotSupportedError')) {
          CORE.applyingVolume = true;
          try {
            v.muted = true;
            const p2 = v.play();
            if (p2 && p2.catch) p2.catch(() => {});
          } catch (e) {}
          setTimeout(() => { CORE.applyingVolume = false; }, 0);
          apNote('带声音起播被浏览器拒绝 → 已静音起播（首次手势即恢复声音）',
            { err: name, readyState: v.readyState, hasSrc: !!(v.currentSrc || v.src) });
          return;
        }
        apNote('浏览器拒绝起播', {
          err: name, msg: (err && err.message) || '', readyState: v.readyState,
          hasSrc: !!(v.currentSrc || v.src), muted: v.muted
        });
        if (CORE.apTries === 3 && !CORE.apOfficialClicked && apAllowed(v, key)) {
          CORE.apOfficialClicked = true;
          clickOfficialPlay();
        }
      });
    } else {
      CORE.apPlayed[key] = 1;
      stopAutoPlay();
      apNote('✅ 已自动起播（同步 play）· 此后暂停完全归你', { readyState: v.readyState });
    }
  }
  function scheduleAutoPlay(v) {
    if (!apAllowed(v, apKey(v))) return;   // 已在播 / 已收手 → 连重试定时器都不排
    const key = apKey(v);
    if (!CORE.apStart[key]) {
      CORE.apStart[key] = Date.now(); CORE.apTries = 0; CORE.apOfficialClicked = false;
      CORE.apKicked = CORE.apKicked || {};
      apNote('开始自动起播重试（20 秒窗口）', { key: key, autoPlay: CFG.autoPlay });
    }
    if (!CORE.apKicked[key]) { CORE.apKicked[key] = 1; tryPlayOnce(v, key); }
    if (apTimer) return;
    apTimer = setTimeout(() => {
      apTimer = null;
      const cur = findVideo() || v;
      if (!cur) return;
      const k = apKey(cur);
      if (!apAllowed(cur, k)) return;   // 每次 tick 重新过门槛：用户一暂停立刻断链
      if (Date.now() - (CORE.apStart[k] || Date.now()) > AP_WINDOW) {
        apNote('20 秒窗口结束，停止自动重试（可点 🎬 立即尝试自动播放）', {});
        return;
      }
      tryPlayOnce(cur, k);
      scheduleAutoPlay(cur);
    }, AP_TICK);
  }
  function autoPlayVideo(v) { scheduleAutoPlay(v); }
  function attachVideo(v) {
    const onMeta = () => {
      autoPlayVideo(v);
      restoreRate(v);
      // v1.6.3：换视频时应用记忆音量（只在 volume 可写的环境；iPad 上跳过，
      // 不覆盖系统音量、不制造假同步）。脚本写入由 applyingVolume 屏蔽，不会污染记忆。
      applyPreferredVolume(v);
    };
    ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'durationchange']
      .forEach(t => v.addEventListener(t, onMeta, { passive: true }));
    // v1.6.2：playing = 画面真的在播（无论谁触发的）→ 自动起播任务完成，永久收手
    v.addEventListener('playing', () => {
      const k = apKey(v);
      CORE.apPlayed[k] = 1;
      stopAutoPlay();
      restoreRate(v);
      applyPreferredVolume(v);
      // 不再在这里 unmute：Apple 要求 unmute 必须在用户手势回调内同步完成
    }, { passive: true });
    // v1.6.2：pause = 用户意志，任何时刻都立刻终结自动起播。
    // 初始 paused=true 不会产生 pause 事件，所以「加载慢时用户先按了暂停」
    // 也会被尊重；不判断 apPlayed，避免脚本随后又补播覆盖掉这次暂停。
    v.addEventListener('pause', () => {
      const k = apKey(v);
      CORE.apPaused[k] = 1;
      stopAutoPlay();
      apNote('检测到暂停 · 自动起播已永久收手（不再补播）', { key: k, played: !!CORE.apPlayed[k] });
    }, { passive: true });
    /* v1.6.3 音量记忆：三重判据，杜绝「脚本写回的值被当成用户调整」。
       MDN：volume 或 muted 任一变化都触发 volumechange，所以必须屏蔽脚本自身写入。 */
    v.addEventListener('volumechange', () => {
      const wasMuted = CORE.lastMuted;
      CORE.lastMuted = v.muted;
      if (CORE.applyingVolume || !userAdjusting()) return;   // 脚本写入 / B 站初始化 / 第三方脚本
      if (v.muted && wasMuted === false) {
        CORE.userMuted = true;                               // 用户主动静音 → 脚本让位
        CORE.volDiag = Object.assign({}, CORE.volDiag || {}, {
          userMuted: true, userMutedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        LOG('Volume', '检测到用户主动静音 · 自动解除静音让位（按 M 或点音量按钮可恢复）');
        return;
      }
      if (!v.muted && wasMuted === true) {
        CORE.userMuted = false;                              // 用户主动取消静音 → 恢复自动化
        LOG('Volume', '检测到用户主动取消静音 · 恢复自动解除静音');
      }
      if (!volumeIsSettable()) return;                      // iPad：v.volume 恒为 1，数值不可信
      rememberVolume(v.volume, 'volumechange');             // 含 0%：只要调整就记
    }, { passive: true });
    v.addEventListener('ratechange', () => {
      // v1.7：官方长按右方向键期间若倍速跳到 ~3×，记下来用于诊断；
      // 脚本不主动写 3×，完全交给 B 站官方响应。
      if (CORE.officialHold && CORE.officialHold.active && Math.abs(v.playbackRate - 3) < 0.75) {
        CORE.officialHold.official3xSeen = true;
      }
      if (!Rate.applying) LOG('Rate', '播放器/其他脚本把倍速改为 ' + v.playbackRate + '（本套件不抢写）');
    }, { passive: true });
    onMeta();
  }
  /* ============================================================
   * 9. 全屏 v1.2 —— 推倒重写：只做两件小事
   *   ① F 转发 B 站自己的全屏按钮（B 站自己管状态机，弹幕/控制栏/快捷键全保留）
   *   ② 检测到「已进入全屏」后，只给 <video> 和它的直接父级加 inline 样式
   *      退出时把 style.cssText 原样写回 → 结构上不可能留下黑屏
   *   绝不：fixed 容器 / 叠加原生视频全屏 / 改 body / 加黑底覆盖层 / 动祖先链
   * ============================================================ */
  const Fill = {
    video: null, parent: null, snapV: null, snapP: null, active: false, lastMode: ''
  };
  const FILL_PROPS = ['width', 'height', 'object-fit', 'display', 'margin', 'background'];
  function snapshotStyle(el) {
    if (!el) return null;
    const o = {};
    FILL_PROPS.forEach(p => {
      try { o[p] = { v: el.style.getPropertyValue(p), pri: el.style.getPropertyPriority(p) }; } catch (e) {}
    });
    return o;
  }
  function restoreStyle(el, snap) {
    if (!el || !snap) return;
    FILL_PROPS.forEach(p => {
      try {
        const s = snap[p];
        if (!s) return;
        if (s.v) el.style.setProperty(p, s.v, s.pri || '');
        else el.style.removeProperty(p);
      } catch (e) {}
    });
  }
  function biliFullscreenBtn() {
    let el = firstMatch([
      '.bpx-player-ctrl-full', '.bpx-player-ctrl-fullscreen',
      '.bpx-player-ctrl-web-fullscreen', '[class*="ctrl-full"]',
      '.bilibili-player-video-btn-fullscreen', '[class*="btn-fullscreen"]',
      '[class*="web-fullscreen"]', 'button[title*="全屏"]', '[aria-label*="全屏"]',
      '[title*="全屏"]', '[aria-label*="Full Screen"]', '[aria-label*="fullscreen"]'
    ]);
    if (el) return el;
    // 兜底：播放器常在 shadow DOM 里，遍历所有 root 找「名字含 full/全屏」的可点击控件
    try {
      const out = [];
      collectRoots().forEach(r => {
        try {
          r.querySelectorAll('button,[role="button"],[class*="ctrl"],[class*="btn"],svg').forEach(e => {
            const sig = (typeof e.className === 'string' ? e.className : '') + ' ' +
              (e.getAttribute && (e.getAttribute('title') || '')) + ' ' +
              (e.getAttribute && (e.getAttribute('aria-label') || ''));
            if (/full|全屏/i.test(sig) && !/exit|退出/i.test(sig)) out.push(e);
          });
        } catch (_) {}
      });
      if (out.length) return out[out.length - 1];   // 控制栏按钮通常靠后
    } catch (e) {}
    return null;
  }
  function currentMode() {
    const m = CFG.fillMode || 'auto';
    if (m !== 'auto') return m;
    const v = findVideo();
    const w = v && v.videoWidth, h = v && v.videoHeight;
    // 竖屏 / 方屏用 contain（不裁掉人脸和字幕），横屏用 cover（消灭 iPad 4:3 上的上下黑边）
    return (w && h && h > w * 1.05) ? 'contain' : 'cover';
  }
  function biggestPlayerRect() {
    const v = findVideo(); if (!v) return null;
    let el = v, best = null;
    for (let i = 0; i < 9 && el && el.parentElement; i++) {
      el = el.parentElement;
      if (!el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (!best || (r.width * r.height) > (best.width * best.height)) best = r;
      if (r.width >= window.innerWidth * 0.98 && r.height >= window.innerHeight * 0.96) return r;
    }
    return best;
  }
  function isBiliFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    const r = biggestPlayerRect();
    // 判断「播放器容器」是否铺满视口，而不是 video 本身（contain 时 video 必然小于视口）
    // 阈值收紧到 0.98/0.96：普通宽屏观看不会误判，全屏态是精确 100vw/100vh 必定命中
    if (r && r.width >= window.innerWidth * 0.98 && r.height >= window.innerHeight * 0.96) return true;
    try {
      const h = document.documentElement, b = document.body;
      if ((h.getAttribute && h.getAttribute('data-screen')) ||
          h.classList.contains('player-fullscreen') || b.classList.contains('player-fullscreen') ||
          document.querySelector('.bpx-player-container[data-screen="web"], .bpx-player-container.is-fullscreen, #bilibili-player.full-screen, [class*="player-full-win"], [class*="web-fullscreen"]')) return true;
    } catch (e) {}
    return false;
  }
  function updateVideoFill() {
    const v = Fill.video;
    if (!v || !v.isConnected) return;
    const mode = currentMode();
    const p = v.parentElement;
    if (p) {
      p.style.setProperty('width', '100%', 'important');
      p.style.setProperty('height', '100%', 'important');
      if (mode === 'contain') p.style.setProperty('background', '#000', 'important');
    }
    v.style.setProperty('width', '100%', 'important');
    v.style.setProperty('height', '100%', 'important');
    v.style.setProperty('object-fit', mode, 'important');
    v.style.setProperty('display', 'block', 'important');
    v.style.setProperty('margin', '0', 'important');
    if (mode !== Fill.lastMode) {
      Fill.lastMode = mode;
      LOG('Fill', 'video inline 铺满 · ' + mode + ' · ' + (v.videoWidth || '?') + '×' + (v.videoHeight || '?'));
    }
  }
  function applyVideoFill() {
    if (!CFG.enabled || !CFG.fillEnabled) return;
    const v = findVideo();
    if (!v) return;
    if (Fill.active && Fill.video === v) { updateVideoFill(); return; }
    if (Fill.active) resetVideoFill(true);   // 换片了，先把旧的还原干净
    Fill.video = v; Fill.parent = v.parentElement;
    Fill.snapV = snapshotStyle(v);
    Fill.snapP = snapshotStyle(Fill.parent);
    Fill.active = true; Fill.lastMode = '';
    updateVideoFill();
  }
  function clearLegacyFill() {
    // 用户当前很可能就卡在 v1.1 的黑屏里：把旧版留在 DOM 上的类全部清掉
    ['bpe-fill', 'bpe-fill-cover', 'bpe-fill-contain'].forEach(c => {
      try { document.documentElement.classList.remove(c); document.body.classList.remove(c); } catch (e) {}
    });
    try {
      deepFind('.bpe-fill-host,.bpe-chain').forEach(el => {
        el.classList.remove('bpe-fill-host'); el.classList.remove('bpe-chain');
      });
    } catch (e) {}
  }
  function resetVideoFill(silent) {
    clearLegacyFill();
    if (!Fill.active) return;
    try { restoreStyle(Fill.video, Fill.snapV); } catch (e) {}
    try { restoreStyle(Fill.parent, Fill.snapP); } catch (e) {}
    Fill.active = false; Fill.video = null; Fill.parent = null;
    Fill.snapV = null; Fill.snapP = null; Fill.lastMode = '';
    LOG('Fill', '已逐属性还原 video 与父级原始样式');
    if (!silent) toast('🧹 已复位全屏状态');
  }
  function fillWatchdog() {
    if (!CFG.enabled) { if (Fill.active) resetVideoFill(true); return; }
    const full = isBiliFullscreen();
    if (full && CFG.fillEnabled) applyVideoFill();
    else if (!full && Fill.active) resetVideoFill(true);
    else if (full && !CFG.fillEnabled && Fill.active) resetVideoFill(true);
  }
  Bus.register('fullscreen', () => {
    // F 永远有效：只转发 B 站自己的全屏按钮，跟「铺满增强」开关完全解耦
    const btn = biliFullscreenBtn();
    if (!btn) {
      // 不 return 死：watchdog 仍在跑，用户点 B 站自己的全屏按钮后铺满照样自动生效
      toast('未找到全屏按钮 → 请点播放器右下角的全屏图标，铺满会自动生效');
      setTimeout(fillWatchdog, 200); setTimeout(fillWatchdog, 700);
      return;
    }
    try { btn.click(); } catch (e) { toast('全屏按钮点击失败：' + e.message); return; }
    LOG('Full', '转发 B 站全屏按钮（不接管 DOM）');
    setTimeout(fillWatchdog, 200);
    setTimeout(fillWatchdog, 700);
    setTimeout(() => {
      if (isBiliFullscreen()) toast('全屏 · ' + (CFG.fillEnabled ? '铺满 ' + currentMode() : 'B 站原生（铺满增强已关）'));
      else toast('已退出全屏');
    }, 740);
  });
  Bus.register('fillToggle', () => {
    const order = ['auto', 'cover', 'contain'];
    CFG.fillMode = order[(order.indexOf(CFG.fillMode) + 1) % 3];
    save(); Fill.lastMode = '';
    if (Fill.active) updateVideoFill();
    render();
    toast('填充模式：' + ({ auto: '智能（横屏裁切 / 竖屏完整）', cover: '裁切铺满', contain: '适应（带黑边）' }[CFG.fillMode]));
  });
  Bus.register('fillReset', () => { resetVideoFill(true); toast('🧹 全屏状态已复位，video 样式已还原'); });
  Bus.register('nativeFullscreen', () => {
    const v = findVideo(); if (!v) return toast('未找到视频');
    if (typeof v.webkitEnterFullscreen !== 'function') return toast('此设备不支持原生视频全屏');
    showConfirm('原生播放器全屏会把画面交给系统接管：网页弹幕、控制栏和所有快捷键都会失效，退出要靠系统手势。仍要继续？', () => {
      resetVideoFill(true);
      try { v.webkitEnterFullscreen(); LOG('Full', '用户主动进入原生播放器全屏'); }
      catch (e) { toast('原生全屏失败：' + e.message); }
    });
  });

  /* ============================================================
   * 10. 快捷键命令实现
   * ============================================================ */
  Bus.register('rateUp', () => stepRate(1));
  Bus.register('rateDown', () => stepRate(-1));
  function stepRate(dir) {
    const v = findVideo(); if (!v) return toast('未找到视频');
    const list = CFG.rateList.slice().sort((a, b) => a - b);
    const cur = v.playbackRate;
    let next;
    if (dir > 0) {
      next = list.find(r => r > cur + 0.001);
      if (next === undefined) next = Math.min(16, cur + 0.25);
    } else {
      const lower = list.filter(r => r < cur - 0.001);
      next = lower.length ? lower[lower.length - 1] : Math.max(0.0625, cur - 0.25);
    }
    Rate.apply(v, next, true);
  }
  Bus.register('rate', r => { const v = findVideo(); if (!v) return toast('未找到视频'); Rate.apply(v, r, true); });
  /* v1.7：手动「回到 1× 原速」与倍速诊断 */
  Bus.register('rateNormal', () => {
    if (resetRateToNormal('手动命令')) toast('↩︎ 已回到 1× 原速（已清掉旧档位记忆）');
    else toast('⌛ 倍速记忆已清空，画面倍速待视频加载后生效');
  });
  Bus.register('rateDiag', () => {
    const v = findVideo();
    const d = Object.assign({}, CORE.rateDiag || { result: '尚未触发长按倍速' }, {
      checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      currentRate: v ? v.playbackRate : null, rememberedRate: CFG.rate,
      longPressCancelRate: CFG.longPressCancelRate, officialHoldToNormal: CFG.officialHoldToNormal,
      holdThresholdMs: CFG.holdThresholdMs,
      officialHoldActive: !!(CORE.officialHold && CORE.officialHold.active),
      official3xSeen: !!(CORE.officialHold && CORE.officialHold.official3xSeen) ||
        !!(CORE.rateDiag && CORE.rateDiag.official3xSeen),
      rateHold: CORE.rateHold ? { dir: CORE.rateHold.dir, opposite: CORE.rateHold.opposite, fired: CORE.rateHold.fired } : null
    });
    copyText(JSON.stringify(d, null, 2));
    toast('已复制倍速诊断 · 看 official3xSeen / rememberedRate');
    render();
  });

  /* ============================================================
   * v1.6.1 R 键刷新推荐：不再「点一下就报成功」
   * 旧版用 [class*="refresh-btn"] 可能命中播放页控件 / 隐藏外层 div，
   * el.click() 之后无条件 toast「推荐已刷新」→ 用户看到成功但列表没动。
   * 现在：① 限定首页 ② 只找真正的「换一换」 ③ 点击后对比推荐卡片
   * 真的变了才报成功；没变依次试 原生 click → 完整事件序列 → 内部子元素，
   * 仍不变就如实提示并可复制诊断。
   * 选择器与事件序列参考 2026-09 修复过 R 键的 bilibili_shortcut v1.2.3：
   * 当前 B 站是 button.roll-btn，外层 .feed-roll-btn 常只是 div，
   * 且 Vue 组件常需要完整 pointer/mouse 序列（不传 view，避免沙箱报错）。
   * ============================================================ */
  const nap = ms => new Promise(r => setTimeout(r, ms));
  function isHomeFeedPage() {
    try {
      const u = new URL(location.href);
      const onHome = u.hostname === 'www.bilibili.com' &&
        (u.pathname === '/' || u.pathname === '' || u.pathname === '/index.html' || u.pathname === '/index.php');
      if (onHome) return true;
      // 首页改版 / 带参数跳转时，用「换一换」按钮本身兜底判定
      return !!firstMatch(['button.roll-btn', '.feed-roll-btn', '.bili-feed-card .roll-btn', '.primary-btn.roll-btn']);
    } catch (e) { return false; }
  }
  function feedSnapshot() {
    const ids = [], titles = [];
    collectRoots().forEach(r => {
      try {
        Array.from(r.querySelectorAll('a[href*="/video/"]')).forEach(a => {
          const m = String(a.getAttribute('href') || '').match(/(BV[0-9A-Za-z]{10}|av\d+)/i);
          if (m) ids.push(m[1]);
        });
      } catch (e) {}
      try {
        Array.from(r.querySelectorAll('[data-bvid], [data-aid]')).forEach(el => {
          const v = el.getAttribute('data-bvid') || el.getAttribute('data-aid');
          if (v) ids.push(String(v));
        });
      } catch (e) {}
      try {
        Array.from(r.querySelectorAll('.bili-video-card__info--tit, .bili-video-card__title, [class*="video-card"] [class*="title"]'))
          .forEach(t => { const s = String(t.textContent || '').trim(); if (s) titles.push(s); });
      } catch (e) {}
    });
    // 只取首屏前 12 张：滚动懒加载追加在末尾，不会被误判成「换一换成功」
    return { ids: Array.from(new Set(ids)).slice(0, 12), titles: Array.from(new Set(titles)).slice(0, 12) };
  }
  function feedVerifiable(s) { return !!s && (s.ids.length + s.titles.length) >= 4; }
  function feedChanged(a, b) {
    if (!feedVerifiable(a) || !feedVerifiable(b)) return false;
    return a.ids.join(',') !== b.ids.join(',') || a.titles.join('|') !== b.titles.join('|');
  }
  function elVisible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    try { if (el.closest && el.closest('#bpe-root, .bpe-panel, .bpe-dock')) return false; } catch (e) {}
    try {
      const cs = window.getComputedStyle ? getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0)) return false;
    } catch (e) {}
    try {
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (r && r.width === 0 && r.height === 0) return false;
    } catch (e) {}
    return true;
  }
  function findRollButton(diag) {
    const sels = [
      'button.roll-btn', '.primary-btn.roll-btn', '.feed-roll-btn',
      '.bili-feed-card .roll-btn', '[class*="roll-btn"]',
      'button[title*="换一换"]', 'button[aria-label*="换一换"]', '[aria-label*="换一换"]'
    ];
    const raw = [];
    sels.forEach(s => {
      try { (deepFind(s) || []).forEach(el => { if (raw.indexOf(el) < 0) raw.push(el); }); } catch (e) {}
    });
    // 文本兜底：找文本就是「换一换」的 button / a（不碰任何 refresh-btn）
    try {
      (deepFind('button, a, [role="button"]') || []).forEach(el => {
        const t = String(el.textContent || '').trim();
        if ((t === '换一换' || t === '刷新内容') && raw.indexOf(el) < 0) raw.push(el);
      });
    } catch (e) {}
    diag.candidates = raw.length;
    const seen = [];
    for (const el of raw) {
      // 外层 div 不算按钮：向内找真实可点元素
      let target = el;
      try {
        if (!el.matches || !el.matches('button, a, [role="button"]')) {
          target = el.querySelector('button, a, [role="button"]') || el;
        }
      } catch (e) { target = el; }
      if (seen.indexOf(target) >= 0) continue;
      seen.push(target);
      if (!elVisible(target)) continue;
      diag.button = {
        sel: (typeof el.matches === 'function' && el.matches('button.roll-btn')) ? 'button.roll-btn' : 'dom',
        tag: target.tagName, cls: String(target.className || '').slice(0, 90),
        text: String(target.textContent || '').trim().slice(0, 30),
        html: String(target.outerHTML || '').slice(0, 200)
      };
      return target;
    }
    return null;
  }
  function fullClick(el, diag) {
    const base = { bubbles: true, cancelable: true, composed: true };
    const done = [];
    try { el.scrollIntoView && el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.focus && el.focus(); } catch (e) {}
    const emit = (Ctor, type, extra) => {
      try { el.dispatchEvent(new Ctor(type, Object.assign({}, base, extra || {}))); done.push(type); } catch (e) {}
    };
    const PE = (typeof PointerEvent === 'function') ? PointerEvent : null;
    if (PE) {
      emit(PE, 'pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
      emit(PE, 'pointerup', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    }
    emit(MouseEvent, 'mousedown'); emit(MouseEvent, 'mouseup'); emit(MouseEvent, 'click');
    diag.fullClick = done.join('>');
  }
  async function waitFeedChange(before, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await nap(250);
      const cur = feedSnapshot();
      if (feedChanged(before, cur)) return cur;
    }
    return feedSnapshot();
  }
  Bus.register('refresh', async () => {
    if (CORE.refreshLock) return toast('⏳ 正在确认推荐是否刷新，稍等一下');
    CORE.refreshLock = true;
    const diag = {
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      href: location.href, path: location.pathname, candidates: 0,
      button: null, steps: [], before: null, after: null, result: ''
    };
    try {
      const home = isHomeFeedPage();
      diag.home = home;
      if (!home) {
        diag.result = '不在首页';
        CORE.refreshDiag = diag;
        toast('⚠️ R 只在 B 站首页刷新推荐；当前在 ' + location.pathname + '（视频页右侧推荐没有「换一换」）');
        return;
      }
      const before = feedSnapshot();
      diag.before = { ids: before.ids.slice(0, 6), titles: before.titles.slice(0, 3), verifiable: feedVerifiable(before) };
      if (!feedVerifiable(before)) {
        diag.result = '推荐卡片未加载';
        CORE.refreshDiag = diag;
        toast('⚠️ 还没读到首页推荐卡片，等页面加载完再按 R（不会假装已刷新）');
        return;
      }
      const btn = findRollButton(diag);
      if (!btn) {
        diag.result = '未找到换一换';
        CORE.refreshDiag = diag;
        toast('⚠️ 没找到「换一换」按钮，未执行刷新 · 可复制「📋 刷新诊断」给我定位');
        return;
      }
      // ① 原生 click
      try { btn.click(); diag.steps.push('native click'); } catch (e) { diag.steps.push('native click 失败：' + e.message); }
      let after = await waitFeedChange(before, 1400);
      // ② 完整事件序列（Vue 组件常只认这个）
      if (!feedChanged(before, after)) {
        fullClick(btn, diag); diag.steps.push('fullClick');
        after = await waitFeedChange(before, 1800);
      }
      // ③ 点内部图标 / 文字（外层 div 挡住点击时）
      if (!feedChanged(before, after)) {
        let inner = null;
        try { inner = btn.querySelector('svg, i, span, [class*="icon"]'); } catch (e) {}
        if (inner && elVisible(inner)) { fullClick(inner, diag); diag.steps.push('inner fullClick'); after = await waitFeedChange(before, 1600); }
      }
      diag.after = { ids: after.ids.slice(0, 6), titles: after.titles.slice(0, 3), verifiable: feedVerifiable(after) };
      if (feedChanged(before, after)) {
        const goneIds = before.ids.filter(x => after.ids.indexOf(x) < 0).length;
        const goneTitles = before.titles.filter(x => after.titles.indexOf(x) < 0).length;
        const gone = Math.max(goneIds, goneTitles);
        diag.result = '已刷新并验证';
        diag.changed = gone;
        CORE.refreshDiag = diag;
        toast(gone ? ('✅ 推荐已刷新（首屏 ' + gone + ' 张卡片已换掉，已核对列表）')
                   : '✅ 推荐已刷新（首屏卡片内容已变化，已核对列表）');
        LOG('Refresh', '卡片列表已变化 · ' + diag.steps.join(' → '));
      } else {
        diag.result = '已点击但列表未变';
        CORE.refreshDiag = diag;
        toast('⚠️ 已点「换一换」但推荐列表没变化，未报成功 · 复制「📋 刷新诊断」给我定位');
        LOG('Refresh', '点击后未检测到卡片变化 · ' + diag.steps.join(' → '));
      }
    } finally { CORE.refreshLock = false; }
  });
  Bus.register('refreshDiag', () => {
    const d = CORE.refreshDiag || { result: '尚未按过 R（或本页未触发刷新）', href: location.href };
    copyText(JSON.stringify(d, null, 2));
    toast('已复制刷新诊断（含命中按钮 / 卡片快照 / 点击步骤，不含 Cookie）');
  });
  /* ============================================================
   * 弹幕「显示开关」v1.5 —— 三段式：等真实节点 → 读真实状态 → 点击并验证
   * 以前点的是外层容器（.bpx-player-ctrl-danmaku / 泛属性选择器），
   * B 站只在内部复选框 / bpx-state-active 上记状态，于是「toast 说已切换、画面纹丝不动」。
   * 现在主选择器收敛到 .bpx-player-ctrl-btn.bpx-player-ctrl-danmaku-switch，
   * 状态优先读 input.bui-danmaku-switch-input 的 checked，再读 bpx-state-active。
   * ============================================================ */
  const DM_SW_BTN = '.bpx-player-ctrl-btn.bpx-player-ctrl-danmaku-switch';
  const DM_SW_INPUT = '.bui-danmaku-switch-input, input.bui-switch-input';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function dmSwNodes() {
    const btn = firstMatch([
      DM_SW_BTN,
      '.bpx-player-ctrl-danmaku-switch', '.bui-danmaku-switch',   // 次级：去掉外层容器
      '.bpx-player-ctrl-danmaku', '.bilibili-player-video-danmaku-switch'  // 旧版仅兜底
    ]);
    let input = null;
    if (btn) { try { input = btn.querySelector(DM_SW_INPUT); } catch (e) {} }
    if (!input) input = firstMatch([DM_SW_INPUT]);
    return { btn, input };
  }
  function dmSwState(n) {
    if (n && n.input) return { on: !!n.input.checked, via: 'input.checked' };
    if (n && n.btn) return {
      on: n.btn.classList.contains('bpx-state-active') ||
        n.btn.getAttribute('data-active') === 'true' ||
        n.btn.getAttribute('aria-checked') === 'true',
      via: 'bpx-state-active'
    };
    return { on: null, via: 'none' };
  }
  function waitDmSw(timeout) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => {
        const n = dmSwNodes();
        if (n.btn) return resolve(n);
        if (Date.now() - t0 >= timeout) return resolve(null);
        setTimeout(tick, 200);
      };
      tick();
    });
  }
  function fireFullClick(el) {
    const o = { bubbles: true, cancelable: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      try {
        const Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, o));
      } catch (e) { try { el.dispatchEvent(new MouseEvent(type, o)); } catch (_) {} }
    });
  }
  function dmSwSnapshot(n) {
    return {
      btnHTML: n && n.btn ? String(n.btn.outerHTML || '').slice(0, 200) : null,
      inputHTML: n && n.input ? String(n.input.outerHTML || '').slice(0, 160) : null,
      cls: n && n.btn ? String(n.btn.className || '') : null
    };
  }
  Bus.register('danmu', async () => {
    try {
      const n = await waitDmSw(10000);
      if (!n || !n.btn) {
        CORE.switchDiag = { result: '按钮未挂载', hint: '等播放器控制栏出现再按 D；或点 🎛 → 教程/诊断 复制诊断' };
        toast('⌛ 弹幕开关按钮未挂载，请等播放器加载完再按 D');
        LOG('DanmuSwitch', '按钮未挂载（10 秒内）'); render(); return;
      }
      const snap = dmSwSnapshot(n);
      const before = dmSwState(n);
      const diag = Object.assign({ result: '进行中', attempts: [] }, snap,
        { stateVia: before.via, before: before.on, after: null,
          dmNodes: (() => { try { return document.querySelectorAll('.bpx-player-dm-root, .bpx-dm, [class*="danmaku-layer"]').length; } catch (e) { return -1; } })() });
      CORE.switchDiag = diag;
      // ① 原生 click（公开脚本都只用 click，不盲目叠加指针序列）
      try { n.btn.click(); } catch (e) {}
      diag.attempts.push('btn.click');
      await sleep(300);
      let cur = dmSwNodes(), after = dmSwState(cur);
      // ② 真实复选框载体
      if (before.on !== null && after.on === before.on && n.input) {
        try { n.input.click(); } catch (e) {}
        diag.attempts.push('input.click');
        await sleep(320);
        cur = dmSwNodes(); after = dmSwState(cur);
      }
      // ③ 仍不变才补完整事件序列（合成事件 isTrusted=false，只在必要时用）
      if (before.on !== null && after.on === before.on) {
        fireFullClick(n.btn);
        diag.attempts.push('full-pointer-sequence');
        await sleep(360);
        cur = dmSwNodes(); after = dmSwState(cur);
      }
      // ④ 渲染层可能延迟，再给一次机会
      if (before.on !== null && after.on === before.on) {
        await sleep(700);
        cur = dmSwNodes(); after = dmSwState(cur);
      }
      diag.after = after.on;
      diag.result = before.on === null ? '页面未提供可读状态' :
        (after.on !== before.on ? '已切换并验证' : '点击成功但未验证状态');
      CORE.switchDiag = diag;
      if (diag.result === '已切换并验证') {
        toast('✅ 弹幕显示已' + (after.on ? '开启' : '关闭') + '（已读 ' + after.via + ' 验证）');
      } else if (diag.result === '页面未提供可读状态') {
        toast('已点击弹幕开关 · 页面未提供可读状态，请观察画面是否变化');
      } else {
        toast('⚠️ 已点击但状态未变（' + before.via + ' 仍是 ' + before.on + '）→ 🎛 教程/诊断 看开关诊断');
      }
      LOG('DanmuSwitch', diag.result + ' · ' + diag.attempts.join(' → ') +
        ' · before=' + before.on + ' after=' + after.on);
      render();
    } catch (e) {
      LOG('DanmuSwitch', '异常：' + e.message);
      toast('弹幕开关异常：' + e.message);
    }
  });
  /* 备用：个人弹幕配置接口的 dm_switch。社区文档确认外链播放器 danmaku=false，
     站内 bpx-player 是否立即生效未验证 —— 所以只做显式按钮，不自动调用。 */
  Bus.register('danmuBackup', async () => {
    const csrf = getCookie('bili_jct');
    if (!csrf) return toast('未读取到 bili_jct，请先登录');
    toast('正在尝试「接口关弹幕」备用通道…');
    try {
      const r = await biliPostSmart('/x/v2/dm/web/config', { dm_switch: false, csrf: csrf });
      toast(r && r.code === 0 ? '接口已返回成功（站内播放器是否即时生效需你观察画面）'
        : '接口未成功：' + ((r && r.message) || 'code ' + (r && r.code)));
      LOG('DanmuBackup', JSON.stringify({ code: r && r.code, msg: r && r.message }));
    } catch (e) { toast('备用通道失败：' + e.message); }
  });
  Bus.register('danmuDiag', () => {
    const d = CORE.switchDiag;
    const txt = JSON.stringify(d || { result: '尚未按过 D / 工具条弹幕开关' }, null, 2);
    copyText(txt);
    toast(d ? '已复制弹幕开关诊断（不含 Cookie）' : '尚未运行过开关，已复制空诊断');
  });
  /* v1.6.2：手动重试是用户显式要求，才允许按当前 key 清掉收手标记重跑一次 */
  Bus.register('autoPlayNow', () => {
    const v = findVideo();
    if (!v) return toast('⌛ 还没找到 <video>，请等播放器加载');
    const key = apKey(v);
    CORE.apStart[key] = Date.now(); CORE.apTries = 0; CORE.apOfficialClicked = false;
    CORE.apPaused = CORE.apPaused || {}; delete CORE.apPaused[key];
    CORE.apPlayed = CORE.apPlayed || {}; delete CORE.apPlayed[key];
    CORE.apKicked = CORE.apKicked || {}; CORE.apKicked[key] = 1;
    stopAutoPlay();
    tryPlayOnce(v, key);
    scheduleAutoPlay(v);
    toast('🎬 已强制重跑自动起播（之后仍会立刻收手，不抢你的暂停）');
  });
  Bus.register('autoPlayDiag', () => {
    const v = findVideo();
    const k = v ? apKey(v) : null;
    const d = Object.assign({}, CORE.apDiag || { result: '尚未记录到起播尝试' }, {
      checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      autoPlay: CFG.autoPlay, enabled: CFG.enabled, gesture: userHasGesture(),
      settled: k ? !!(CORE.apPlayed[k] || CORE.apPaused[k]) : false,
      userPaused: k ? !!CORE.apPaused[k] : false,
      retryTimer: !!apTimer,
      video: v ? { paused: v.paused, muted: v.muted, readyState: v.readyState,
        hasSrc: !!(v.currentSrc || v.src), volume: v.volume } : null
    });
    copyText(JSON.stringify(d, null, 2));
    toast('已复制起播诊断（不含 Cookie）· 看 err / hasSrc / readyState');
    render();
  });
  /* v1.6.3 音量诊断：把「网页能不能写 volume / 记住了什么 / 系统音量边界」一次说清 */
  Bus.register('volumeDiag', () => {
    const v = findVideo();
    const d = Object.assign({}, CORE.volDiag || {}, {
      checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      rememberVolume: CFG.rememberVolume, autoUnmute: CFG.autoUnmute,
      preferredVolume: CFG.preferredVolume, volumeSettable: volumeIsSettable(),
      userMuted: CORE.userMuted, userAdjusting: userAdjusting(),
      video: v ? { muted: v.muted, volume: v.volume, paused: v.paused } : null,
      systemVolume: 'iPad 上由侧键 / 控制中心控制；网页 JS 无 API 读取或设置',
      whyOnIPad: volumeIsSettable() ? '当前浏览器 volume 可写，记忆值会写回 <video>'
        : 'iOS/iPadOS Safari 的 volume 只读且恒为 1（Apple 官方），硬件音量键不触发 volumechange；脚本只控制 muted，不碰系统音量'
    });
    copyText(JSON.stringify(d, null, 2));
    toast('已复制音量诊断 · 看 volumeSettable / preferredVolume / systemVolume');
    render();
  });
  Bus.register('unmuteNow', () => {
    const v = findVideo();
    if (!v) return toast('⌛ 还没找到 <video>');
    if (CORE.userMuted) return toast('你主动静音过，脚本让位 · 按 M 或点 B 站音量按钮恢复');
    toast(unmuteNow(v, '手动命令') ? '🔊 已解除静音（记忆音量已应用）' : '当前未静音，无需操作');
  });

  /* ============================================================
   * v1.6：自定义发弹幕整套已删除 —— 发送完全交还 B 站官方输入框。
   * 不再注册 A / Shift+Enter、不再有浮层 / 色板 / 接口提交，
   * 也不再拦截官方弹幕框的任何按键（官方 Enter 发送照常工作）。
   * 保留的只有「D 弹幕显示开关」。
   * ============================================================ */
  Bus.register('mute', () => {
    const v = findVideo(); if (!v) return toast('未找到视频');
    v.muted = !v.muted;
    CORE.userMuted = v.muted;
    toast(v.muted ? '已静音（自动恢复已让位）' : '已取消静音');
  });
  Bus.register('triple', () => {
    if (CFG.confirmTriple) { showConfirm('确认对当前视频一键三连？', doTriple); return; }
    doTriple();
  });
  /* v1.4：没硬币 / 三连接口失败时，仍然把「点赞 + 收藏」做掉 */
  async function doPartialTriple(bvid, csrf, already) {
    const out = [];
    if (!already.like) {
      try {
        const r = await biliPostSmart('/x/web-interface/archive/like', { bvid: bvid, like: 1, csrf: csrf });
        out.push('赞' + (r && r.code === 0 ? '✓' : '✗'));
        LOG('Triple', '补点赞 code=' + (r && r.code));
      } catch (e) { out.push('赞✗'); }
    } else out.push('赞✓(已)');
    if (!already.fav) {
      let ok = false;
      try {
        const view = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
        const aid = view && view.data && view.data.aid;
        const mid = getCookie('DedeUserID');
        const folders = await biliFetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + mid + '&type=2');
        const list = folders && folders.data && (folders.data.list || folders.data);
        const mlid = Array.isArray(list) && list[0] && (list[0].id || list[0].media_id);
        if (aid && mlid) {
          const r = await biliPostSmart('/x/v3/fav/resource/deal', {
            rid: aid, type: 2, add_media_ids: mlid, del_media_ids: '', csrf: csrf
          });
          ok = !!(r && r.code === 0);
          LOG('Triple', '补收藏 code=' + (r && r.code));
        }
      } catch (e) { LOG('Triple', '补收藏接口异常：' + e.message); }
      if (!ok) {
        // 接口拿不到收藏夹时，点 B 站自己的收藏按钮（会弹收藏夹面板，尽力自动确认）
        const btn = firstMatch(['.video-toolbar .collect', '[class*="toolbar"] [class*="collect"]',
          '[class*="toolbar"] [class*="favorite"]', '[class*="fav-btn"]', '[title*="收藏"]']);
        if (btn) {
          try {
            btn.click(); ok = true;
            setTimeout(() => {
              const yes = firstMatch(['[class*="fav"] [class*="confirm"]', '[class*="collect"] [class*="confirm"]',
                '.bili-dialog [class*="confirm"]', '[class*="fav-dialog"] [class*="btn primary"]']);
              if (yes) { try { yes.click(); } catch (e) {} }
              else toast('收藏面板已弹出，请点一下要存的收藏夹');
            }, 420);
          } catch (e) {}
        }
      }
      out.push('藏' + (ok ? '✓' : '✗请手动'));
    } else out.push('藏✓(已)');
    toast('已补做：' + out.join(' · ') + '（投币跳过：无硬币或接口失败）');
  }
  async function doTriple() {
    const bvid = currentBvid();
    const csrf = getCookie('bili_jct');
    if (!bvid) return toast('未识别当前视频 BV 号，请在视频页操作');
    if (!csrf) return toast('未读取到 bili_jct，请在 www.bilibili.com 重新登录后刷新');
    toast('正在三连…');
    try {
      const r = await biliPostSmart('/x/web-interface/archive/like/triple', { bvid: bvid, csrf: csrf });
      if (r && r.code === 0) {
        const d = r.data || {};
        toast('✅ 三连完成 · 赞' + (d.like ? '✓' : '✗') + ' 币' + (d.coin ? '✓' : '✗') + ' 藏' + (d.fav ? '✓' : '✗'));
        LOG('Triple', '官方接口成功 · ' + JSON.stringify(d));
        if (!d.coin || !d.like || !d.fav) await doPartialTriple(bvid, csrf, { like: !!d.like, fav: !!d.fav });
      } else {
        const msg = (r && r.message) || ('code ' + (r && r.code));
        toast('三连接口：' + msg + ' → 自动补做点赞 + 收藏');
        LOG('Triple', '接口返回 ' + (r && r.code) + ' ' + msg);
        await doPartialTriple(bvid, csrf, { like: false, fav: false });
      }
    } catch (e) {
      toast('三连请求失败：' + e.message + ' → 自动补做点赞 + 收藏');
      LOG('Triple', '失败：' + e.message);
      await doPartialTriple(bvid, csrf, { like: false, fav: false });
    }
  }
  Bus.register('learn', () => {
    CFG.learnMode = !CFG.learnMode; save(); applyCfg(); render();
    toast(CFG.learnMode ? '🎯 学习模式已开启' : '已关闭学习模式，全部恢复');
  });
  Bus.register('panel', () => openPanel());
  /* v1.8.1：dock 用显式状态，不再靠读 d.hidden 隐式取反。
     ① iPad Safari 的触摸可能伴随重复 click（ghost click），隐式取反会让刚展开的
        二级菜单立刻被同一次手势关掉 —— 这正是「二级闪一下就消失」的另一半原因；
     ② 打开时同时确认 host 处于最高层（v1.8 的 closeSearch 曾把它清掉）。 */
  function setDock(on) {
    const d = $('.bpe-dock', sr);
    CORE.dockOpen = !!on;
    if (host) host.style.zIndex = '2147483647';
    if (d) {
      d.hidden = !on;
      if (on) d.style.zIndex = '2147483600';
    }
  }
  Bus.register('dock', () => {
    const now = Date.now();
    if (now - (CORE.dockToggledAt || 0) < 320) return;   // 同一手势的重复 click 直接忽略
    CORE.dockToggledAt = now;
    setDock(!CORE.dockOpen);
  });
  /* v1.4 登录自检：一眼看清「到底是谁没带登录态」 */
  Bus.register('loginCheck', async () => {
    const has = n => !!getCookie(n);
    const d = {
      host: location.hostname || (String(location.href).match(/\/\/(?:www\.)?([^/]+)/) || [])[1] || '?',
      bili_jct: has('bili_jct'), SESSDATA: has('SESSDATA'), DedeUserID: has('DedeUserID'),
      nav: '查询中…'
    };
    CORE.loginDiag = d; render();
    try {
      const r = await biliFetch('https://www.bilibili.com/x/web-interface/nav');
      d.nav = (r && r.code === 0) ? ((r.data && r.data.isLogin) ? '已登录' : '未登录') : ('code ' + (r && r.code));
    } catch (e) { d.nav = '查询失败：' + e.message; }
    CORE.loginDiag = d;
    const bad = (d.nav !== '已登录') || !d.SESSDATA || !d.bili_jct;
    toast('🔐 ' + d.nav + ' · ' + d.host + (bad ? ' → 建议用 www.bilibili.com 重新登录后刷新' : ' → 登录态正常，接口已走页面通道'));
    LOG('Login', JSON.stringify(d));
    render();
  });

  /* ============================================================
   * 10b. 搜索 v1.3 —— 零导航
   *   彻底不再打开 search.bilibili.com / m.bilibili.com/search：
   *   调官方搜索接口，把结果画在自己的浮层里，一个页面都不跳。
   *   同时在 capture 阶段拦掉 B 站原生搜索框的提交、链接与 window.open，
   *   所以「直接点官方搜索框搜」也不会再触发重定向循环。
   * ============================================================ */
  function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ''); }
  /* 旧入口保留为薄封装（Esc / restoreShortcuts / 降级分支都还在调）。
     v1.9 起真正的浮层状态机在 openFloatSearch / closeFloatSearch。 */
  function openSearch() { return openFloatSearch(); }
  function closeSearch() {
    const box = $('.bpe-search', sr); if (box) box.hidden = true;
    /* v1.8.1：绝不把 host 的 z-index 清成 ''。
       v1.8 的 openNativeSearch 会调 closeSearch()，于是 host 掉回 z-index:auto；
       而 .bpe-stage 的高 z-index 只在 host 的层叠上下文内有效 —— host 一降级，
       整个工具条（含二级菜单）就被 B 站播放器 / 顶栏盖住，表现为「闪一下就消失」。
       现在固定维持最高层，任何路径都不降级。 */
    if (host) host.style.zIndex = '2147483647';
    CORE.floatSearch.open = false;
    CORE.floatSearch.suggest = []; CORE.floatSearch.sugIndex = -1;
  }
  /* ============================================================
   * v1.8 原生搜索 toggle（替代自绘浮层作为 S 键的唤出方式）
   * 查证：B 站顶部搜索框被点击 / focus 即下拉「搜索历史 + bilibili热搜」
   *   （面板类 .search-panel，社区「按 / 聚焦、Esc 失焦收起」脚本亦验证）。
   *   搜索框候选：.nav-search-input / #nav-searchform input /
   *   .center-search__bar input / input.search-input-el（结果页）。
   * 脚本不再画自己的输入框，只做两件事：
   *   按一下   → 找官方搜索框 → click + focus 唤出原生下拉（任何页面）
   *   再按一下 → blur + 合成一次外部点击 → 收起下拉、恢复按下前的焦点与内容
   * 回车 / 点热搜仍走 v1.3 零导航结果浮层，绝不回 search 域（防重定向循环复发）。
   * ============================================================ */
  const NS_INPUT_SEL = [
    '#nav-searchform input.nav-search-input', '.nav-search-input',
    '.center-search__bar input.nav-search-input', '.center-search__bar input',
    '#nav-searchform input', '.bili-header__search input',
    '.search-input-wrap input.search-input-el', 'input.search-input-el',
    'input.search-input', '[class*="search-input-wrap"] input',
    '[class*="nav-search"] input', 'input[placeholder*="搜索"]',
    'input[type="search"]'
  ];
  const NS_OPENER_SEL = [
    '.nav-search-btn', '#nav-searchform button', '.center-search__bar',
    '.bili-header__search', '[class*="search-entry"]',
    '[aria-label*="搜索"]', '.bili-header__bar [class*="search"]'
  ];
  const NS_PANEL_SEL = '.search-panel, [class*="search-panel"]';
  function nsSig(el) {
    return ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' +
      ((el.getAttribute && el.getAttribute('placeholder')) || '')).toLowerCase();
  }
  function nsInputOK(el) {
    if (!el || el.disabled || (el.tagName || '').toLowerCase() !== 'input') return false;
    if (el.classList && el.classList.contains('bpe-search-input')) return false;  // 脚本自己的浮层
    if (/danmaku|dm-input|bpx-player-dm|弹幕/.test(nsSig(el))) return false;      // 官方弹幕框不抢
    return officialSearchInput(el);
  }
  function nsVisible(el) {
    try {
      const cs = getComputedStyle(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) return false;
    } catch (e) {}
    try {
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (r && r.width === 0 && r.height === 0) return false;
    } catch (e) {}
    return true;
  }
  function findNativeSearchInput() {
    let hiddenHit = null;
    for (const sel of NS_INPUT_SEL) {
      let list = [];
      try { list = deepFind(sel); } catch (e) { continue; }
      for (const el of list) {
        if (!nsInputOK(el)) continue;
        if (nsVisible(el)) return { el: el, hidden: false, sel: sel };
        if (!hiddenHit) hiddenHit = { el: el, hidden: true, sel: sel };
      }
    }
    // 兜底：页面里任何像搜索框的 input（B 站改版 / mini header 也能覆盖）
    let all = [];
    try { all = deepFind('input'); } catch (e) {}
    for (const el of all) {
      if (!nsInputOK(el)) continue;
      if (nsVisible(el)) return { el: el, hidden: false, sel: 'input(兜底)' };
      if (!hiddenHit) hiddenHit = { el: el, hidden: true, sel: 'input(兜底)' };
    }
    /* v1.8.1 宽兜底：播放页 B 站可能把顶栏 v-if 掉 / 改了类名，
       上面的 signature 判定会全落空。此时优先取「header 容器里的任意 text input」
       —— 顶栏里的输入框只可能是搜索框；再退到 form 里的 input。
       明确排除弹幕 / 评论 / 登录 / 验证码与脚本自己的浮层。 */
    const hostile = /danmaku|dm-input|弹幕|comment|reply|login|verify|captcha|code|bpe-/i;
    let headers = [];
    try { headers = deepFind('.bili-header, .bili-header__bar, #biliMainHeader, .mini-header, [class*="bili-header"], [class*="mini-header"], header'); } catch (e) {}
    for (const h of headers) {
      let ins = [];
      try { ins = h.querySelectorAll('input'); } catch (e) { continue; }
      for (const el of ins) {
        if (el.disabled || hostile.test(nsSig(el))) continue;
        if (nsVisible(el)) return { el: el, hidden: false, sel: 'header input(宽兜底)' };
        if (!hiddenHit) hiddenHit = { el: el, hidden: true, sel: 'header input(宽兜底)' };
      }
    }
    /* 再退一步只认 form 里的 input（#nav-searchform 之类）。
       v1.8.1 修正：绝不扫「全局任意 text input」—— 播放页有评论 / 登录 / 隐形
       输入框，会被误当成搜索框，反而绕过顶栏强制唤出、也把「未渲染」误报成成功。 */
    let forms = [];
    try { forms = deepFind('form'); } catch (e) {}
    for (const f of forms) {
      let ins = [];
      try { ins = f.querySelectorAll('input'); } catch (e) { continue; }
      for (const el of ins) {
        if (el.disabled || hostile.test(nsSig(el))) continue;
        if (nsVisible(el)) return { el: el, hidden: false, sel: 'form input(宽兜底)' };
        if (!hiddenHit) hiddenHit = { el: el, hidden: true, sel: 'form input(宽兜底)' };
      }
    }
    return hiddenHit;
  }
  function nsPanelVisible() {
    let list = [];
    try { list = deepFind(NS_PANEL_SEL); } catch (e) {}
    for (const p of list) if (nsVisible(p)) return true;
    return false;
  }
  function clickNativeOpener() {
    for (const sel of NS_OPENER_SEL) {
      let list = [];
      try { list = deepFind(sel); } catch (e) { continue; }
      for (const b of list) {
        if (!nsVisible(b)) continue;
        try { b.click(); LOG('Search', '已点击原生搜索展开入口 ' + sel); return true; }
        catch (e) {}
      }
    }
    return false;
  }
  /* v1.8.1 —— 播放页顶栏收起时，先「戳」B 站自己把 header 渲染出来。
     B 站播放页的 mini header 靠滚动 / hover 出现；这里只派发事件，不改 DOM。 */
  function nsPokeHeader(hard) {
    /* 首次按 S 只派发事件，不把正在看评论的用户强行拉回页顶；
       只有重试（说明顶栏确实没出来）才真正滚到顶部。 */
    if (hard) { try { window.scrollTo(0, 0); } catch (e) {} }
    try { window.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
    let hs = [];
    try { hs = deepFind('.bili-header, .bili-header__bar, #biliMainHeader, .mini-header, [class*="bili-header"], header'); } catch (e) {}
    for (const h of hs.slice(0, 4)) {
      ['mouseenter', 'mousemove', 'pointerenter'].forEach(t => {
        try { h.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (e) {}
      });
    }
  }
  /* v1.8.1 —— 顶栏 DOM 在、只是被 CSS 藏了（播放页最常见）：把祖先链临时亮出来。
     只写 inline style 并逐项快照，关闭时按 cssText 原样还原；搜索框、历史词、
     热搜面板仍是 B 站自己的 Vue 组件，脚本绝不重绘内容。 */
  function nsForceReveal(input) {
    const ns = CORE.nativeSearch;
    if (ns.revealed) return true;
    const snaps = [];
    /* 只改「可见性」相关属性，不动 height / max-height，避免把 B 站大容器撑开、
       破坏播放页布局；fixed 的搜索条本来就不受祖先 overflow 裁剪。
       transform:none 必须要有 —— B 站常用 translateY(-100%) 收起顶栏，而带
       transform 的祖先会成为 fixed 子元素的包含块，让浮动条跑到屏幕外。 */
    const SHOW = [['display', 'block'], ['visibility', 'visible'], ['opacity', '1'],
      ['overflow', 'visible'], ['clip', 'auto'], ['transform', 'none'],
      ['pointer-events', 'auto']];
    const snap = el => {
      if (el && el.style && !snaps.some(s => s.el === el)) snaps.push({ el: el, cssText: el.style.cssText });
    };
    const force = el => {
      if (!el || !el.style) return;
      snap(el);
      SHOW.forEach(p => { try { el.style.setProperty(p[0], p[1], 'important'); } catch (e) {} });
    };
    force(input);                                     // 输入框本体
    let cur = input, chain = [];
    for (let i = 0; i < 8 && cur; i++) {
      if (cur === document.body || cur === document.documentElement) break;
      chain.push(cur); cur = cur.parentElement;
    }
    chain.slice(1).forEach(force);                    // 所有祖先（含 header 大容器）
    // 把搜索表单 / 最近包装变成顶部浮动条，视觉上就是 B 站自己的 mini header
    let bar = null;
    try { bar = input.closest && input.closest('form'); } catch (e) {}
    if (!bar) bar = chain.find(x => /search|header|nav/i.test(String(x.className || ''))) || chain[1] || null;
    if (bar && bar.style) {
      snap(bar);
      [['position', 'fixed'], ['top', '0'], ['left', '50%'], ['transform', 'translateX(-50%)'],
       ['width', 'min(620px, 92vw)'], ['max-width', '92vw'], ['z-index', '2147483000'],
       ['margin', '0'], ['display', 'flex'], ['visibility', 'visible'], ['opacity', '1'],
       ['pointer-events', 'auto'], ['box-shadow', '0 10px 34px rgba(0,0,0,.28)']]
        .forEach(p => { try { bar.style.setProperty(p[0], p[1], 'important'); } catch (e) {} });
    }
    ns.forced = snaps; ns.revealed = snaps.length > 0;
    ns.revealAttempts++;
    LOG('Search', '已强制亮出 B 站顶栏搜索框 · 快照 ' + snaps.length + ' 层');
    return ns.revealed;
  }
  function nsRestoreForced() {
    const ns = CORE.nativeSearch;
    const list = ns.forced || [];
    for (let i = list.length - 1; i >= 0; i--) {
      try { list[i].el.style.cssText = list[i].cssText; } catch (e) {}
    }
    ns.forced = []; ns.revealed = false;
    return list.length;
  }
  function openNativeSearch(attempt) {
    attempt = attempt || 0;
    const ns = CORE.nativeSearch;
    /* v1.8.1：B 站播放页默认把顶栏收起 / 甚至不渲染（不是全屏也这样）。
       每次重试都先「戳」一下：滚到顶 + 派发 scroll/hover，让 B 站自己显示 mini header。 */
    if (attempt > 0) nsPokeHeader(true);
    const hit = findNativeSearchInput();
    if (!hit) {
      if (attempt < 3) { setTimeout(() => openNativeSearch(attempt + 1), 180); return true; }
      CORE.nativeSearchDiag = {
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), result: 'B 站未渲染顶栏搜索框',
        page: location.pathname, retries: attempt, pokedHeader: true,
        tip: '播放页顶栏被 B 站收起，已滚到顶部并派发 hover 重试；可点「重试唤出」或刷新页面'
      };
      ns.open = false;
      CORE.floatDiag = {
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        reason: '没有原生搜索框，已自动降级浮层', page: location.pathname,
        retries: attempt, pokedHeader: true, fallback: CFG.nativeFallbackFloat
      };
      LOG('Search', 'B 站未渲染顶栏（已戳顶栏 + 重试 ' + attempt + ' 次）→ 降级浮层');
      /* v1.9：用户明确要求「没有原生框的页面就调用绘制浮层」——
         不再只弹一句失败提示把人卡住，直接把自绘浮层递上。 */
      if (CFG.nativeFallbackFloat) {
        openFloatSearch();
        toast('🪟 当前页没有 B 站原生搜索框 · 已自动打开原生风格浮层');
      } else {
        toast('⌛ 当前页没有原生搜索框 · 按 ' + (CFG.shortcuts.floatSearch || 'Shift+S') + ' 打开浮层搜索');
      }
      return false;
    }
    let wasHidden = !!hit.hidden, revealed = false;
    if (hit.hidden) {
      // 顶栏 DOM 在但被 CSS 藏了：① 点 B 站自己的展开入口 ② 戳顶栏
      // ③ 立刻重查一次 ④ 仍隐藏就临时把祖先链亮出来（关闭时完整还原）
      clickNativeOpener(); nsPokeHeader(false);
      const now = findNativeSearchInput();
      const target = (now && !now.hidden) ? now.el : hit.el;
      if (!nsVisible(target)) revealed = nsForceReveal(target);
      hit.el = target; hit.hidden = false;
      if (!revealed && ns.revealed) revealed = true;
    }
    closeSearch();                       // 收掉脚本自绘浮层（v1.8.1 起不再降 host z-index）
    if (host) host.style.zIndex = '2147483647';
    if (!ns.open) {
      ns.prevFocus = document.activeElement || null;
      ns.prevValue = hit.el.value || '';
      ns.open = true;
      ns.input = hit.el;
    }
    // 在用户手势回调内同步执行：click 让 B 站展开建议面板，focus 把光标放进去
    try { hit.el.click(); } catch (e) {}
    try { hit.el.focus({ preventScroll: true }); } catch (e) { try { hit.el.focus(); } catch (_) {} }
    const panel = nsPanelVisible();
    CORE.nativeSearchDiag = {
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), result: '已唤出原生搜索',
      page: location.pathname, selector: hit.sel, wasHidden: wasHidden,
      forcedRevealed: revealed, forcedCount: (ns.forced || []).length,
      retries: attempt, panelVisible: panel,
      toggleKey: CFG.shortcuts.searchZoom || 'S'
    };
    LOG('Search', '原生搜索已展开 · ' + hit.sel + ' · 强制亮出=' + revealed +
      ' · 面板=' + panel + ' · 重试=' + attempt);
    toast(revealed
      ? '🔍 已展开 B 站顶栏原生搜索 · 再按一次 ' + (CFG.shortcuts.searchZoom || 'S') + ' 关闭复原'
      : '🔍 原生搜索已展开 · 再按一次 ' + (CFG.shortcuts.searchZoom || 'S') + ' 关闭复原');
    return true;
  }
  function closeNativeSearch(why, opt) {
    opt = opt || {};
    const ns = CORE.nativeSearch;
    const wasOpen = ns.open;
    ns.open = false;                     // 先收标记，防重入
    const el = ns.input;
    // v1.8.1：关闭时第一件事就是把临时亮出的 B 站顶栏按快照还原，
    // 否则播放页会一直挂着一条浮在顶部的搜索栏。
    const restored = nsRestoreForced();
    let panelBefore = false, panelAfter = false;
    try { panelBefore = nsPanelVisible(); } catch (e) {}
    if (el) {
      if (!opt.keepValue) { try { el.value = ns.prevValue || ''; } catch (e) {} }
      try { el.blur(); } catch (e) {}
      // B 站原生下拉靠「失焦 / 点击外部」收起：合成一次指向 body / document 的空白点击
      try {
        if (document.body && typeof document.body.dispatchEvent === 'function') {
          // 指向 body 的「空白点击」会冒泡到 document，B 站的外部点击监听据此收起 .search-panel；
          // 用 body 而不是 document 作为 target，避免依赖 e.target 为 Element 的监听报错。
          document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      } catch (e) {}
    }
    if (!opt.noRestoreFocus && ns.prevFocus && ns.prevFocus !== el && ns.prevFocus.focus) {
      try { ns.prevFocus.focus({ preventScroll: true }); } catch (e) { try { ns.prevFocus.focus(); } catch (_) {} }
    }
    try { panelAfter = nsPanelVisible(); } catch (e) {}
    closeSearch();
    setKbdState(false);
    CORE.nativeSearchDiag = {
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), result: '已关闭并复原',
      reason: why, page: location.pathname, panelBefore: panelBefore, panelAfter: panelAfter,
      forcedRestored: restored, restoredValue: !opt.keepValue,
      restoredFocus: !!(ns.prevFocus && ns.prevFocus !== el)
    };
    ns.input = null; ns.prevFocus = null;
    LOG('Search', '原生搜索已关闭（' + why + '）· 面板 前=' + panelBefore + ' 后=' + panelAfter);
    if (wasOpen && !opt.silent) toast('↩︎ 原生搜索已关闭 · 已复原');
  }
  function toggleNativeSearch() {
    // v1.9：浮层已开时再按 S 也顺手关掉，避免两层叠着
    if (CORE.floatSearch.open) { closeFloatSearch(); return; }
    if (!CFG.nativeSearchToggle) return toggleFloatSearch();
    if (CORE.nativeSearch.open) closeNativeSearch('再按一次搜索键');
    else openNativeSearch(0);
  }
  function toggleFloatSearch() {
    if (CORE.floatSearch.open) closeFloatSearch();
    else openFloatSearch();
  }
  function officialSearchInput(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    let formSig = '';
    try { const f = el.closest && el.closest('form'); if (f) formSig = (f.id || '') + ' ' + (f.className || ''); } catch (e) {}
    const sig = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' +
      (el.getAttribute && (el.getAttribute('placeholder') || '') || '') + ' ' + formSig;
    return /nav-search|search-input|search|搜索|bili-header/i.test(sig);
  }
  /* ============================================================
   * v1.9 自绘浮层搜索（原生风格 / 实时联想 / 分类结果）
   * ------------------------------------------------------------
   * 查证（2025–2026，见教程页资料来源）：
   *  · 联想词   https://s.search.bilibili.com/main/suggest?term=<kw>&main_ver=v1
   *             返回 result.tag[].value（最多 10 条，支持中文拼音全拼），无需 WBI / 登录
   *  · 综合搜索 https://api.bilibili.com/x/web-interface/wbi/search/all/v2
   *             data.result[] 带 result_type；data.pageinfo 给各类型 numResults（tab 上的 99+）
   *  · 分类搜索 https://api.bilibili.com/x/web-interface/wbi/search/type
   *             search_type 枚举：video / media_bangumi / media_ft / live_room /
   *             live / live_user / article / topic / bili_user / photo（WBI 签名）
   *  · 热搜     https://api.bilibili.com/x/web-interface/search/square?limit=10
   * 所有结果只在浮层里渲染；点结果只开主站合法 URL，绝不回 search / m 域。
   * ============================================================ */
  const FS_TABS = [
    { id: 'all',           label: '综合', type: '' },
    { id: 'video',         label: '视频', type: 'video' },
    { id: 'media_bangumi', label: '番剧', type: 'media_bangumi' },
    { id: 'media_ft',      label: '影视', type: 'media_ft' },
    { id: 'live_room',     label: '直播', type: 'live_room' },
    { id: 'article',       label: '专栏', type: 'article' },
    { id: 'bili_user',     label: '用户', type: 'bili_user' }
  ];
  function fsCount(n) {
    n = Number(n) || 0;
    if (!n) return '';
    return n > 99 ? '99+' : String(n);
  }
  function fsHistory() {
    const f = CORE.floatSearch;
    if (!f.history.length) {
      try { f.history = (Store.get('fsHistory', []) || []).filter(x => typeof x === 'string').slice(0, 12); }
      catch (e) { f.history = []; }
    }
    return f.history;
  }
  function fsPushHistory(kw) {
    const k = (kw || '').trim(); if (!k) return;
    const h = fsHistory().filter(x => x !== k);
    h.unshift(k);
    CORE.floatSearch.history = h.slice(0, 12);
    try { Store.set('fsHistory', CORE.floatSearch.history); } catch (e) {}
  }
  function fsClearHistory() {
    CORE.floatSearch.history = [];
    try { Store.del('fsHistory'); } catch (e) {}
    fsRenderBody();
  }
  function fsEl(sel) { return $(sel, sr); }
  function openFloatSearch(kw, autoSearch) {
    const f = CORE.floatSearch;
    const box = fsEl('.bpe-search');
    if (!box) return;
    if (CORE.nativeSearch.open) closeNativeSearch('打开浮层前先复原', { silent: true });
    if (host) host.style.zIndex = '2147483647';
    box.hidden = false;
    f.open = true; f.suggest = []; f.sugIndex = -1; f.sugSeq++;
    f.busy = false; f.lastError = '';
    const input = fsEl('.bpe-search-input');
    if (input) {
      input.value = kw || '';
      fsSyncClear();
      setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} } }, 40);
    }
    f.tab = 'all'; f.counts = null; f.results = []; f.kw = '';
    fsRenderTabs(); fsRenderBody();
    if (!f.hot.length && CFG.floatHot) fetchHot();
    if (kw && autoSearch) { fsPushHistory(kw); runFloatSearch(kw, 'all'); }
    LOG('Search', '浮层搜索已打开' + (kw ? ' · 关键词=' + kw : ''));
    CORE.floatDiag = Object.assign({}, CORE.floatDiag || {}, {
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      opened: true, page: location.pathname, kw: kw || '', tab: f.tab
    });
  }
  function closeFloatSearch() {
    const box = fsEl('.bpe-search');
    closeSearch();                       // 复用既有的 host 层级保护
    CORE.floatSearch.busy = false;
    CORE.floatSearch.sugSeq++;           // 让在途的联想响应作废
    try { const i = fsEl('.bpe-search-input'); if (i) i.blur(); } catch (e) {}
    setKbdState(false);
    LOG('Search', '浮层搜索已关闭');
  }
  function fsSyncClear() {
    const i = fsEl('.bpe-search-input'), c = fsEl('.bpe-fs-clear');
    if (c) c.classList.toggle('show', !!(i && i.value));
  }
  /* ---- 实时联想：防抖 180ms + 序号丢弃迟到响应；失败静默不打扰 ---- */
  let fsSugTimer = null;
  function fsScheduleSuggest(kw) {
    const f = CORE.floatSearch;
    const k = (kw || '').trim();
    f.sugSeq++;
    if (fsSugTimer) clearTimeout(fsSugTimer);
    if (!CFG.floatSuggest || !k) { f.suggest = []; f.sugIndex = -1; fsRenderBody(); return; }
    const seq = f.sugSeq;
    fsSugTimer = setTimeout(() => fetchSuggest(k, seq), 180);
  }
  function fsSuggestTags(r) {
    if (!r) return [];
    const cands = [
      r && r.result && r.result.tag,
      r && r.tag,
      r && r.result && Array.isArray(r.result) && r.result,
      r && r.data && r.data.tag
    ];
    for (const arr of cands) {
      if (!Array.isArray(arr)) continue;
      const out = arr.map(x => (typeof x === 'string' ? x : (x && (x.value || x.name || x.term)) || ''))
        .map(x => stripTags(String(x))).filter(Boolean).slice(0, 10);
      if (out.length) return out;
    }
    return [];
  }
  async function fetchSuggest(kw, seq) {
    const f = CORE.floatSearch;
    const urls = [
      'https://s.search.bilibili.com/main/suggest?term=' + encodeURIComponent(kw) + '&main_ver=v1',
      'https://api.bilibili.com/x/web-interface/search/suggest?term=' + encodeURIComponent(kw)
    ];
    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await biliFetch(urls[i]);
        if (seq !== f.sugSeq || !f.open) return;         // 迟到的响应直接丢
        const tags = fsSuggestTags(r);
        if (tags.length) {
          f.suggest = tags; f.sugIndex = -1; f.sugChannel = i === 0 ? 's.search/main/suggest' : 'api/search/suggest';
          fsRenderBody();
          LOG('Search', '联想词 ' + tags.length + ' 条 · 通道 ' + f.sugChannel);
          CORE.floatDiag = Object.assign({}, CORE.floatDiag || {}, {
            suggestChannel: f.sugChannel, suggestCount: tags.length, suggestKw: kw
          });
          return;
        }
      } catch (e) { /* 跨域被拦就试下一条，都挂就静默 */ }
    }
    if (seq !== f.sugSeq || !f.open) return;
    f.suggest = []; f.sugIndex = -1;
    CORE.floatDiag = Object.assign({}, CORE.floatDiag || {}, {
      suggestChannel: '不可用（跨域被拦，已静默降级）', suggestCount: 0, suggestKw: kw
    });
    fsRenderBody();
  }
  async function fetchHot() {
    try {
      const r = await biliFetch('https://api.bilibili.com/x/web-interface/search/square?limit=10');
      const list = (r && r.data && r.data.trending && r.data.trending.list) || [];
      CORE.floatSearch.hot = list.map(x => String(x.keyword || x.show_name || '')).filter(Boolean).slice(0, 10);
      if (CORE.floatSearch.hot.length && CORE.floatSearch.open && !CORE.floatSearch.kw) fsRenderBody();
      LOG('Search', '热搜 ' + CORE.floatSearch.hot.length + ' 条');
    } catch (e) { /* 拿不到就不显示热搜区，绝不编造 */ }
  }
  /* ---- 分类 tab ---- */
  function fsRenderTabs() {
    const box = fsEl('.bpe-fs-tabs'); if (!box) return;
    const f = CORE.floatSearch;
    box.innerHTML = FS_TABS.map(t => {
      let c = '';
      if (f.counts) {
        const ci = t.id === 'media_bangumi' ? 'media_bangumi' : t.id === 'media_ft' ? 'media_ft' : t.id;
        c = fsCount(f.counts[ci]);
      }
      return '<button class="bpe-fs-tab ' + (f.tab === t.id ? 'on' : '') + '" data-act="fstab:' + t.id + '">' +
        esc(t.label) + (c ? '<i>' + esc(c) + '</i>' : '') + '</button>';
    }).join('');
  }
  /* ---- 把各类型结果归一成同一张卡片 ---- */
  function fsNormalize(raw, forceType) {
    const r = (raw && raw.result_type && raw.data) ? raw.data : (raw || {});
    const kind = String(forceType || raw?.result_type || r.type || '').toLowerCase();
    const urlOf = v => { let u = String(v || ''); if (u.indexOf('//') === 0) u = 'https:' + u; return u; };
    const title = stripTags(r.title || r.name || r.uname || r.show_name || r.keyword || '');
    if (!title) return null;
    let out = { title: title, pic: '', sub: '', kind: '', id: '', badge: '' };
    if (kind === 'bili_user' || kind === 'live_user' || kind === 'upuser') {
      out.kind = 'user'; out.id = String(r.mid || r.uid || ''); out.pic = urlOf(r.upic);
      out.sub = (r.usign ? stripTags(r.usign) + ' · ' : '') + (r.fans ? fsHuman(r.fans) + '粉丝' : '') +
        (r.videos ? ' · ' + r.videos + '个视频' : '');
      out.badge = '用户';
    } else if (kind === 'live_room' || kind === 'live') {
      out.kind = 'live'; out.id = String(r.roomid || r.room_id || r.id || '');
      out.pic = urlOf(r.user_cover || r.cover || r.pic);
      out.sub = (r.uname || r.nickname || '') + (r.online ? ' · ' + fsHuman(r.online) + '人气' : '');
      out.badge = '直播';
    } else if (kind === 'media_bangumi' || kind === 'media_ft' || kind === 'pgc') {
      out.kind = 'pgc'; out.id = String(r.season_id || r.media_id || '');
      out.pic = urlOf(r.cover || r.pic);
      out.sub = [r.season_type_name || (kind === 'media_ft' ? '影视' : '番剧'),
        r.areas || r.area, r.desc ? stripTags(r.desc) : ''].filter(Boolean).join(' · ');
      out.badge = kind === 'media_ft' ? '影视' : '番剧';
    } else if (kind === 'article' || kind === 'topic' || kind === 'photo') {
      out.kind = 'article'; out.id = String(r.id || r.cvid || '');
      out.pic = urlOf((Array.isArray(r.image_urls) && r.image_urls[0]) || r.pic || r.cover);
      out.sub = [r.author || r.uname, r.view ? fsHuman(r.view) + '阅读' : '', r.desc ? stripTags(r.desc) : '']
        .filter(Boolean).join(' · ');
      out.badge = '专栏';
    } else {
      out.kind = 'video'; out.id = String(r.bvid || '');
      out.pic = urlOf(r.pic);
      out.sub = [r.author, r.duration, r.play ? fsHuman(r.play) + '播放' : '', r.favorites ? r.favorites + '收藏' : '']
        .filter(Boolean).join(' · ');
      out.badge = '视频';
    }
    return out;
  }
  function fsHuman(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }
  function fsUrl(kind, id) {
    if (kind === 'video' && /^BV[0-9A-Za-z]{10}$/.test(id)) return 'https://www.bilibili.com/video/' + id;
    if (kind === 'user' && /^\d{1,14}$/.test(id)) return 'https://space.bilibili.com/' + id;
    if (kind === 'live' && /^\d{1,14}$/.test(id)) return 'https://live.bilibili.com/' + id;
    if (kind === 'pgc' && /^\d{1,12}$/.test(id)) return 'https://www.bilibili.com/bangumi/play/ss' + id;
    if (kind === 'article' && /^\d{1,16}$/.test(id)) return 'https://www.bilibili.com/read/cv' + id;
    return '';
  }
  function fsOpen(kind, id) {
    const u = fsUrl(kind, id);
    if (!u) { toast('⚠️ 这条结果没有可用的站内链接'); return; }
    try { window.open(u, '_blank'); } catch (e) { location.href = u; }
    LOG('Search', '打开结果 ' + u);
  }
  /* ---- 主体渲染 ---- */
  function fsRenderBody() {
    const box = fsEl('.bpe-fs-body'); if (!box) return;
    const f = CORE.floatSearch;
    // ① 正在输入 → 实时联想词条优先
    if (f.suggest.length) {
      box.innerHTML = '<div class="bpe-fs-sec"><span>🔎 联想词 · 实时</span><span>↑↓ 选择 · Enter 搜索</span></div>' +
        '<div class="bpe-fs-sug">' + f.suggest.map((w, i) =>
          '<div class="bpe-fs-sugrow ' + (i === f.sugIndex ? 'on' : '') + '" data-act="fssug:' + i + '">' +
            '<span>🔍</span><em>' + esc(w) + '</em><span>联想</span></div>').join('') + '</div>' +
        '<div class="bpe-fs-hint">按 Enter 直接搜输入词，或 ↑↓ 选一条联想词再 Enter</div>';
      return;
    }
    // ② 加载中
    if (f.busy) { box.innerHTML = '<div class="bpe-fs-busy">🔍 正在搜索「' + esc(f.kw) + '」…<br>不跳转任何页面</div>'; return; }
    // ③ 接口失败
    if (f.lastError) {
      box.innerHTML = '<div class="bpe-fs-empty">搜索接口失败：' + esc(f.lastError) +
        '<br>若 Safari 反复重定向：设置 → Safari → 高级 → 网站数据 → 移除 bilibili.com → 刷新。</div>';
      return;
    }
    // ④ 结果态
    if (f.kw) {
      if (!f.results.length) {
        box.innerHTML = '<div class="bpe-fs-empty">没找到「' + esc(f.kw) + '」在「' +
          esc((FS_TABS.find(t => t.id === f.tab) || {}).label || '综合') + '」下的结果。<br>换个分类或关键词试试。</div>';
        return;
      }
      box.innerHTML = '<div class="bpe-fs-sec"><span>找到 ' + f.results.length + ' 条 · 点任意一条在新标签打开</span></div>' +
        f.results.map(r => '<div class="bpe-fs-res" data-act="fsopen:' + r.kind + ':' + esc(r.id) + '">' +
          (r.pic ? '<img src="' + esc(r.pic) + '" referrerpolicy="no-referrer" alt="">' : '<div class="ph"></div>') +
          '<div class="tx"><b><span class="tag">' + esc(r.badge) + '</span>' + esc(r.title) + '</b>' +
          '<small>' + esc(r.sub || '—') + '</small></div></div>').join('');
      return;
    }
    // ⑤ 空态：搜索历史 + bilibili 热搜（贴合原生下拉）
    const hist = CFG.floatHistory ? fsHistory() : [];
    const hot = CFG.floatHot ? (f.hot || []) : [];
    let h = '<div class="bpe-fs-sec"><span>搜索历史</span>' +
      (hist.length ? '<button data-act="fshclear">清空</button>' : '') + '</div>';
    h += hist.length
      ? '<div class="bpe-fs-chips">' + hist.map((w, i) => '<button class="bpe-fs-chip" data-act="fshist:' + i + '">' + esc(w) + '</button>').join('') + '</div>'
      : '<div class="bpe-fs-hint">还没有搜索历史 · 输入即出联想词</div>';
    if (hot.length) {
      h += '<div class="bpe-fs-sec"><span>bilibili 热搜</span><span>来自 B 站官方接口</span></div>' +
        '<div class="bpe-fs-chips">' + hot.map((w, i) =>
          '<button class="bpe-fs-chip hot" data-act="fshot:' + i + '"><b>' + (i + 1) + '</b>' + esc(w) + '</button>').join('') + '</div>';
    }
    h += '<div class="bpe-fs-hint">输入后按 <b>Enter</b> 出结果 · 结果页可切换 综合 / 视频 / 番剧 / 影视 / 直播 / 专栏 / 用户</div>';
    box.innerHTML = h;
  }
  /* ---- 搜索：综合 all/v2 + 分类 search/type ---- */
  async function runFloatSearch(kw, tab) {
    const f = CORE.floatSearch;
    const k = (kw || '').trim(); if (!k) return;
    if (f.busy) return;
    f.busy = true; f.kw = k; f.tab = tab || 'all'; f.lastError = '';
    f.suggest = []; f.sugIndex = -1; f.sugSeq++;
    f.results = [];
    fsRenderBody();
    const t = FS_TABS.find(x => x.id === f.tab) || FS_TABS[0];
    let data = null, lastErr = '', channel = '';
    try {
      const mixin = await getWbiKey();
      const params = t.type
        ? { search_type: t.type, keyword: k, page: 1 }
        : { keyword: k };
      const q = signWbi(params, mixin);
      const path = t.type ? '/x/web-interface/wbi/search/type?' : '/x/web-interface/wbi/search/all/v2?';
      const r = await biliFetch('https://api.bilibili.com' + path + q);
      if (r && r.code === 0) { data = r.data; channel = 'wbi/' + (t.type || 'all/v2'); }
      else lastErr = (r && r.message) || ('code ' + (r && r.code));
    } catch (e) { lastErr = e.message; }
    if (!data) {
      try {
        const u = t.type
          ? 'https://api.bilibili.com/x/web-interface/search/type?search_type=' + t.type + '&keyword=' + encodeURIComponent(k) + '&page=1'
          : 'https://api.bilibili.com/x/web-interface/search/all/v2?keyword=' + encodeURIComponent(k);
        const r2 = await biliFetch(u);
        if (r2 && r2.code === 0) { data = r2.data; lastErr = ''; channel = 'old/' + (t.type || 'all/v2'); }
        else if (!lastErr) lastErr = (r2 && r2.message) || '接口返回异常';
      } catch (e) { lastErr = lastErr || e.message; }
    }
    f.busy = false;
    if (data) {
      // 综合搜索的 pageinfo 给各分类计数，正是原生结果页「视频 99+ / 用户 2」的来源
      if (!t.type && data.pageinfo) {
        const c = {};
        Object.keys(data.pageinfo).forEach(key => {
          const o = data.pageinfo[key];
          c[key] = (o && (o.numResults != null ? o.numResults : o.total)) || 0;
        });
        f.counts = c;
      }
      const list = Array.isArray(data.result) ? data.result : [];
      f.results = list.map(x => fsNormalize(x, t.type || '')).filter(Boolean).slice(0, 30);
      LOG('Search', '结果 ' + f.results.length + ' 条 · 分类=' + f.tab + ' · 通道=' + channel);
      CORE.floatDiag = Object.assign({}, CORE.floatDiag || {}, {
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        kw: k, tab: f.tab, channel: channel, count: f.results.length,
        counts: f.counts ? { video: f.counts.video, bili_user: f.counts.bili_user, article: f.counts.article } : null,
        lastError: ''
      });
    } else {
      f.lastError = lastErr || '未知错误';
      CORE.floatDiag = Object.assign({}, CORE.floatDiag || {}, {
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        kw: k, tab: f.tab, channel: '失败', count: 0, lastError: f.lastError
      });
    }
    fsRenderTabs(); fsRenderBody();
  }
  function doFloatSearch(kw) {
    const input = fsEl('.bpe-search-input');
    const k = (kw || (input ? input.value : '') || '').trim();
    if (!k) return;
    if (input) input.value = k;
    fsSyncClear();
    fsPushHistory(k);
    runFloatSearch(k, CORE.floatSearch.tab);
  }
  function fsTab(id) {
    const t = FS_TABS.find(x => x.id === id); if (!t) return;
    CORE.floatSearch.tab = id;
    fsRenderTabs();
    if (CORE.floatSearch.kw) runFloatSearch(CORE.floatSearch.kw, id);
  }
  function fsPickSuggest(i) {
    const f = CORE.floatSearch;
    const w = f.suggest[i]; if (!w) return;
    const input = fsEl('.bpe-search-input'); if (input) input.value = w;
    fsSyncClear(); fsPushHistory(w); runFloatSearch(w, f.tab);
  }
  function fsMoveSuggest(d) {
    const f = CORE.floatSearch;
    if (!f.suggest.length) return false;
    f.sugIndex = (f.sugIndex + d + f.suggest.length + 1) % (f.suggest.length + 1);
    if (f.sugIndex === f.suggest.length) f.sugIndex = -1;   // 回到「输入词本身」
    fsRenderBody();
    return true;
  }
  /* v1.3 沿用：官方搜索框回车 / 点热搜 / window.open 都汇到这里，
     统一收起原生下拉 → 打开 v1.9 浮层 → 直接出分类结果；绝不回 search 域。 */
  function hijackOfficialSearch(kw) {
    const k = (kw || '').trim();
    if (CORE.nativeSearch.open) closeNativeSearch('提交搜索', { silent: true, keepValue: true });
    if (!k) { openFloatSearch(); return; }
    openFloatSearch(k, true);
    toast('🔍 已在浮层里搜索「' + k + '」· 不跳页面');
  }
  /* 旧别名：Esc / 设置页「搜索」按钮 / 工具条都在调 */
  function doSearch() { return doFloatSearch(); }
  function installSearchGuard() {
    // ① 表单提交（B 站顶部搜索框按 Enter / 点搜索按钮最常见路径）
    document.addEventListener('submit', e => {
      const f = e.target;
      let input = null;
      try { input = f && f.querySelector && f.querySelector('input'); } catch (_) {}
      if (officialSearchInput(input) || (f && /nav-search|search/i.test((f.id || '') + ' ' + (f.className || '')))) {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        try { input && input.blur(); } catch (_) {}
        hijackOfficialSearch(input ? input.value : '');
        LOG('Search', '已拦截 B 站原生表单提交');
      }
    }, true);
    // ② 点击搜索建议 / 搜索按钮里的链接
    document.addEventListener('click', e => {
      const path = (e.composedPath && e.composedPath()) || [e.target];
      const a = path.find(n => n && n.tagName === 'A' && n.href);
      if (!a) return;
      if (/search\.bilibili\.com|m\.bilibili\.com\/search|\/search\?keyword|search\.bilibili/i.test(a.href)) {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        let kw = '';
        try { kw = new URL(a.href, location.href).searchParams.get('keyword') || ''; } catch (_) {}
        if (!kw) { const i = firstMatch(['#nav-searchform input', '.nav-search-input', 'input[placeholder*="搜索"]']); kw = i ? i.value : ''; }
        hijackOfficialSearch(kw);
        LOG('Search', '已拦截搜索链接跳转');
      }
    }, true);
    // ③ 脚本主动 window.open 到搜索域
    try {
      const pw = pageWindow();
      const orig = pw.open;
      if (orig && !orig.__bpeWrapped) {
        const wrapped = function (u) {
          if (typeof u === 'string' && /search\.bilibili\.com|m\.bilibili\.com\/search|\/search\?keyword/i.test(u)) {
            let kw = '';
            try { kw = new URL(u, location.href).searchParams.get('keyword') || ''; } catch (_) {}
            hijackOfficialSearch(kw);
            LOG('Search', '已拦截 window.open 搜索跳转');
            return null;
          }
          return orig.apply(this, arguments);
        };
        wrapped.__bpeWrapped = true;
        pw.open = wrapped;
      }
    } catch (e) { LOG('Search', 'window.open 防护未安装：' + e.message); }
  }
  Bus.register('searchZoom', toggleNativeSearch);   // v1.9：S = 原生优先 / 没有则浮层
  Bus.register('floatSearch', toggleFloatSearch);  // v1.9：独立快捷键，永远画浮层
  Bus.register('searchGo', doSearch);
  Bus.register('floatDiag', () => {
    const f = CORE.floatSearch;
    const d = Object.assign({}, CORE.floatDiag || { note: '尚未打开过浮层搜索' }, {
      checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      isOpen: f.open, page: location.pathname, kw: f.kw, tab: f.tab,
      results: f.results.length, suggest: f.suggest.length,
      suggestChannel: f.sugChannel, hot: f.hot.length, history: fsHistory().length,
      cfg: { floatSuggest: CFG.floatSuggest, floatHot: CFG.floatHot, floatHistory: CFG.floatHistory,
        nativeFallbackFloat: CFG.nativeFallbackFloat, key: CFG.shortcuts.floatSearch }
    });
    copyText(JSON.stringify(d, null, 2));
    toast('已复制浮层搜索诊断 · 看 suggestChannel / channel / lastError');
    render();
  });
  Bus.register('searchRetry', () => {
    // v1.8.1：播放页顶栏异步渲染时，给一个明确的手动重试入口
    if (CORE.nativeSearch.open) closeNativeSearch('重试前先复原', { silent: true });
    nsPokeHeader(true);
    setTimeout(() => openNativeSearch(1), 60);
    toast('🔄 正在重新唤出 B 站原生搜索…');
  });
  Bus.register('searchDiag', () => {
    const d = Object.assign({}, CORE.nativeSearchDiag || { result: '尚未使用原生搜索' }, {
      checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      nativeSearchToggle: CFG.nativeSearchToggle, toggleKey: CFG.shortcuts.searchZoom || 'S',
      isOpen: CORE.nativeSearch.open, page: location.pathname,
      forcedRevealed: CORE.nativeSearch.revealed,
      forcedCount: (CORE.nativeSearch.forced || []).length,
      revealAttempts: CORE.nativeSearch.revealAttempts,
      dockOpen: CORE.dockOpen,
      activeElement: document.activeElement ? ((document.activeElement.id || '') + '.' +
        (typeof document.activeElement.className === 'string' ? document.activeElement.className : '')) : null
    });
    copyText(JSON.stringify(d, null, 2));
    toast('已复制搜索诊断 · 看 selector / panelVisible / panelAfter');
    render();
  });

  /* ============================================================
   * 11. 分区 / UP 主屏蔽：软隐藏 + 单一 Observer + 异步 tid 查询
   * ============================================================ */
  const CARD_SEL = [
    '.bili-video-card', '.video-card', '.video-page-card-small', '.video-page-card',
    '.rank-item', '.bili-rank-list-video__item', '.video-list__item', '.feed-card',
    '.feed2-card', '.bili-space-video-item', '.m-video-card', '.video.i_wrapper', '.search-page .video-list-i'
  ].join(',');
  function cardInfo(card) {
    const a = card.querySelector('a[href*="/video/"], a[href*="BV"]');
    const href = a ? (a.getAttribute('href') || '') : '';
    const bvid = (href.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
    const upA = card.querySelector('a[href*="space.bilibili.com"]');
    let mid = (upA && (upA.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '';
    if (!mid) {
      try { mid = ((card.innerHTML.match(/space\.bilibili\.com\/(\d+)/) || [])[1] || ''); } catch (e) {}
    }
    const au = card.querySelector('.bili-video-card__info--author, .up-name, .author, .up-info-name, a[href*="space.bilibili.com"]');
    const author = (au && (au.textContent || '').trim()) || '';
    const tag = card.querySelector('.bili-video-card__info--tag, .rcmd-tag, [class*="partition"], [class*="tname"]');
    const tagText = (tag && (tag.textContent || '').trim()) || '';
    const ti = card.querySelector('.bili-video-card__info--tit, .title, h3, h4');
    const title = (ti && ((ti.getAttribute('title') || ti.textContent || '').trim())) || '';
    return { bvid, mid, author, tagText, title };
  }
  function findPh(card) {
    const kids = card.children || [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains('bpe-hide-ph')) return kids[i];
    }
    return null;
  }
  function dropPh(card) {
    const ph = findPh(card);
    if (ph && ph.remove) ph.remove();
    card.classList.remove('bpe-ph');
    card.removeAttribute('data-bpe-ph-why');
  }
  /* v1.7：把「空白容器」变成写有「与学习无关」的占位卡。
     用 textContent 写文案（why 来自接口 tname / UP 昵称，绝不拼 HTML）。 */
  function syncHidePh(card, why) {
    if (!CFG.hidePlaceholder) { dropPh(card); return; }
    card.classList.add('bpe-ph');
    let ph = findPh(card);
    if (!ph) {
      ph = document.createElement('div');
      ph.className = 'bpe-hide-ph';
      const ico = document.createElement('span'); ico.className = 'bpe-ph-ico'; ico.textContent = '🎯';
      const txt = document.createElement('span'); txt.className = 'bpe-ph-txt'; txt.textContent = '与学习无关';
      const sub = document.createElement('span'); sub.className = 'bpe-ph-why';
      ph.appendChild(ico); ph.appendChild(txt); ph.appendChild(sub);
      ph.__sub = sub;                       // 直接存引用，避免依赖 querySelector
      card.appendChild(ph);
    }
    const w = why || '';
    if (card.getAttribute('data-bpe-ph-why') !== w) {
      if (ph.__sub) { ph.__sub.textContent = w; ph.__sub.style.display = w ? '' : 'none'; }
      card.setAttribute('data-bpe-ph-why', w);
    }
  }
  function hideCard(card, why) {
    const was = card.classList.contains('bpe-hide');
    card.setAttribute('data-bpe-why', why);
    syncHidePh(card, why);                 // 配置从「关 → 开」时，已隐藏的卡也要补上占位
    if (!was) {
      card.classList.add('bpe-hide');
      CORE.hiddenCount++;
      scheduleBar();
    }
  }
  function unhideCard(card) {
    if (!card.classList.contains('bpe-hide')) return;
    card.classList.remove('bpe-hide');
    card.removeAttribute('data-bpe-why');
    dropPh(card);
    CORE.hiddenCount = Math.max(0, CORE.hiddenCount - 1);
    scheduleBar();
  }
  function evaluateCard(card) {
    if (!CFG.learnMode) { unhideCard(card); return; }
    const info = cardInfo(card);
    let why = '';
    for (const u of CFG.blockedUps) {
      if ((u.mid && info.mid && String(u.mid) === String(info.mid)) ||
          (u.name && info.author && u.name.toLowerCase() === info.author.toLowerCase())) { why = 'UP 主 · ' + (u.name || info.author); break; }
    }
    const z = info.bvid ? zoneCache[info.bvid] : null;
    const tid = z && z.tid ? (TID_PARENT[z.tid] || z.tid) : null;
    const zoneName = (z && z.tname) || info.tagText || '';
    if (!why && tid && CFG.blockedTids.indexOf(tid) >= 0) {
      why = '分区 · ' + ((ZONES.find(x => x.tid === tid) || {}).name || z.tname || tid);
    }
    if (!why && zoneName) {
      for (const zz of ZONES) {
        if (CFG.blockedTids.indexOf(zz.tid) >= 0 && (zoneName.indexOf(zz.name) >= 0 || zz.name.indexOf(zoneName) >= 0)) {
          why = '分区 · ' + zoneName; break;
        }
      }
    }
    if (!why && info.bvid && CFG.zoneLookup && !z) enqueueZone(info.bvid, card);
    if (why) hideCard(card, why); else unhideCard(card);
  }
  const zoneQ = [];
  let zoneRunning = 0;
  function enqueueZone(bvid, card) {
    if (zoneCache[bvid] || zoneQ.some(j => j.bvid === bvid)) return;
    zoneQ.push({ bvid, card }); pumpZone();
  }
  function pumpZone() {
    while (zoneRunning < 2 && zoneQ.length) {
      const job = zoneQ.shift(); zoneRunning++;
      biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(job.bvid))
        .then(j => {
          const tid = j && j.data && j.data.tid;
          const tname = (j && j.data && j.data.tname) || '';
          zoneCache[job.bvid] = { tid: tid || 0, tname: tname };
          const keys = Object.keys(zoneCache);
          if (keys.length > 600) delete zoneCache[keys[0]];
          Store.set('zoneCache', zoneCache);
          if (job.card && job.card.isConnected) evaluateCard(job.card);
        })
        .catch(e => { zoneCache[job.bvid] = { tid: 0, tname: '' }; LOG('Zone', job.bvid + ' 查询失败：' + e.message + '（降级为标签匹配）'); })
        .finally(() => { zoneRunning--; pumpZone(); });
    }
  }
  function scanCards() {
    const cards = deepFind(CARD_SEL);
    let budget = 160;
    for (const card of cards) {
      if (budget-- <= 0) break;
      if (card.dataset.bpeSeen !== '1') {
        card.dataset.bpeSeen = '1';
        card.classList.add('bpe-card');
        if (CFG.showBlockButtons) addBlockButton(card);
      }
      evaluateCard(card);
    }
  }
  function addBlockButton(card) {
    if (card.querySelector(':scope > .bpe-blk')) return;
    const info = cardInfo(card);
    const b = document.createElement('button');
    b.className = 'bpe-blk'; b.type = 'button'; b.textContent = '✕';
    b.title = '屏蔽此 UP 主';
    b.setAttribute('data-bpe-mid', info.mid || '');
    b.setAttribute('data-bpe-name', info.author || '');
    card.appendChild(b);
  }
  document.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('.bpe-blk') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const mid = b.getAttribute('data-bpe-mid') || '';
    const name = b.getAttribute('data-bpe-name') || '未知 UP';
    if ((mid && CFG.blockedUps.some(u => String(u.mid) === String(mid))) ||
        (!mid && CFG.blockedUps.some(u => u.name === name))) { toast('该 UP 已在名单里'); return; }
    CFG.blockedUps.push({ mid, name }); save(); applyCfg();
    toast('已屏蔽 ' + name + ' · 可在「专注屏蔽」恢复');
  }, false);
  let barTimer = null;
  function scheduleBar() { if (barTimer) return; barTimer = setTimeout(() => { barTimer = null; updateBar(); }, 120); }
  function applyBarPos() {
    const bar = $('.bpe-filterbar', sr); if (!bar) return;
    if (CORE.barPos && typeof CORE.barPos.x === 'number') {
      bar.style.left = CORE.barPos.x + 'px';
      bar.style.top = CORE.barPos.y + 'px';
      bar.style.right = 'auto'; bar.style.bottom = 'auto';
    } else {
      bar.style.left = ''; bar.style.top = ''; bar.style.right = ''; bar.style.bottom = '';
    }
    setTimeout(() => avoidSearchBox(bar), 60);
  }
  function avoidSearchBox(bar) {
    if (!CFG.barAvoidSearch || !bar || bar.hidden) return;
    const s = firstMatch(['#nav-searchform', '.bili-header__search', '.nav-search',
      '.center-search-container', '[class*="nav-search"]', '[class*="header-search"]']);
    if (!s || !s.getBoundingClientRect) return;
    const a = s.getBoundingClientRect(), b = bar.getBoundingClientRect ? bar.getBoundingClientRect() : null;
    if (!a.width || !a.height || !b || !b.width) return;
    const overlap = !(b.right < a.left || b.left > a.right || b.bottom < a.top || b.top > a.bottom);
    if (overlap) {
      bar.style.top = Math.max(6, window.innerHeight - (b.height || 44) - 18) + 'px';
      bar.style.bottom = 'auto';
      LOG('Bar', '已自动避开顶部搜索框');
    }
  }
  function updateBar() {
    const bar = $('.bpe-filterbar', sr); if (!bar) return;
    bar.hidden = !CFG.learnMode;
    if (!CFG.learnMode) return;
    bar.classList.toggle('min', !!CFG.barMinimized);
    if (CFG.barMinimized) {
      bar.innerHTML = '<button class="bpe-bar-restore" data-act="barmax" title="展开">🎯</button>';
    } else {
      bar.innerHTML = '<span class="bpe-bar-handle" data-drag="1" title="按住拖动，避开搜索框"></span>' +
        '<span>🎯 <b>学习模式</b> · 已隐藏 <b>' + CORE.hiddenCount + '</b> 项</span>' +
        '<button data-act="peek">临时显示</button>' +
        '<button data-act="cmd:learn">关闭</button>' +
        '<button data-act="barmin" title="收起">—</button>' +
        '<button data-act="panel">设置</button>';
    }
    applyBarPos();
  }
  function setupBarDrag() {
    const bar = $('.bpe-filterbar', sr); if (!bar) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    bar.addEventListener('pointerdown', e => {
      const handle = e.target && e.target.closest ? e.target.closest('[data-drag]') : null;
      if (!handle || CFG.barMinimized) return;
      e.preventDefault(); e.stopPropagation();
      const r = bar.getBoundingClientRect ? bar.getBoundingClientRect() : { left: 14, top: 400 };
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      bar.classList.add('dragging');
      try { if (bar.setPointerCapture && e.pointerId != null) bar.setPointerCapture(e.pointerId); } catch (_) {}
    });
    bar.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const w = bar.offsetWidth || 300, hgt = bar.offsetHeight || 44;
      const x = Math.max(6, Math.min(window.innerWidth - w - 6, ox + dx));
      const y = Math.max(6, Math.min(window.innerHeight - hgt - 6, oy + dy));
      bar.style.left = x + 'px'; bar.style.top = y + 'px';
      bar.style.right = 'auto'; bar.style.bottom = 'auto';
      CORE.barPos = { x: x, y: y };
    });
    const end = () => {
      if (!dragging) return;
      dragging = false; bar.classList.remove('dragging');
      if (moved && CORE.barPos) { Store.set('barPos', CORE.barPos); LOG('Bar', '位置已记住'); }
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }
  function setKbdState(on) {
    const el = $('.bpe-kbdstate', sr); if (el) el.hidden = !on;
  }
  function updateKbdState() {
    const a = document.activeElement;
    setKbdState(!!(a && isEditable(a)));
  }
  function peekHidden() {
    const list = deepFind('.bpe-hide');
    list.forEach(c => c.classList.remove('bpe-hide'));
    toast('临时显示 ' + list.length + ' 项，10 秒后恢复');
    setTimeout(() => list.forEach(c => { if (CFG.learnMode && c.getAttribute('data-bpe-why')) c.classList.add('bpe-hide'); }), 10000);
  }

  /* ============================================================
   * 12. 截帧（CORS 污染探针 + 系统分享优先）
   * ============================================================ */
  Bus.register('capture', captureFrame);
  async function captureFrame() {
    const v = findVideo();
    if (!v || !v.videoWidth) { toast('没有可截取的画面'); return; }
    const scale = Math.min(1, (Number(CFG.captureMaxWidth) || 1920) / v.videoWidth);
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    let ok = false, err = '';
    try { ctx.drawImage(v, 0, 0, w, h); ctx.getImageData(0, 0, 1, 1); ok = true; }
    catch (e) { err = e.message; }
    if (!ok) {
      try {
        const clone = document.createElement('video');
        clone.crossOrigin = 'anonymous'; clone.muted = true; clone.playsInline = true; clone.preload = 'auto';
        clone.src = v.currentSrc;
        await new Promise((res, rej) => {
          const to = setTimeout(() => rej(new Error('加载超时')), 4500);
          clone.addEventListener('loadeddata', () => { clearTimeout(to); res(); }, { once: true });
          clone.addEventListener('error', () => { clearTimeout(to); rej(new Error('视频源不允许跨域读取')); }, { once: true });
        });
        clone.currentTime = v.currentTime;
        await new Promise(r => setTimeout(r, 140));
        ctx.drawImage(clone, 0, 0, w, h); ctx.getImageData(0, 0, 1, 1); ok = true;
      } catch (e) { err = e.message; }
    }
    if (!ok) {
      toast('截帧失败：' + err + '。请改用 iPad 截屏组合键');
      LOG('Capture', '失败 ' + err); return;
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    if (!blob) { toast('PNG 生成失败'); return; }
    CORE.previewBlob = blob;
    const url = URL.createObjectURL(blob);
    const box = $('.bpe-preview', sr);
    box.hidden = false;
    const img = $('.bpe-preview img', sr);
    img.src = url;
    LOG('Capture', w + '×' + h + ' PNG ' + Math.round(blob.size / 1024) + 'KB');
    toast('已截取当前帧 · 长按图片或点「保存到文件」');
  }
  async function saveCapture() {
    const blob = CORE.previewBlob; if (!blob) return toast('请先截帧');
    const name = 'BiliPad_' + (currentBvid() || 'frame') + '_' + Date.now() + '.png';
    const file = new File([blob], name, { type: 'image/png' });
    if (CAP.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'BiliPad 截帧' }); toast('已交给系统分享'); return; }
      catch (e) { /* 用户取消 */ }
    }
    if (CAP.download) {
      try { GM_download({ url: URL.createObjectURL(blob), name: name }); toast('已创建下载任务'); return; } catch (e) {}
    }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      toast('已触发下载');
    } catch (e) { toast('请长按预览图片保存到相册'); }
  }

  /* ============================================================
   * 13. 媒体直链：只读取"当前页面有权播放"的流，不破解、不去水印
   * ============================================================ */
  function pagePlayInfo() {
    try {
      const pw = pageWindow();
      return pw.__playinfo__ || (pw.__INITIAL_STATE__ && pw.__INITIAL_STATE__.playinfo) || window.__playinfo__ || null;
    } catch (e) { return null; }
  }
  function mediaFromPlayInfo(p) {
    const out = [];
    const d = p && p.data;
    if (!d) return out;
    (d.durl || []).forEach((x, i) => out.push({
      kind: '合成 MP4（单文件）', label: '画质 ' + (d.quality || i) + ' · ' + (x.size ? (x.size / 1048576).toFixed(1) + 'MB' : '未知大小'),
      url: x.url || (x.backup_url || [])[0] || '', ext: 'mp4'
    }));
    if (d.dash) {
      (d.dash.video || []).forEach((x, i) => out.push({
        kind: 'DASH 视频（无音轨）', label: 'id ' + (x.id || i) + ' · ' + (x.width || '?') + '×' + (x.height || '?') + (x.codecs ? ' · ' + x.codecs : ''),
        url: x.baseUrl || x.base_url || '', ext: 'm4s'
      }));
      (d.dash.audio || []).forEach((x, i) => out.push({
        kind: 'DASH 音频', label: 'audio ' + (x.id || i), url: x.baseUrl || x.base_url || '', ext: 'm4s'
      }));
    }
    return out.filter(x => x.url);
  }
  async function refreshMedia() {
    let list = mediaFromPlayInfo(pagePlayInfo());
    if (!list.length && CFG.downloadEnabled) {
      const bvid = currentBvid();
      if (!bvid) { toast('请先打开一个视频播放页'); return; }
      toast('正在读取当前视频的播放地址…');
      try {
        const v = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
        if (!v || v.code !== 0 || !v.data) throw new Error(v && v.message ? v.message : '视频信息不可访问');
        const cid = v.data.cid || (v.data.pages && v.data.pages[0] && v.data.pages[0].cid);
        CORE.mediaMeta = { bvid: bvid, cid: cid, title: v.data.title || '', tid: v.data.tid };
        const j = await biliFetch('https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid + '&fnval=1&fnver=0&fourk=1&qn=64');
        if (!j || j.code !== 0 || !j.data) throw new Error(j && j.message ? j.message : '播放地址不可访问');
        list = mediaFromPlayInfo(j);
      } catch (e) {
        toast('读取失败：' + e.message + '（可先播放视频再回来点刷新）');
        LOG('Media', '失败 ' + e.message);
      }
    }
    CORE.media = list;
    render();
    if (list.length) toast('已列出 ' + list.length + ' 条可用直链');
  }
  function downloadAt(i) {
    const it = CORE.media[i]; if (!it || !it.url) return toast('直链不可用');
    const name = 'BiliPad_' + (CORE.mediaMeta && CORE.mediaMeta.bvid ? CORE.mediaMeta.bvid : (currentBvid() || 'video')) + '_' + i + '.' + it.ext;
    if (CAP.download) {
      try {
        GM_download({ url: it.url, name: name, headers: { Referer: 'https://www.bilibili.com/' } });
        toast('已创建下载任务 · 在 Stay 下载管理器查看');
        LOG('Media', 'GM_download ' + name); return;
      } catch (e) { LOG('Media', 'GM_download 不可用：' + e.message); }
    }
    try {
      const a = document.createElement('a');
      a.href = it.url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      toast('已触发直链下载；若 403 请复制链接用带 Referer 的工具');
    } catch (e) { toast('请复制直链后自行下载'); }
  }

  /* ============================================================
   * 14. UI：Shadow DOM 面板 / 悬浮工具条 / Toast / 浮层
   * ============================================================ */
  /* v1.9.2：页签从 8 个收敛为 4 个。旧 id 一律重定向到新页，
     既保证升级后不会停在空白页，也让更新日志历史卡片里的 tab: 按钮继续可用。 */
  const TAB_ALIAS = { play:'switches', keys:'switches', focus:'switches', media:'switches', help:'selfcheck' };
  let sr = null, host = null, toastTimer = null, recording = null;
  let activeTab = (function () {
    try {
      const v = Store.get('activeTab', 'home');
      if (['home','switches','selfcheck','log','donate'].indexOf(v) >= 0) return v;
      if (TAB_ALIAS[v]) return TAB_ALIAS[v];
      return 'home';
    } catch (e) { return 'home'; }
  })();
  function buildUI() {
    host = document.createElement('div');
    host.id = 'bpe-root';
    // v1.8.1：host 自身也必须常年保持最高层，否则 shadow 内 .bpe-stage 的
    // z-index 只在 host 的层叠上下文里生效，会被 B 站播放器层整体盖住。
    host.style.cssText = 'position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(host);
    sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<style>' + UI_CSS + '</style>' +
      '<div class="bpe-stage">' +
        '<div class="bpe-mask" hidden></div>' +
        '<div class="bpe-filterbar" hidden></div>' +
        '<div class="bpe-dock" hidden>' +
          '<button class="bpe-mini" data-act="ratepop">⚡ 倍速</button>' +
          '<button class="bpe-mini" data-act="cmd:fullscreen">⛶ 全屏</button>' +
          '<button class="bpe-mini" data-act="cmd:fillReset">🧹 复位</button>' +
          '<button class="bpe-mini" data-act="cmd:capture">📷 截帧</button>' +
          '<button class="bpe-mini" data-act="cmd:danmu">👁 弹幕显示</button>' +
          '<button class="bpe-mini" data-act="cmd:triple">👍 三连</button>' +
          '<button class="bpe-mini" data-act="cmd:learn">🎯 专注</button>' +
          '<button class="bpe-mini" data-act="panel">🎛 设置</button>' +
        '</div>' +
        '<button class="bpe-fab" data-act="cmd:dock" title="BilibiliPlus Xi/Elio">🎛</button>' +
        '<div class="bpe-ratepop" hidden></div>' +
        '<div class="bpe-panel" hidden>' +
          '<div class="bpe-head">' +
            '<div class="bpe-logo">B</div>' +
            '<div><div class="bpe-title">BilibiliPlus Xi/Elio</div><div class="bpe-sub">by Xi/Elio X. Blaze · iPad · Safari · Stay</div></div>' +
            '<button class="bpe-x" data-act="close">✕</button>' +
          '</div>' +
          '<div class="bpe-body"><nav class="bpe-nav"></nav><main class="bpe-content"></main></div>' +
          '<div class="bpe-foot">v2.0.5 · BilibiliPlus Xi/Elio · by Xi/Elio X. Blaze · 已移除防跳转 / 去 App 横幅</div>' +
        '</div>' +
        '<div class="bpe-toast" hidden></div>' +
        '<div class="bpe-kbdstate" hidden>⌨ 输入中 · 按 Esc 恢复快捷键</div>' +
        '<div class="bpe-search bpe-overlay" hidden>' +
          '<div class="bpe-fs">' +
            '<div class="bpe-fs-top">' +
              '<div class="bpe-fs-inwrap"><span class="bpe-fs-ic">🔍</span>' +
                '<input class="bpe-search-input bpe-fs-input" type="search" placeholder="搜索视频、UP 主、番剧…" autocomplete="off" spellcheck="false">' +
                '<button class="bpe-fs-clear" data-act="fsclear" title="清空">✕</button></div>' +
              '<button class="bpe-fs-go" data-act="searchgo">搜索</button>' +
            '</div>' +
            '<div class="bpe-fs-sub"><b>零跳转</b> · 结果直接列在这里，不打开任何 search / m 域名 · ↑↓ 选联想词 · Esc 关闭</div>' +
            '<div class="bpe-fs-tabs"></div>' +
            '<div class="bpe-fs-body"></div>' +
            '<div class="bpe-fs-foot"><span><b>' + esc(CFG.shortcuts.floatSearch || 'Shift+S') + '</b> 浮层搜索 · <b>S</b> 原生搜索</span><span>点结果在新标签打开</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="bpe-preview bpe-overlay" hidden>' +
          '<div class="bpe-searchbox"><h3>📷 当前画面</h3><p>长按图片可存入相册，或保存到「文件」</p>' +
          '<img alt="视频当前帧"><div class="bpe-actions">' +
          '<button class="bpe-btn primary" data-act="savecap">保存到文件</button>' +
          '<button class="bpe-btn ghost" data-act="closepreview">关闭</button></div></div>' +
        '</div>' +
        '<div class="bpe-confirm bpe-overlay" hidden>' +
          '<div class="bpe-searchbox"><h3>确认操作</h3><p class="bpe-confirm-text"></p>' +
          '<div class="bpe-actions"><button class="bpe-btn primary" data-act="confirmyes">确认</button>' +
          '<button class="bpe-btn ghost" data-act="confirmno">取消</button></div></div>' +
        '</div>' +
      '</div>';
    let confirmCb = null;
    CORE.confirm = (text, cb) => { confirmCb = cb; $('.bpe-confirm-text', sr).textContent = text; $('.bpe-confirm', sr).hidden = false; };
    CORE.confirmResolve = yes => { $('.bpe-confirm', sr).hidden = true; const cb = confirmCb; confirmCb = null; if (yes && cb) cb(); };
    bindUI();
    setupBarDrag();
  }
  function toast(msg) {
    if (!sr) return;
    const t = $('.bpe-toast', sr);
    t.textContent = msg; t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 260); }, 2600);
  }
  function showConfirm(text, cb) { if (CORE.confirm) CORE.confirm(text, cb); else if (window.confirm(text)) cb(); }

  const SHORTCUT_LABELS = {
    refresh: '刷新推荐（点击后验证卡片真的变化）', danmu: '弹幕显示开关（点真实状态载体并验证）',
    searchZoom: '原生搜索框：按一下弹出 / 再按关闭复原', floatSearch: '浮层搜索（原生风格 · 联想词 · 分类结果）',
    triple: '一键三连（官方接口）', capture: '截取当前画面',
    fullscreen: '全屏 / 退出（转发 B 站按钮）', fillToggle: '填充模式循环切换',
    fillReset: '复位全屏状态（黑屏自救）',
    mute: '静音切换', rateDown: '降一档倍速（长按相反档键回 1×）',
    rateUp: '升一档倍速（长按相反档键回 1×）', learn: '一键开启 / 恢复学习模式',
    nativeFullscreen: '原生播放器全屏（会丢弹幕·默认不绑）'
  };
  /* v2.0.0 信息架构：4 页 + 打赏页。
     ⌂ 概览＝状态总览 · ⚙ 功能开关＝所有设置 / 键位 / 档位 / 名单 / 直链
     🩺 自检＝诊断 / 登录自检 / 能力探测 / 冲突排查 / 日志 · 🕘 更新日志＝历史
     播放 / 快捷键 / 专注屏蔽 / 下载截帧 / 教程 五个子项已删除，功能全部并入功能开关。 */
  const TABS = [
    { id: 'home',      icon: '⌂',  label: '概览' },
    { id: 'switches',  icon: '⚙',  label: '功能开关' },
    { id: 'selfcheck', icon: '🩺', label: '自检' },
    { id: 'log',       icon: '🕘', label: '更新日志' },
    { id: 'donate',    icon: '♡',  label: '打赏' }
  ];
  /* 页内快速跳转条：每页顶部都给一组，减少在长页里来回翻左侧导航 */
  function tabChips(cur) {
    return '<div class="bpe-tabchips">' + TABS.map(t =>
      '<button data-act="tab:' + t.id + '" class="' + (t.id === cur ? 'on' : '') + '">' + t.icon + ' ' + t.label + '</button>').join('') + '</div>';
  }
  const sw = (k, label, desc) => '<div class="bpe-row"><div class="bpe-row-t"><b>' + label + '</b><small>' + desc + '</small></div>' +
    '<label class="bpe-switch"><input type="checkbox" data-cfg="' + k + '" ' + (CFG[k] ? 'checked' : '') + '><span></span></label></div>';
  const btn = (act, text, cls) => '<button class="bpe-btn ' + (cls || '') + '" data-act="' + act + '">' + text + '</button>';

  function tabHome() {
    const conflicts = detectConflicts();
    const tiles = [
      ['扩展倍速', CFG.rateEnabled ? '0.5× ~ 5× 共 ' + CFG.rateList.length + ' 档 · 速率仲裁' : '已关闭', CFG.rateEnabled],
      ['全屏智能铺满', '转发 B 站按钮 · 不动 DOM', CFG.fillEnabled],
      ['键盘快捷键', '单监听 · S 原生 / Shift+S 浮层 · ' + Object.keys(CFG.shortcuts).length + ' 条命令', true],
      ['分区屏蔽', CFG.learnMode ? (CFG.hidePlaceholder ? '占位置「与学习无关」' : '学习模式开启中') : '一键开启 / 恢复', CFG.learnMode],
      ['UP 主屏蔽', '名单 ' + CFG.blockedUps.length + ' 人', true],
      ['无水印直链', '仅当前有权播放的流', CFG.downloadEnabled],
      ['快捷键截帧', 'CORS 探针 + 系统分享', true],
      ['进页自动播放', CFG.autoPlay ? '带声音优先 / 被拒回退静音' : '已关闭', CFG.autoPlay]
    ].map(t => '<div class="bpe-tile"><b><i class="dot ' + (t[2] ? '' : 'off') + '"></i>' + t[0] + '</b><small>' + t[1] + '</small></div>').join('');
    return '<div class="bpe-hero"><h2>把 B 站调成 iPad 该有的样子</h2>' +
      '<p>能力收进一个脚本：不叠装、不抢键、不抢倍速、不抢样式。所有开关即时生效。</p>' +
      '<div class="bpe-tags"><span>iPad Pro</span><span>iPadOS 26 / 27</span><span>Safari</span><span>Stay</span><span>单脚本</span></div></div>' +
      '<div class="bpe-grid">' + tiles + '</div>' +
      tabChips('home') +
      '<div class="bpe-hint" style="margin:12px 2px">⌂ 概览＝状态总览 · ⚙ 功能开关＝所有设置与键位 · 🩺 自检＝诊断与登录检查 · 🕘 更新日志＝历史改动。所有开关即时生效、自动保存。</div>' +
      '<div class="bpe-actions">' + btn('tab:switches', '⚙ 打开功能开关', 'primary') + btn('tab:selfcheck', '🩺 自检') + btn('tab:log', '🕘 更新日志') + '</div>' +
      (conflicts.length ? '<div class="bpe-hint">⚠️ 检测到同页存在 <b>' + conflicts.join('、') + '</b>，可能有快捷键 / 首页卡片冲突，去「🩺 自检」看排查。</div>' :
        '<div class="bpe-hint">✅ 未检测到主流 B 站改版脚本，当前为单脚本运行环境。</div>') +
      '<div class="bpe-actions">' + btn('cmd:learn', CFG.learnMode ? '🎯 关闭学习模式（恢复全部）' : '🎯 一键开启学习模式', 'primary') + '</div>';
  }

  /* ============================================================
   * v1.9.2 · 功能开关（唯一一页）
   * 所有设置 / 开关 / 键位绑定 / 档位 / 分区 / UP 名单 / 直链都在这里。
   * 控件全部沿用原来的 data-cfg 名称与 bindUI 的 change 委托，
   * 按钮全部沿用原来的 data-act —— 所以 save() / applyCfg() /
   * render() 与命令总线一个字没改，只搬界面，不动逻辑。
   * 每个分组只留「功能名 + 控件 + 一行简洁小字」，不再写版本号，
   * 也不再放更新日志式的大段说明。
   * ============================================================ */
  function tabSwitches() {
    const hint = t => '<div class="bpe-hint">' + t + '</div>';
    const num = (k, label, desc, min, max, step) =>
      '<div class="bpe-row"><div class="bpe-row-t"><b>' + label + '</b><small>' + desc + '</small></div>' +
      '<input class="bpe-input" style="width:110px" type="number" min="' + min + '" max="' + max +
      '" step="' + step + '" data-cfg="' + k + '" value="' + CFG[k] + '"></div>';
    // 键位绑定表：原「快捷键」页整表搬来，data-key / data-act 原样
    const keyRows = Object.keys(SHORTCUT_LABELS).map(k =>
      '<tr><td>' + SHORTCUT_LABELS[k] + '</td><td><span class="bpe-kbd">' + esc(CFG.shortcuts[k] || '—') + '</span></td>' +
      '<td><button class="bpe-btn sm" data-act="rec" data-key="' + k + '">录键</button> <button class="bpe-btn sm" data-act="cmd:' + k + '">试一下</button></td></tr>').join('');
    // 分区 / UP 名单 / 直链：原「专注屏蔽」「下载 / 截帧」页全部搬来
    const zoneChips = ZONES.map(z => '<button class="bpe-chip ' + (CFG.blockedTids.indexOf(z.tid) >= 0 ? 'on' : '') + '" data-act="zone:' + z.tid + '">' + z.name + '</button>').join('');
    const upRows = CFG.blockedUps.length ? CFG.blockedUps.map((u, i) =>
      '<div class="bpe-row"><div class="bpe-row-t"><b>' + esc(u.name || '未命名') + '</b><small>mid: ' + esc(u.mid || '仅按昵称匹配') + '</small></div>' +
      '<button class="bpe-btn sm" data-act="updel:' + i + '">恢复</button></div>').join('') :
      '<div class="bpe-hint">名单为空。可在首页卡片右上角点 ✕ 一键加入，或在下方手动添加。</div>';
    const mediaRows = CORE.media.length ? CORE.media.map((m, i) =>
      '<div class="bpe-row"><div class="bpe-row-t"><b>' + esc(m.kind) + '</b><small>' + esc(m.label) + '</small></div>' +
      '<button class="bpe-btn sm" data-act="copy:' + i + '">复制链接</button> ' +
      '<button class="bpe-btn sm primary" data-act="dl:' + i + '">下载</button></div>').join('') :
      '<div class="bpe-hint">还没有直链。打开一个视频页，播放一下，再点「读取当前视频直链」。</div>';

    return '<h2 class="bpe-h1">功能开关</h2>' +
      '<p class="bpe-lead">所有设置都在这里：开关、键位、档位、名单、直链。<b>即时生效、自动保存</b>。改完点 ×、点遮罩或按 Esc 关闭。</p>' +
      tabChips('switches') +

      '<div class="bpe-grouptitle">总开关</div>' +
      '<div class="bpe-card">' +
        sw('enabled', '启用 BilibiliPlus Xi/Elio', '紧急排障时一键让位给 B 站原生页面；F 键仍可用') +
        '<div class="bpe-actions">' + btn('reset', '↺ 恢复默认设置') + btn('closestyle', '👓 临时移除注入样式') + '</div>' +
        hint('关掉总开关后所有快捷键与铺满增强停止工作，配置保留。') + '</div>' +

      '<div class="bpe-grouptitle">⚡ 倍速</div>' +
      '<div class="bpe-card">' +
        '<div class="bpe-chips">' + CFG.rateList.map(r => '<button class="bpe-chip ' + (Math.abs((CFG.rate || 1) - r) < 0.001 ? 'cur' : '') + '" data-act="rate:' + r + '">' + r + '×</button>').join('') + '</div>' +
        '<div class="bpe-actions">' + btn('cmd:rateDown', '［ 降一档') + btn('cmd:rateUp', '］ 升一档') + btn('cmd:rateNormal', '↩︎ 回 1×') + '</div>' +
        sw('rateEnabled', '启用倍速增强', '关闭后不再写入 playbackRate') +
        sw('rememberRate', '记住倍速', '新视频自动套用上次档位；长按归原速会把它清成 1×') +
        sw('longPressCancelRate', '长按相反档键取消倍速', '短按仍升/降一档；同向长按保留连续升降') +
        sw('officialHoldToNormal', '官方长按 3× 松开回 1×', '不拦右方向键；松开后不恢复之前档位') +
        num('holdThresholdMs', '长按判定阈值 (ms)', '当前 ' + (Number(CFG.holdThresholdMs) || 340) + ' ms · Safari 不发 repeat 时按时间兜底', 120, 1200, 20) +
        hint('短按 <code>[</code> / <code>]</code> 升降一档；长按相反档键回 1×；官方长按右方向键 3× 松开也回 1×，不恢复旧档位。') + '</div>' +

      '<div class="bpe-grouptitle">⛶ 全屏</div>' +
      '<div class="bpe-card">' +
        '<div class="bpe-row"><div class="bpe-row-t"><b>画面填充方式</b><small>智能＝横屏裁切去黑边、竖屏完整不裁人脸（推荐）；裁切＝一律无黑边但裁边缘；适应＝完整画面带黑边</small></div>' +
        '<select class="bpe-select" data-cfg="fillMode">' +
          '<option value="auto"' + (CFG.fillMode === 'auto' ? ' selected' : '') + '>智能（默认·推荐）</option>' +
          '<option value="cover"' + (CFG.fillMode === 'cover' ? ' selected' : '') + '>裁切铺满</option>' +
          '<option value="contain"' + (CFG.fillMode === 'contain' ? ' selected' : '') + '>适应（带黑边）</option>' +
        '</select></div>' +
        sw('fillEnabled', '启用铺满增强', '关掉后 F 仍然只是普通地切换 B 站全屏，不会黑屏') +
        '<div class="bpe-actions">' + btn('cmd:fullscreen', '⛶ F 切换全屏', 'primary') + btn('cmd:fillToggle', '⇄ 换模式') + btn('cmd:fillReset', '🧹 复位') + '</div>' +
        hint('F 只是转发 B 站自己的全屏按钮，弹幕与控制栏全程保留。Safari 地址栏与手势条是系统外壳，网页脚本隐藏不了。') + '</div>' +

      '<div class="bpe-grouptitle">🎬 自动播放与音量</div>' +
      '<div class="bpe-card">' +
        sw('autoPlay', '打开视频后自动播放', '关掉则完全按 B 站原生行为') +
        sw('rememberVolume', '记住我调整过的音量', '关掉后仍会解除静音，但不再记忆 / 写回数值') +
        sw('autoUnmute', '自动解除静音', '只在真实手势回调里同步执行，不碰播放状态') +
        num('preferredVolume', '记忆音量 (0–1)', '当前 ' + Math.round(CFG.preferredVolume * 100) + '% · volume 可写=' + (volumeIsSettable() ? '是' : '否（iPad）'), 0, 1, 0.05) +
        '<div class="bpe-actions">' + btn('cmd:autoPlayNow', '🎬 立即尝试起播') + btn('cmd:unmuteNow', '🔊 解除静音') + btn('cmd:mute', 'M 静音切换') + '</div>' +
        hint('带声音优先起播、被拒回退静音；画面跑起来后立即收手，之后暂停一次就停住。iPad 系统音量网页无权读写，记忆的是你最后一次调整的意图值。') + '</div>' +

      '<div class="bpe-grouptitle">🔍 搜索</div>' +
      '<div class="bpe-card">' +
        sw('nativeSearchToggle', 'S 优先使用 B 站原生搜索框', '关掉则 S 也直接画浮层') +
        sw('nativeFallbackFloat', 'S 找不到原生框时自动打开浮层', '关掉则只提示按 Shift+S') +
        sw('floatSuggest', '输入时实时联想词条', '官方 main/suggest，失败静默降级') +
        sw('floatHot', '空态显示 bilibili 热搜', '官方 search/square 接口') +
        sw('floatHistory', '空态显示本地搜索历史', '只存在本机 GM 存储里，不上传') +
        '<div class="bpe-actions">' + btn('cmd:floatSearch', '🪟 浮层搜索', 'primary') + btn('cmd:searchZoom', '🔍 S 原生（无则浮层）') + btn('cmd:searchRetry', '🔄 重试唤出') + '</div>' +
        hint('S 原生优先、没有原生框自动给浮层；Shift+S 永远画浮层（实时联想 / 七栏分类）。回车出结果零导航，一个页面都不跳。') + '</div>' +

      '<div class="bpe-grouptitle">⌨ 键位绑定</div>' +
      '<div class="bpe-card"><table class="bpe-kt">' + keyRows + '</table>' +
        hint('点「录键」后按下想要的键即可改绑（支持 Shift+字母 / Shift+Enter）。全局只挂一个 keydown；输入框与输入法组合态自动让行，Cmd / Ctrl / Alt 不拦截。需要外接键盘，所有命令也有右下 🎛 触控按钮。') + '</div>' +

      '<div class="bpe-grouptitle">🎯 专注屏蔽</div>' +
      '<div class="bpe-card">' +
        sw('zoneLookup', '联网补全分区 tid', '首页卡片不带分区时按 BV 号查一次并缓存；失败自动降级为标签匹配') +
        sw('showBlockButtons', '卡片显示 ✕ 屏蔽按钮', '点一下把该 UP 主加入名单') +
        sw('hidePlaceholder', '空白容器显示「与学习无关」', '保留卡片几何 + 虚线占位卡；关掉则彻底隐藏') +
        sw('barAvoidSearch', '自动避让顶部搜索框', '检测到统计条与 B 站搜索框重叠时自动移到视口下方') +
        '<div class="bpe-actions">' + btn('cmd:learn', CFG.learnMode ? '🎯 关闭并恢复全部' : '🎯 一键开启学习模式', 'primary') + btn('peek', '临时显示 10 秒') + btn('barreset', '↩ 复位统计条位置') + btn('barmin', '收起统计条') + '</div>' +
        '</div>' +
      '<div class="bpe-card"><h3>预设分区</h3><div class="bpe-chips">' + zoneChips + '</div>' +
        hint('粉色＝已屏蔽。子分区自动归并到一级分区，不会误伤知识区。命中后软隐藏，恢复是瞬间的。') + '</div>' +
      '<div class="bpe-card"><h3>UP 主名单 · ' + CFG.blockedUps.length + ' 人</h3>' + upRows +
        '<div class="bpe-actions" style="margin-top:10px"><input class="bpe-input" id="bpe-upmid" placeholder="mid（可选，推荐）" style="width:140px">' +
        '<input class="bpe-input" id="bpe-upname" placeholder="UP 主昵称" style="width:160px">' +
        btn('upadd', '加入名单', 'primary') + '</div>' +
        hint('名单与分区缓存只存本机，不上传、不读取 Cookie 与 Token。') + '</div>' +

      '<div class="bpe-grouptitle">⬇ 下载与截帧</div>' +
      '<div class="bpe-card">' +
        sw('downloadEnabled', '读取当前视频直链', '关掉则不再自动抓取 playurl 流；不影响已列出的链接') +
        num('captureMaxWidth', '截图最大宽度 (px)', '限制内存，长视频建议 1920 以内', 320, 3840, 160) +
        '<div class="bpe-actions">' + btn('mediarefresh', '🔄 读取当前视频直链', 'primary') + btn('cmd:capture', '📷 截取当前画面') + btn('savecap', '保存上一张截图') + btn('copycmd', '复制合并命令') + '</div>' +
        '<div style="margin-top:8px">' + mediaRows + '</div>' +
        hint('当前视频 ' + esc(currentBvid() || '未进入视频页') + ' · 只列你当前有权播放的流；DASH 高清档音视频分离，需 <code>ffmpeg -c copy</code> 合并。直链需要 Referer，请用 Stay 下载管理器。') + '</div>' +

      '<div class="bpe-grouptitle">🛡 交互习惯</div>' +
      '<div class="bpe-card">' +
        sw('confirmTriple', '三连前二次确认', '开启后按 B 会先弹确认卡，防误触') +
        '<div class="bpe-actions">' + btn('cmd:triple', '👍 试一下三连') + btn('cmd:danmu', '👁 试一下弹幕开关') + btn('cmd:refresh', 'R 刷新推荐') + '</div>' +
        hint('三连没硬币会自动补点赞 + 收藏；D 只管弹幕<b>显示</b>，发弹幕请用 B 站官方输入框；R 只在首页生效并核对卡片真的变了。') +
        '</div>' +

      '<div class="bpe-hint" style="margin-top:14px">📋 诊断、登录自检、Stay 能力探测、冲突排查与最近日志都在 <b>🩺 自检</b> 页；历史改动在 <b>🕘 更新日志</b> 页。</div>';
  }

  /* ============================================================
   * v1.9.2 · 自检（从原「教程 / 诊断」里单独拎出来的一页）
   * 只放自检与排障：登录自检 / 诊断 / 能力探测 / 冲突排查 / 日志。
   * 上手教程与版本说明不再塞进设置面板。
   * ============================================================ */
  function tabSelfcheck() {
    const caps = [
      ['GM 存储', CAP.store], ['GM_addStyle', CAP.style], ['GM 菜单', CAP.menu],
      ['GM_download', CAP.download], ['GM_xmlhttpRequest', CAP.xhr],
      ['系统分享', CAP.share], ['剪贴板', CAP.clipboard],
      ['元素全屏 API', CAP.fullscreen], ['原生视频全屏（仅手动命令）', CAP.nativeVideoFullscreen]
    ].map(c => '<span class="bpe-chip ' + (c[1] ? 'on' : '') + '">' + c[0] + (c[1] ? ' ✓' : ' ✕') + '</span>').join('');
    const logs = CORE.logs.slice(-14).reverse().map(l => '<span class="bpe-code" style="margin:4px 0">' + esc(l) + '</span>').join('') || '<div class="bpe-hint">暂无日志</div>';
    const conflicts = detectConflicts();
    return '<h2 class="bpe-h1">自检</h2>' +
      '<p class="bpe-lead">排障工具集中在这里。诊断只记必要字段，<b>不含 Cookie 和登录凭证</b>。</p>' +
      tabChips('selfcheck') +
      '<div class="bpe-grouptitle">🔐 登录自检</div>' +
      '<div class="bpe-card"><div class="bpe-actions">' + btn('logincheck', '🔐 立即自检', 'primary') + '</div>' +
        (CORE.loginDiag ? '<span class="bpe-code">' + esc(JSON.stringify(CORE.loginDiag)) + '</span>' : '<div class="bpe-hint">尚未运行。</div>') +
        '<div class="bpe-hint">检查 <code>bili_jct</code> / <code>SESSDATA</code> / <code>DedeUserID</code> 是否可读，并问 <code>nav</code> 确认登录态（只显示有无）。建议始终用 <b>https://www.bilibili.com/</b> 访问；显示未登录就重新登录并刷新。</div></div>' +
      '<div class="bpe-grouptitle">📋 诊断</div>' +
      '<div class="bpe-card"><div class="bpe-actions">' +
        btn('cmd:autoPlayDiag', '📋 起播诊断') + btn('cmd:volumeDiag', '📋 音量诊断') + btn('cmd:rateDiag', '📋 倍速诊断') +
        btn('cmd:searchDiag', '📋 原生诊断') + btn('cmd:floatDiag', '📋 浮层诊断') + btn('cmd:refreshDiag', '📋 刷新诊断') +
        btn('cmd:danmuDiag', '📋 开关诊断') + btn('cmd:searchRetry', '🔄 重试唤出') +
        btn('cmd:autoPlayNow', '🎬 立即尝试起播') + btn('cmd:unmuteNow', '🔊 解除静音') + btn('cmd:rateNormal', '↩︎ 回 1×') +
        '</div>' +
        '<span class="bpe-code">' + esc(JSON.stringify({ autoPlay: CORE.apDiag || null, switchDiag: CORE.switchDiag || null })) + '</span>' +
        '<div class="bpe-hint">起播 <code>err=NotAllowedError</code> 表示 Safari 要求手势；刷新 <code>已点击但列表未变</code> 可复制命中按钮定位；音量 <code>volumeSettable=false</code> 在 iPad 是正常现象；浮层 <code>suggestChannel=不可用</code> 是联想接口跨域被拦，搜索与分类照常可用。</div></div>' +
      '<div class="bpe-grouptitle">🩺 Stay 能力探测</div>' +
      '<div class="bpe-card"><div class="bpe-chips">' + caps + '</div>' +
        '<div class="bpe-hint">缺项会自动降级（例如用 localStorage 代替 GM 存储、用系统分享代替下载），不会静默失败。</div></div>' +
      '<div class="bpe-grouptitle">⚔️ 冲突排查</div>' +
      '<div class="bpe-card">' +
        (conflicts.length ? '<div class="bpe-hint">⚠️ 检测到同页存在 <b>' + conflicts.join('、') + '</b>，建议在其设置里关闭「首页 / 倍速 / 快捷键」模块，或停用后刷新页面。</div>' :
          '<div class="bpe-hint">✅ 未检测到主流 B 站改版脚本，当前为单脚本运行环境。</div>') +
        '<div class="bpe-actions">' + btn('cmd:fillReset', '🧹 复位全屏（黑屏自救）', 'primary') + btn('diag', '复制诊断信息') + btn('reset', '恢复默认设置') + btn('closestyle', '临时移除注入样式') + '</div>' +
        '<div class="bpe-hint">若某功能异常：先关总开关判断是不是本套件，再导出诊断（不含 Cookie）。若 Safari 缓存了过期重定向，首次仍可能报「太多重定向」：设置 → Safari → 高级 → 网站数据 → 移除 bilibili.com → 刷新。</div></div>' +
      '<div class="bpe-grouptitle">📜 最近日志</div>' +
      '<div class="bpe-card">' + logs + '</div>' +
      '<div class="bpe-hint" style="margin-top:14px">安装步骤、完整键位说明与历史改动见独立教程页 <code>BiliPadSuite-教程页.html</code>；本面板只保留设置与自检。</div>';
  }

  /* ============================================================
   * v2.0.0 · 打赏页
   * 两张码以内嵌 data URI 保存：不依赖图床、不联网、离线也在。
   * 纯静态展示，不校验、不记录、不解锁任何功能。
   * ============================================================ */
  const QR = {
    wechat: 'data:image/jpeg;base64,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',
    alipay: 'data:image/jpeg;base64,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33333333333333333z7333jL3Pv33XXPDvffb/Xj3/jvzn3333z7332hf5Ilyx3y3V3aKYqyZ6Xc3Pn3333z73331x9AjIl4FuExWFsMl32WgcLD3333z73324Gcg6pfls2sB+R51iTXPyNHX3333z73333333333333333333333333333333z73333333333333333333333333333333z73333333333333333333333333333333z73333rXz777777777777777777nP7n/AN8+9999/c8888888888888888888/JgH8+8+99999888888888888888888886CiW438+99999888AA8gEEEskw4UIAM889063ue8+99999888Qk88sgUIUIco4I088sOPX/wDfPvfffffPPPGKAMAFACPEALPNPPKPfffffPvfffffPPKPKFKHDECHDJAMFPPKPfffffPvfffffPPONBIGKJDEMHFOGFPPKPfffffPscMNffPPJCFJHLHLKPHBHDHPPKPfffffOoKbP/fPPPNFFGEgREjSKGEJPPKPfffffKg/DVffPPJBNHNBe/OroDHCNPPKPfffffPiEJPffPKLOPAPOf8AGU3Qwxjjzyj33333z733333zzwSxxhQrSpP4zjyzTzyj33333z733333zzyCwBgADDTAwxyAizzyj33333z733333zzhTSBCjhhBBgDTBTzzyj33333z733333zzzzSwRyBQAiyRzxjzzyj33333z733333zzwwyiADyjhxjSDhBzzyj33333z733333zzwRyiTjiQQjQxACzDzyj33333z733333zzhyzgzTyyQzzgQRzTzyj33333z733333zzzzzzzzzzzzzzzzzzzyjzX733z733333zzzzzzzzzzzzzzzzzzzyjxetb3z733333zzznEHx8Z+yPPHyG7zzyjpy3X3z733333zzxn73oLykeXlj5+P8A88o9Pf8AffPvfffffPPDDHLPHXHL3HPLXX/PKPfffffPvfffe9/ffffffffffffffffffbNfffffPvfffffffffffffffffffffffffffffffPvffffevuttdveMcPvfPfPOMOv9vfffffPvfffffxN2H7tuAcF9nIxhYh8bFffffffPvffffZxyoObPRiot/Hyt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'
  };
  function tabDonate() {
    return '<h2 class="bpe-h1">打赏</h2>' +
      '<p class="bpe-lead">如果它真的让你在 B 站少分了点心，扫码随喜就好。<b>不打赏也全部功能可用</b> —— 没有功能限制、没有弹窗、不会提醒第二次。</p>' +
      tabChips('donate') +
      '<div class="bpe-donate">' +
        '<div class="bpe-qr"><b>微信 · 赞赏码</b><img src="' + QR.wechat + '" alt="微信赞赏码">' +
          '<small>「你的智齿，是我更新的动力」<br>图里这句照原样留着，没舍得改。</small></div>' +
        '<div class="bpe-qr"><b>支付宝 · 扫一扫</b><img src="' + QR.alipay + '" alt="支付宝收款码">' +
          '<small>扫完顺手收点蚂蚁森林能量，<br>算这页附赠的。</small></div>' +
      '</div>' +
      '<div class="bpe-card" style="margin-top:14px"><h3>写在最后</h3>' +
        '<p>从 1.0 到 2.0，搜索不再来回跳、暂停不再抽动、全屏不再黑屏、设置终于收进一页 —— 基本都是你一张张截图喂出来的。所以这页也留给你。<br><br>金额随意，一块钱也是「已读回执」。谢谢。</p>' +
        '<div class="bpe-hint">— Xi/Elio X. Blaze</div></div>' +
      '<div class="bpe-hint" style="margin-top:10px">两张码是内嵌在脚本里的静态图片，离线也在；脚本不联网校验、不记录、不因打赏解锁任何功能。收款与平台规则以微信 / 支付宝为准。</div>';
  }

  /* ============================================================
   * v1.9.1 · 更新日志（独立一页）
   * 历史卡片原样搬过来（一字未改，仍带各自的诊断 / 试一下按钮），
   * 用 <details> 按版本分组折叠，默认只展开当前两版。
   * ============================================================ */
  function logSections() {
    return [
      { t: 'v2.0.5 · 彻底移除防跳转 / 去 App 横幅（当前）', open: true, h:
        '<div class="bpe-card"><h3>你让我「再检查一遍到底哪里出问题」：结论是脚本自己</h3><p>先按你的要求<b>彻底删除</b>了整套功能：两个配置键 <code>blockAppBanner / blockAppJump</code>、开关、CSS 规则、<code>APP_SCHEME / appJumpUrl / biliPageUrl</code>、<code>syncAppMeta / sweepAppBanner / installAppGuard / patchPageLocation / patchAnchorClick / installNativeNavGuard</code>、scheme iframe 清理、<code>appRules / appDiag</code> 命令与菜单入口、自检按钮与提示、更新日志里 v2.0.2~2.0.4 三张卡、教程页对应卡与独立规则文件，全部不留死代码；旧配置键在迁移时一并 <code>delete</code>。<br><br><b>复查结论（与你的实机证据一致，但如实说是最可能而非 100% 实机确认）</b>：你点的是 <code>www.bilibili.com</code> <b>站内</b>的视频 / 主页 / 关注 / 粉丝 / 动态。按 Apple 的 same-domain 规则，Safari 里已打开该域名时点<b>同域</b>链接通常留在 Safari，本来不该跳 App。它却跳了，说明这次导航<b>不是 B 站 SPA 的 <code>preventDefault</code> + <code>router.push</code></b>，而是被降级成「浏览器发起的全新整页 https 导航」，命中 AASA 的 <code>applinks</code> 路径，iOS 才把点击交给 App。谁降的级？<b>就是脚本自己</b>：① v2.0.0/2.0.1 在捕获阶段 <code>stopImmediatePropagation()</code>，掐断 B 站 SPA handler，浏览器回退到 <code>&lt;a&gt;</code> 原生 href（B 站给这些卡片配的正是唤起地址）；② v2.0.3/2.0.4 的 <code>installNativeNavGuard()</code> 在冒泡阶段读 <code>e.defaultPrevented</code> 判断「SPA 没接管」就 <code>preventDefault()</code> + <code>setTimeout(0)</code> 里 <code>location.assign(https://…)</code> —— B 站的事件委托 handler 常在更外层或后注册，脚本先跑时 <code>defaultPrevented</code> 还是 false，于是把站内 SPA 跳误判成整页导航，亲手造出一次会被系统接管的全新导航；③ <code>patchPageLocation()</code> 改 <code>Location.prototype</code>、<code>patchAnchorClick()</code> 包 <code>HTMLAnchorElement.prototype.click</code>、<code>syncAppMeta()</code> 动 <code>&lt;head&gt;</code>、<code>sweepAppBanner()</code> 扫 iframe，全是全局原型 / DOM 级干扰。<b>这正好解释你最早那句「开着反而跳、关了反而不跳」</b>：关掉开关 = 没有这套拦截 = B 站 SPA 正常工作 = 不跳。所以删除不是放弃拦截，是移除制造跳转的那一层。<br><br><b>顺带复查 <code>installSearchGuard()</code></b>：它只匹配搜索表单 <code>submit</code>、<code>search.bilibili.com</code> / <code>m.bilibili.com/search</code> / <code>/search?keyword</code> 链接，以及 <code>window.open</code> 到搜索域，<b>普通视频 / 主页链接不在匹配范围</b> —— 清白，零导航搜索原样保留。<br><br><b>验证方法</b>：覆盖粘贴并刷新 → 点视频 / 主页 / 关注 → 应留在站内。若留住，根因确认。<b>诚实边界</b>：若删除后<b>仍</b>跳，那才是纯系统层 Universal Link（链接指向 <code>space.</code> / <code>m.</code> 等已关联子域、或从别的 App 点进来），网页脚本无解，只能长按链接选「在 Safari 中打开」、卸载 B 站 App，或用 Safari 扩展（拦截100 / AdGuard / wBlock）；本脚本不再加入任何拦截代码。<br><br><b>没动的东西</b>：搜索零导航与双入口、倍速、全屏、起播收手、音量记忆、三连、D 弹幕开关、R 刷新验证、v1.7 占位文字、v2.0.1 滚动保持、5 页签与打赏页、定名与署名。仍是单 keydown / 单 keyup / 单 MutationObserver。</p></div>' +
        '' },
      { t: 'v2.0.1 · 设置页不再回顶', open: false, h:
        '<div class="bpe-card"><h3>一个小 bug 修复</h3><p>在设置页切换任意开关、或录完一个键，<code>render()</code> 会重绘 <code>.bpe-content</code> 的 <code>innerHTML</code>；旧版末尾无条件 <code>content.scrollTop = 0</code>，于是每次都跳回设置页最顶端，长长的功能开关页要重新滚下去。现在 <code>render()</code> 记住上次渲染的页签：<b>同一页内的重绘保留重绘前的 <code>scrollTop / scrollLeft</code></b>（同步还原 + 下一帧兜底，覆盖 iPad Safari 偶发忽略同步赋值）；<b>切换页签、或关闭后重新打开设置仍从顶部开始</b>，既有习惯不变。<br><br>覆盖到的触发点：24 个开关的 <code>change</code>、录键完成、分区点选、UP 名单增删、恢复默认设置、以及所有会重绘面板的操作。<b>只改 <code>render()</code> 与 <code>closePanel()</code> 两处 UI 逻辑</b>，命令注册、配置生效、搜索、倍速、全屏、起播、三连、D 开关、R 刷新一律未动。</p></div>' +
        '' },
      { t: 'v2.0.0 · 正式版定名', open: false, h:
        '<div class="bpe-card"><h3>2.0.0 正式版</h3><p>① 产品正式定名 <b>BilibiliPlus Xi/Elio</b>，作者署名 <b>Xi/Elio X. Blaze</b>；② 新增 <b>♡ 打赏</b> 页，内嵌微信赞赏码与支付宝收款码两张静态图片，不依赖图床、离线可用；③ <b>功能逻辑零改动</b>：所有命令、配置、键位、搜索、倍速、全屏、起播、三连、D 开关、R 刷新、自检与更新日志全部保持 v1.9.2 的行为。内部存储键 <code>bpe.</code>、单实例守卫与控制台前缀保持不变，<b>旧设置不丢、不会重复注入</b>；只改了用户可见的产品名与署名。</p></div>' +
        '' },
      { t: 'v1.9.2 · 全部设置收进一页', open: false, h:
        '<div class="bpe-card"><h3>设置面板再整合</h3><p>① <b>删掉「播放 / 全屏」「快捷键」「专注屏蔽」「下载 / 截帧」「教程 / 诊断」五个子项</b>，功能一个不少地全部搬进 <b>⚙ 功能开关</b>：开关、键位绑定表、倍速档位、预设分区、UP 名单、视频直链、截帧、试一下按钮都在这里。<br>② <b>教程子项删除，自检单开一页</b>：登录自检、诊断按钮、Stay 能力探测、冲突排查、最近日志收进 <b>🩺 自检</b>；上手教程与版本说明不再塞在设置面板里。<br>③ <b>功能上方不再写版本号</b>，每组只留「功能名 + 控件 + 下方一行简洁小字」；大段「症状→根因→修法」卡片全部折叠进「🕘 更新日志」。<br>④ 页签从 8 个收敛为 <b>4 个</b>（概览 / 功能开关 / 自检 / 更新日志），旧页签 id 自动重定向，历史卡片里的按钮不会失效。<b>本版只重排界面，所有 <code>data-cfg</code> / <code>data-act</code> / 命令注册 / 配置生效逻辑一个字没改。</b></p></div>' +
        '' },
      { t: 'v1.9.1 · 设置面板重构', open: false, h:
        '<div class="bpe-card"><h3>把「功能开关」和「更新日志」分开</h3><p>① <b>二级工具条不再压在设置页上</b>：打开设置时收起 dock，并给遮罩 / 面板 / toast 排好显式层级；② <b>功能开关单开一页</b>，所有 <code>data-cfg</code> 控件按 8 组归类，每个开关只出现一次；③ <b>更新日志单开一页</b>，按版本折叠，概览只留状态总览；④ 设置展开时全局快捷键让行，Esc / 点遮罩 / × 都能关。<b>本版只重排界面，没有改动任何命令、配置字段与生效逻辑</b>。</p></div>' +
        '' },
      { t: 'v1.9 · 双入口搜索 / 联想词 / 分类结果', open: true, h:
      '<div class="bpe-card"><h3>v1.9 · 两套搜索各司其职 + 原生风格浮层</h3><p>① <b>有原生框用原生，没有就自动给浮层</b>：<span class="bpe-kbd">S</span> 仍优先唤出 B 站原生搜索下拉（播放页顶栏收起会先戳出来 / 必要时临时亮出）；<b>三种重试后仍找不到原生框时，不再只弹一句失败提示，直接打开自绘浮层</b>，不把人卡住。<br>② <b>新快捷键 <span class="bpe-kbd">Shift+S</span> 专门绘制浮层</b>：无论当前页有没有原生框都画（默认不用 <code>k</code>，因为 B 站播放器把 k 用作播放/暂停；可在「⌨ 快捷键」录键改绑）。<br>③ <b>浮层尽量贴合原生</b>：顶部居中的深色下拉面板、<code>🔍 输入框 + 蓝色「搜索」按钮</code>、不模糊背景；空态显示<b>搜索历史 + bilibili 热搜</b>（本地历史 + 官方 <code>search/square</code> 接口）。<br>④ <b>输入过程中实时联想</b>：防抖 180ms 调官方 <code>s.search.bilibili.com/main/suggest</code>，最多 10 条，支持中文拼音全拼；<b>↑↓ 选词、Enter 搜索</b>，序号丢弃迟到响应；跨域被拦就静默降级，绝不伪造词条。<br>⑤ <b>回车后结果带分类</b>：综合 / 视频 / 番剧 / 影视 / 直播 / 专栏 / 用户 七栏，计数徽标来自综合接口 <code>pageinfo.numResults</code>（就是原生结果页的「视频 99+ / 用户 2」）；切换分类走 <code>search/type</code> 的 <code>search_type</code> 枚举。点结果只开主站合法 URL，<b>零导航不变</b>。</p>' +
        '<div class="bpe-actions">' + btn('cmd:floatSearch', '🪟 打开浮层搜索', 'primary') + btn('cmd:searchZoom', '🔍 S 原生（无则浮层）') + btn('cmd:floatDiag', '📋 浮层诊断') + btn('cmd:searchDiag', '📋 原生诊断') + '</div>' +
        (CORE.floatDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ kw: CORE.floatDiag.kw, tab: CORE.floatDiag.tab, channel: CORE.floatDiag.channel, suggestChannel: CORE.floatDiag.suggestChannel, count: CORE.floatDiag.count, lastError: CORE.floatDiag.lastError })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.9 · 浮层搜索的接口与边界（查证口径）</h3><p><b>联想词</b>：<code>https://s.search.bilibili.com/main/suggest?term=&lt;kw&gt;&amp;main_ver=v1</code> → <code>result.tag[].value</code>，最多 10 条、支持中文拼音全拼，<b>不需要 WBI 签名或登录</b>。脚本防抖 180ms，用序号丢弃迟到响应；两条通道（s.search 主 / api 备）都失败就静默隐藏联想区，<b>不编造词条</b>。<br><b>综合搜索</b>：<code>/x/web-interface/wbi/search/all/v2?keyword=…</code>，<code>data.result[]</code> 带 <code>result_type</code>，<code>data.pageinfo</code> 的 <code>numResults</code> 就是原生结果页「视频 99+ / 用户 2」徽标的来源。<br><b>分类搜索</b>：<code>/x/web-interface/wbi/search/type?search_type=…</code>，查证到的枚举：<code>video / media_bangumi / media_ft / live / live_room / live_user / article / topic / bili_user / photo</code>。本套件只取 7 个常用栏目，切换时重新请求；WBI 签名失败自动退回旧接口。<br><b>热搜</b>：<code>/x/web-interface/search/square?limit=10</code> → <code>data.trending.list[].keyword</code>，拿不到就不显示热搜区。<br><b>零导航红线没动</b>：官方表单提交 / 建议链接 / <code>window.open</code> 仍在捕获阶段被拦截，回车与点热搜词统一转成浮层结果；点结果只按 <code>kind:id</code> 枚举构造主站 URL（BV 号 / mid / roomid / season_id / cv 号都做白名单正则校验），<b>绝不接受任意外链字符串</b>，所以之前修好的「多重重定向崩溃」不会复发。<br><b>证据边界</b>：以上参数来自社区维护的 B 站 API 收集文档，不是 B 站公开 API 合同；WAF / 412 / CORS / B 站改版只能靠实机「📋 浮层诊断」（<code>suggestChannel / channel / count / lastError</code>）确认。<b>整体复核</b>：仍是单 keydown 分发、单 keyup 清理、单 MutationObserver、单实例守卫；浮层状态收在 <code>CORE.floatSearch</code> 一个对象里，Esc / 切回页面 / 再按一次键都会收手。</p></div>' +
        '' },
      { t: 'v1.8.x · 原生搜索与工具条修复', open: false, h:
      '<div class="bpe-card"><h3>v1.8.1 · 两个实机 bug 修复</h3><p>① <b>播放页不是全屏也调不出原生搜索</b>：B 站播放页默认把顶栏收起、甚至用 <code>v-if</code> 不渲染，所以 v1.8 找不到 input 就误报「全屏时顶栏隐藏」。现在<b>先戳 B 站自己</b>：滚到顶部 + 派发 <code>scroll / mouseenter / mousemove</code> 让 mini header 出现；<b>再放宽查找</b>：header 容器 / 搜索 form 里的任意 input 都算候选（排除弹幕 / 评论 / 登录框；不扫全局无关输入框）；<b>仍被 CSS 藏住就临时亮出祖先链</b>（只写 inline style 并逐项快照，关闭时按 <code>cssText</code> 原样还原），并把搜索表单变成顶部浮动条 —— 搜索框、历史词、热搜面板<b>依旧是 B 站原生组件</b>，脚本不重绘内容。重试从 2 次增到 3 次，失败提示不再甩锅「退出全屏」，并新增 <b>🔄 重试唤出</b>。<br>② <b>点右下 🎛 第一级，二级菜单闪一下就消失</b>：两个叠加原因 —— v1.8 的 <code>openNativeSearch()</code> 调了 <code>closeSearch()</code>，而它把 <code>host.style.zIndex</code> 清成 <code>&apos;&apos;</code>；<code>.bpe-stage</code> 的高 z-index 只在 host 的层叠上下文里有效，host 一降级整个工具条就被 B 站播放器层盖住。另外 iPad Safari 触摸可能伴随重复 click，隐式 <code>d.hidden = !d.hidden</code> 会让刚展开的二级菜单被同一次手势再关一次。现在 <b>host 常年保持 2147483647</b>、dock 改<b>显式状态 + 320ms 同手势去重</b>、FAB 点击不冒泡、点二级按钮后保持展开。</p>' +
        '<div class="bpe-actions">' + btn('cmd:searchZoom', '🔍 试一下 S', 'primary') + btn('cmd:searchRetry', '🔄 重试唤出原生搜索') + btn('cmd:searchDiag', '📋 搜索诊断') + btn('cmd:dock', '🎛 展开 / 收起二级菜单') + '</div>' +
        (CORE.nativeSearchDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ result: CORE.nativeSearchDiag.result, selector: CORE.nativeSearchDiag.selector, forcedRevealed: CORE.nativeSearchDiag.forcedRevealed, forcedRestored: CORE.nativeSearchDiag.forcedRestored, dockOpen: CORE.dockOpen })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.8.1 · 两个实机 bug 修复</h3><p>① <b>播放页不是全屏也调不出原生搜索</b>：B 站播放页默认把顶栏收起、甚至用 <code>v-if</code> 不渲染，所以 v1.8 找不到 input 就误报「全屏时顶栏隐藏」。现在<b>先戳 B 站自己</b>：滚到顶部 + 派发 <code>scroll / mouseenter / mousemove</code> 让 mini header 出现；<b>再放宽查找</b>：header 容器 / 搜索 form 里的任意 input 都算候选（排除弹幕 / 评论 / 登录框；不扫全局无关输入框）；<b>仍被 CSS 藏住就临时亮出祖先链</b>（只写 inline style 并逐项快照，关闭时按 <code>cssText</code> 原样还原），并把搜索表单变成顶部浮动条 —— 搜索框、历史词、热搜面板<b>依旧是 B 站原生组件</b>，脚本不重绘内容。重试从 2 次增到 3 次，失败提示不再甩锅「退出全屏」，并新增 <b>🔄 重试唤出</b>。<br>② <b>点右下 🎛 第一级，二级菜单闪一下就消失</b>：两个叠加原因 —— v1.8 的 <code>openNativeSearch()</code> 调了 <code>closeSearch()</code>，而它把 <code>host.style.zIndex</code> 清成 <code>&apos;&apos;</code>；<code>.bpe-stage</code> 的高 z-index 只在 host 的层叠上下文里有效，host 一降级整个工具条就被 B 站播放器层盖住。另外 iPad Safari 触摸可能伴随重复 click，隐式 <code>d.hidden = !d.hidden</code> 会让刚展开的二级菜单被同一次手势再关一次。现在 <b>host 常年保持 2147483647</b>、dock 改<b>显式状态 + 320ms 同手势去重</b>、FAB 点击不冒泡、点二级按钮后保持展开。</p>' +
        '<div class="bpe-actions">' + btn('cmd:searchZoom', '🔍 试一下 S', 'primary') + btn('cmd:searchRetry', '🔄 重试唤出原生搜索') + btn('cmd:searchDiag', '📋 搜索诊断') + btn('cmd:dock', '🎛 展开 / 收起二级菜单') + '</div>' +
        (CORE.nativeSearchDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ result: CORE.nativeSearchDiag.result, selector: CORE.nativeSearchDiag.selector, forcedRevealed: CORE.nativeSearchDiag.forcedRevealed, forcedRestored: CORE.nativeSearchDiag.forcedRestored, dockOpen: CORE.dockOpen })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.8 · 原生搜索弹出 / 再按关闭复原（任何页面）</h3><p><b>你截图里那个「搜索历史 + bilibili热搜」深色下拉</b>就是 B 站原生面板（<code>.search-panel</code>）。旧版 S 键画的是脚本自己的输入框，本版改成：<b>按一下 S → 找到官方搜索框 → click + focus 唤出原生下拉</b>，面板内容、历史词、热搜全是 B 站自己的；<b>再按一次 S → blur + 合成一次外部点击 → 收起下拉，并恢复按下前的焦点与输入内容</b>（复原）。<br><br><b>任何页面</b>：按多组选择器找官方框（<code>.nav-search-input</code> / <code>#nav-searchform input.nav-search-input</code> / <code>.center-search__bar input</code> / <code>input.search-input-el</code> / <code>input[placeholder*="搜索"]</code>）→ 顶栏收起时点 B 站自己的展开入口 → SPA 异步挂载时最多重试 2 次。全屏时 B 站隐藏顶栏，诊断会如实提示「先按 F 退出全屏」，脚本不伪造浮层。<br><br><b>为什么再按一次能生效</b>：展开期间焦点在输入框里，通常会被「输入框自动让行」规则放行成打字；本版在 keydown 捕获阶段<b>优先</b>判断「当前按的是搜索键且原生搜索已展开」，直接关闭并 <code>stopImmediatePropagation</code>，S 不会被输进去。Esc 与切回页面也会复原状态。<br><br><b>回车不变</b>：仍走 v1.3 零导航结果浮层（拦截官方 submit / 建议链接 / <code>window.open</code>），<b>不回到 search 域</b>，避免之前修好的「多重重定向崩溃」复发。新增 <b>📋 搜索诊断</b>（<code>selector / panelVisible / panelAfter / isOpen</code>）与「S 使用原生搜索框」开关（关掉回旧浮层）。</p></div>' +
      '<div class="bpe-card"><h3>v1.8.1 · 播放页强制唤出原生顶栏 + 工具条二级菜单不再闪退</h3><p><b>Bug 1（不是全屏也调不出原生搜索）</b>：B 站播放页在 iPad Safari 上把顶栏收起，甚至根本不挂载 <code>input.nav-search-input</code>；v1.8 只重试 2 次就误报「全屏时顶栏隐藏 · 按 F 退出」。现在三级递进：<b>① 戳 B 站自己</b> —— <code>scrollTo(0,0)</code> + 派发 <code>scroll / mouseenter / mousemove / pointerenter</code>，让 mini header 自己出现；<b>② 放宽候选</b> —— 除原有类名外，再扫 header 容器与 <code>form</code> 里的任意 <code>input</code>（排除弹幕 / 评论 / 登录 / 验证码 / 脚本浮层；<b>不扫全局无关输入框</b>，避免误命中）；<b>③ 强制亮出</b> —— 若 DOM 在但被 <code>display:none / visibility:hidden / opacity:0 / translateY</code> 藏住，沿祖先链逐层写 inline <code>!important</code> 显示并<b>保存 cssText 快照</b>，把搜索表单 <code>position:fixed</code> 成顶部浮动条（观感等同 B 站 mini header）。<b>搜索框、搜索历史、bilibili热搜下拉仍是 B 站原生 Vue 组件</b>，脚本只改可见性、不重绘内容；再按 S / Esc / 回车 / 切回页面时按快照<b>完整还原</b>。重试 3 次，失败文案改成「B 站还没渲染顶栏搜索框 · 可点重试唤出」，不再让你退出全屏。<br><br><b>Bug 2（二级菜单闪一下就消失）</b>：① <code>openNativeSearch()</code> 里的 <code>closeSearch()</code> 会把 <code>host.style.zIndex</code> 清成 <code>&apos;&apos;</code>，而 <code>.bpe-stage</code> 的 <code>2147483600</code> 只在 host 的层叠上下文内生效 —— host 一降级，工具条整体被 B 站播放器层盖住；现在 <b>host 自身常驻 <code>position:fixed + z-index:2147483647</code></b>，<code>closeSearch()</code> 改为把它设回最高层而不是清空。② iPad Safari 触摸可能伴随重复 click，原来的隐式 <code>!d.hidden</code> 会把刚展开的二级菜单立刻取反关掉；现在 dock 用显式 <code>CORE.dockOpen</code> + <b>320ms 同手势去重</b>，FAB 点击 <code>stopPropagation</code>，点二级按钮后保持展开。<br><br>新增 <b>🔄 重试唤出</b>（设置页 / Stay 菜单）与搜索诊断字段 <code>forcedRevealed / forcedCount / forcedRestored / dockOpen</code>。<b>其余全部未动</b>：零导航结果、三连、D 开关、自动播放收手、音量记忆、v1.7 占位文字与长按倍速。</p></div>' +
        '' },
      { t: 'v1.7 ~ v1.6 · 倍速 / 起播 / 音量', open: false, h:
      '<div class="bpe-card"><h3>v1.7 · 屏蔽占位文字 / 长按倍速两件事</h3><p>① <b>空白容器填上「与学习无关」</b>：旧版 <code>display:none</code> 把整张卡片抽掉，网格里留下没有解释的空白。现在改为<b>保留卡片几何</b>（只软隐藏子元素、不改 display），在原位置叠一层虚线占位卡：🎯 + <b>与学习无关</b> + 屏蔽原因（分区 / UP 主）。关掉开关就回到彻底隐藏。<br>② <b>长按相反档键取消倍速</b>：短按 <code>[</code> / <code>]</code> 仍升/降一档；<b>长按与当前档位方向相反的键</b>（&gt;1× 长按 <code>[</code>，&lt;1× 长按 <code>]</code>）直接回 <b>1× 原速</b>，并清掉记忆档位。同向长按仍可连续升降。<br>③ <b>官方「长按右方向键 3×」丝滑接入</b>：脚本只观察、不 <code>preventDefault</code>、不 <code>stopPropagation</code>，B 站完整收到 keydown/keyup；长按期间脚本<b>绝不写 playbackRate</b>，所以无论你之前是 1.5× 还是 3×，官方 3× 都不被打断。<b>松开后强制回 1×，而不是恢复之前的档位</b>：分三次校正（立即 / 60ms / 180ms）覆盖官方自己的恢复动作，并把 <code>CFG.rate</code> 清成 1，换视频也不会写回旧档。短按右方向键（快进 5 秒）不触发归原速。</p>' +
        '<div class="bpe-actions">' + btn('cmd:rateNormal', '↩︎ 倍速回 1×', 'primary') + btn('cmd:rateDiag', '📋 倍速诊断') + btn('cmd:learn', '🎯 测试学习模式') + '</div>' +
        (CORE.rateDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ reason: CORE.rateDiag.reason, before: CORE.rateDiag.before, after: CORE.rateDiag.after, rememberedRate: CORE.rateDiag.rememberedRate })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.6.3 · 音量记忆 / 解除静音零延迟 / 整体逻辑复核</h3><p>① <b>音量记忆</b>：只要调整音量就记住（含 0%），跨视频复用；用特性探测判断 <code>volume</code> 是否可写，脚本写回的值由 <code>applyingVolume</code> 屏蔽，不再把「自己写回的 0.8」当成用户调整。<br>② <b>解除静音不再迟钝</b>：删掉 <code>play().then() + 60ms setTimeout</code> 那条链路，改为「优先带声音起播 → 被拒回退静音 → 首次手势回调里同步 unmute」。Apple 官方：无手势取消静音会暂停播放。<br>③ <b>系统音量边界如实说明</b>：iPad Safari 的 volume 只读且恒为 1，网页无 API 读写系统音量，做不到「调一个另一个跟着动」；脚本只控制 <code>muted</code>，不制造假同步。<br>④ <b>复核去冗余</b>：<code>restoreVolume</code> 4 处调用收敛为 <code>unmuteNow</code> 单一入口、合并语义重复的 <code>autoPlayDone</code>、删除死字段 <code>volumeTouched</code>、删掉 900ms 定时器里与 <code>scan()</code> 重复的起播调用、合并两处重复的 M 静音按钮、手势判定统一走 User Activation API。</p>' +
        '<div class="bpe-actions">' + btn('cmd:volumeDiag', '📋 音量诊断', 'primary') + btn('cmd:unmuteNow', '🔊 立即解除静音') + btn('cmd:autoPlayDiag', '📋 起播诊断') + '</div>' +
        (CORE.volDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ savedValue: CORE.volDiag.savedValue, source: CORE.volDiag.source, settable: CORE.volDiag.settable, reason: CORE.volDiag.reason })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.6.2 · 自动起播「一次就好」，绝不抢你的暂停</h3><p>你反馈的「暂停不住 / 抽动两下才能暂停」来自三处叠加的旧补播逻辑：① <b>解除静音后 600ms 若检测到暂停就回退静音并重播</b>（点视频画面暂停时匹配不到播放控件，就把你的暂停当成 Safari 打断）；② <b>手势监听里借 pointerdown 补一次 play()</b>（你点画面暂停，pointerdown 先到，画面又被拉起来）；③ <b>900ms 定时器与 20 秒重试链只认「已成功起播」标记</b>，不认「用户主动暂停」。<br><br>现在按一条硬规则重写：<b>自动起播只负责「刚点开视频把静止画面跑起来」这一次</b>。只要 <code>playing</code> 触发过（无论谁播放的），或收到 <code>pause</code>，就按视频 key 记下「已播放 / 用户已暂停」并<b>立刻停掉重试定时器</b>；此后 <code>apAllowed()</code> 对所有 <code>play()</code> 调用返回 false。<b>删掉了所有回退重播、手势补播</b>，恢复音量只做 <code>muted=false</code>，不再碰播放状态。<br><br>所以：刚进页面静音画面自动跑起来 → 你随手点/滑一下恢复音量 → 之后按空格、点画面、点暂停键，都<b>一次停住、不再抽动</b>。换一个新视频会重新获得一次起播机会（标记按 BV+src 隔离，互不干扰）；想强制重跑可点「🎬 立即尝试起播」，跑完仍会立刻收手。</p>' +
        '<div class="bpe-actions">' + btn('cmd:autoPlayNow', '🎬 立即尝试起播（跑完即收手）', 'primary') + btn('cmd:autoPlayDiag', '📋 起播诊断（看 settled）') + '</div>' +
        (CORE.apDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ msg: CORE.apDiag.msg, settled: !!(CORE.apPlayed[Object.keys(CORE.apPlayed).pop()] || CORE.apPaused[Object.keys(CORE.apPaused).pop()]) })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.6.1 · R 键不再「报成功却没刷新」</h3><p>旧版拿 <code>[class*="refresh-btn"]</code> 找按钮，在视频页可能命中别的控件，点一下就无条件提示「推荐已刷新」。<br><br>现在：① <b>只在 B 站首页生效</b>（视频页会明确告诉你，不假成功）；② 按 2026-09 修复过的 <code>bilibili_shortcut</code> 结构找真正的 <code>button.roll-btn</code>，外层 <code>div.feed-roll-btn</code> 会向内找真实按钮，并过滤隐藏 / 禁用元素；③ <b>点击前后对比首屏 12 张推荐卡片的 BV 号与标题</b>，真的变了才说「✅ 推荐已刷新」；④ 没变依次试 原生 click → 完整 pointer/mouse 事件序列 → 内部图标，仍不变就如实说「已点击但列表没变化」。<br><br>新增 <b>📋 刷新诊断</b>：记录当前域名 / 命中按钮 outerHTML / 点击步骤 / 前后卡片快照，不含 Cookie。</p>' +
        '<div class="bpe-actions">' + btn('cmd:refresh', 'R 刷新推荐（验证）', 'primary') + btn('cmd:refreshDiag', '📋 刷新诊断') + '</div>' +
        (CORE.refreshDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ result: CORE.refreshDiag.result, home: CORE.refreshDiag.home, candidates: CORE.refreshDiag.candidates, button: CORE.refreshDiag.button, steps: CORE.refreshDiag.steps })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.6.3 · 音量记忆 / 解除静音零延迟 / 整体逻辑复核</h3><p>① <b>音量记忆</b>：只要调整音量就记住（含 0%），跨视频复用；用特性探测判断 <code>volume</code> 是否可写，脚本写回的值由 <code>applyingVolume</code> 屏蔽，不再把「自己写回的 0.8」当成用户调整。<br>② <b>解除静音不再迟钝</b>：删掉 <code>play().then() + 60ms setTimeout</code> 那条链路，改为「优先带声音起播 → 被拒回退静音 → 首次手势回调里同步 unmute」。Apple 官方：无手势取消静音会暂停播放。<br>③ <b>系统音量边界如实说明</b>：iPad Safari 的 volume 只读且恒为 1，网页无 API 读写系统音量，做不到「调一个另一个跟着动」；脚本只控制 <code>muted</code>，不制造假同步。<br>④ <b>复核去冗余</b>：<code>restoreVolume</code> 4 处调用收敛为 <code>unmuteNow</code> 单一入口、合并语义重复的 <code>autoPlayDone</code>、删除死字段 <code>volumeTouched</code>、删掉 900ms 定时器里与 <code>scan()</code> 重复的起播调用、合并两处重复的 M 静音按钮、手势判定统一走 User Activation API。</p>' +
        '<div class="bpe-actions">' + btn('cmd:volumeDiag', '📋 音量诊断', 'primary') + btn('cmd:unmuteNow', '🔊 立即解除静音') + btn('cmd:autoPlayDiag', '📋 起播诊断') + '</div>' +
        (CORE.volDiag ? '<span class="bpe-code">' + esc(JSON.stringify({ savedValue: CORE.volDiag.savedValue, source: CORE.volDiag.source, settable: CORE.volDiag.settable, reason: CORE.volDiag.reason })) + '</span>' : '') + '</div>' +
      '<div class="bpe-card"><h3>v1.6.3 · 自动起播 / 音量记忆 / 系统音量边界</h3><p><b>发弹幕</b>：整套自定义发送能力已删除，交回 B 站官方输入框；保留 <b>D 弹幕显示开关</b>。<br><br><b>零延迟自动起播</b>：优先以「带声音 + 记忆音量」调用 <code>play()</code>（用户点开视频即手势），成功则画面与声音同时开始；被 <code>NotAllowedError</code> 拒绝立刻回退静音起播，并在<b>第一次真实手势回调里同步</b>执行 <code>muted=false</code>。<b>删掉了 <code>play().then() + setTimeout</code> 的旧 unmute</b> —— Apple《为 Safari 传送视频内容》：在没有用户手势的情况下取消静音，播放就会暂停，这正是旧版「开播 1~2 秒才有声音」的根因。<b>v1.6.2 收手逻辑不变</b>：<code>playing</code> / <code>pause</code> 一触发就停掉重试链，之后暂停一次就停住。<br><br><b>音量记忆</b>：只要调整音量就记（含 0%），跨视频复用；<code>volumechange</code> 在 volume 或 muted 任一变化时都会触发（MDN），所以脚本自身写入用 <code>applyingVolume</code> 屏蔽、B 站初始化与第三方脚本用用户手势窗口过滤。另外从 B 站音量控件的 <code>value / aria-valuenow</code> 补一路「用户意图音量」，覆盖 iPad 上 volume 只读、硬件音量键不触发 volumechange 的情况。<br><br><b>⚠️ 系统音量边界（多源查证）</b>：Apple 官方说明 iOS/iPadOS 上 <code>&lt;video&gt;.volume</code> 只读且恒为 1，音量始终由用户物理键控制；硬件音量键不触发 <code>volumechange</code>；<code>navigator.audioSession</code> 仅 <code>type/state</code>、无音量属性；<code>AVAudioSession.outputVolume</code> 是原生 API，网页无权访问。<b>所以网页脚本无法读取/设置系统音量，做不到「调一个另一个跟着动」</b>。脚本在 iPad 上只控制 <code>muted</code>，既不写 volume 也不用 Web Audio GainNode 绕过。<br><br><b>整体复核</b>：单 keydown 监听、单 MutationObserver、单实例守卫保持；删掉 <code>restoreVolume</code> 的 4 处重复调用、合并 <code>autoPlayDone</code>、删除死字段 <code>volumeTouched</code>、去掉 900ms 定时器里重复的起播调用、合并两处 M 静音按钮、手势判定统一走 <code>navigator.userActivation</code>。</p></div>' +
      '<div class="bpe-card"><h3>v1.7 · 屏蔽占位 + 两组长按倍速</h3><p><b>空白容器</b>：学习模式命中后不再 <code>display:none</code> 抽掉整卡（那样网格里只剩一块没解释的白），改为保留卡片几何、软隐藏子元素、叠一层虚线占位卡写 <b>「与学习无关」</b>，并附屏蔽原因。关掉「空白容器显示」开关即回到彻底隐藏。<br><br><b>长按相反档键</b>：短按 <code>[</code> / <code>]</code> 立即升/降一档；长按「与当前档位方向相反」的键（&gt;1× 按 <code>[</code>，&lt;1× 按 <code>]</code>）触发一次 <b>回到 1× 原速</b>，同时把 <code>CFG.rate</code> 清成 1，换视频也不会写回旧档。长按判定用 <code>keydown.repeat</code> + 时间阈值双保险（iPad 外接键盘可能不发 repeat），keyup 清理状态、切标签有兜底。<br><br><b>官方长按右方向键 3×</b>：B 站/社区脚本的通行实现是「长按临时 3×，松开恢复到<b>进入前</b>的倍速」。本版让脚本<b>只观察不拦截</b>右方向键（不 preventDefault / 不 stopPropagation），长按期间 <code>restoreRate()</code> 直接跳过、绝不写 <code>playbackRate</code>，所以无论之前是 1.5× 还是 3×，官方 3× 都能完整生效。<b>松开后强制回 1×，而不是「之前的档位」</b>：立即 / 60ms / 180ms 三次校正覆盖官方自己的恢复动作，并把记忆档位清成 1。短按右方向键（快进 5 秒）判定为短按，不归原速。<br><br>新增 <b>↩︎ 回 1×</b> 命令与 <b>📋 倍速诊断</b>（<code>official3xSeen / rememberedRate / rateHold</code>）。</p></div>' +
        '' },
      { t: '更早版本 · 已修好并保留', open: false, h:
      '<div class="bpe-card"><h3>v1.5 / v1.4 已修好的（保留）</h3><p>弹幕显示开关验状态；POST 页面 fetch 双通道修「账号未登录」；三连没硬币自动补点赞 + 收藏（已确认可用，本版未改动）。<b>与发弹幕相关的能力已按你的要求整体移除。</b></p></div>' +
      '<div class="bpe-card"><h3>v1.3 已修好的（保留）</h3><p>零导航搜索（拦 B 站原生提交 / 链接 / window.open）、回页面无条件夺回焦点、专注条自动避让搜索框。</p></div>' +
      '<div class="bpe-card"><h3>v1.2 全屏重写（保留）</h3><p>F 转发 B 站自己的全屏按钮，弹幕 / 控制栏 / 快捷键全程保留；只在全屏态给 &lt;video&gt; 加 inline 样式，退出即还原，不会黑屏。</p>' +
        '<div class="bpe-actions">' + btn('cmd:fillReset', '🧹 复位全屏', 'primary') + btn('cmd:fullscreen', '⛶ 测试全屏') + '</div></div>' +
      '<div class="bpe-card"><h3>此前版本已修好的（保留）</h3><p>弹幕显示开关验状态；POST 页面 fetch 双通道修「账号未登录」；三连没硬币自动补点赞 + 收藏（已确认可用，本版未改动）；零导航搜索；全屏转发 B 站按钮不黑屏。</p></div>' +
        '' },
    ];
  }
  function tabLog() {
    return '<h2 class="bpe-h1">更新日志</h2>' +
      '<p class="bpe-lead">按版本倒序，点标题展开 / 收起。<b>这里只记录改动</b>；要调设置请去「⚙ 功能开关」，要排障请去「? 教程 / 诊断」。</p>' +
      tabChips('log') +
      '<div class="bpe-note pink">🕘 概览页不再堆版本卡片，功能开关也不再藏在这下面。每个版本里的「试一下 / 诊断」按钮仍然可用。</div>' +
      '<div class="bpe-log">' +
      logSections().map(sec =>
        '<details class="bpe-details"' + (sec.open ? ' open' : '') + '><summary>' + esc(sec.t) + '</summary>' + sec.h + '</details>'
      ).join('') +
      '</div>';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function detectConflicts() {
    const checks = [
      ['Bilibili-Evolved', () => !!document.querySelector('#bilibili-evolved, [id*="bilibili-evolved"], [class*="bili-evolved"]') || !!pageWindow().__BILIBILI_EVOLVED__],
      ['BewlyBewly', () => !!document.querySelector('[class*="bewly"], #bewly')],
      ['Bilibili-Gate / 首页改版', () => !!document.querySelector('.bilibili-gate-video-card, [class*="bilibili-gate"]')],
      ['BilibiliSponsorBlock', () => !!document.querySelector('[class*="sponsorblock"], #bsb')]
    ];
    const out = [];
    checks.forEach(c => { try { if (c[1]()) out.push(c[0]); } catch (e) {} });
    return out;
  }

  /* v2.0.1：记住上次渲染的页签。旧版 render() 无条件 content.scrollTop = 0，
     而开关 change / 录完键 / 分区 / UP 名单 / 恢复默认 都会调 render() 重绘
     .bpe-content 的 innerHTML —— 于是每改一个开关、每录一个键就跳回设置页最顶端。
     现在只在「页签没变」时把重绘前的 scrollTop / scrollLeft 还回去；
     切页（switchTab 先改 activeTab）或重新打开设置（closePanel 清空标记）
     仍然从顶部开始，和以前完全一致。 */
  let lastRenderedTab = null;
  function render() {
    if (!sr) return;
    const nav = $('.bpe-nav', sr), content = $('.bpe-content', sr);
    const sameTab = lastRenderedTab === activeTab;
    const keepTop = sameTab ? (content.scrollTop || 0) : 0;
    const keepLeft = sameTab ? (content.scrollLeft || 0) : 0;
    nav.innerHTML = TABS.map(t => '<button data-act="tab:' + t.id + '" class="' + (activeTab === t.id ? 'active' : '') + '">' + t.icon + ' ' + t.label + '</button>').join('');
    const map = { home: tabHome, switches: tabSwitches, selfcheck: tabSelfcheck,
      log: tabLog, donate: tabDonate };
    content.innerHTML = (map[activeTab] || tabHome)();
    if (sameTab && (keepTop || keepLeft)) {
      // 同步还原 + 下一帧兜底（iPad Safari 偶尔在 innerHTML 后忽略同步赋值）
      const put = () => {
        if (!sr || $('.bpe-content', sr) !== content || lastRenderedTab !== activeTab) return;
        content.scrollTop = keepTop; content.scrollLeft = keepLeft;
      };
      put();
      try { (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); })(put); } catch (_) {}
    } else {
      content.scrollTop = 0;
    }
    lastRenderedTab = activeTab;
    const dockMini = $$('.bpe-dock .bpe-mini', sr).find(b => b.dataset.act === 'cmd:learn');
    if (dockMini) dockMini.classList.toggle('on', !!CFG.learnMode);
  }
  /* v1.9.1 打开设置的唯一入口：先把所有「会盖在设置页上」的浮层收干净。
     ① 二级 dock（截图里右侧一列 ⚡倍速/⛚全屏/… 压住正文的元凶）
     ② 浮层搜索 / B 站原生搜索下拉 / 倍速小浮层 / 截图预览 / 确认卡
     ③ 再显示遮罩与面板。mask 与 panel 的 z-index 已在 CSS 里显式高于 dock，
        即使 dock 因异常仍展开，也不可能再盖到设置页上。 */
  function openPanel() {
    if (!sr) return;
    setDock(false);
    if (CORE.floatSearch.open) { try { closeFloatSearch(); } catch (e) {} }
    if (CORE.nativeSearch.open) { try { closeNativeSearch('打开设置前先复原', { silent: true }); } catch (e) {} }
    ['.bpe-ratepop', '.bpe-preview', '.bpe-confirm'].forEach(sel => {
      const el = $(sel, sr); if (el) el.hidden = true;
    });
    $('.bpe-mask', sr).hidden = false;
    $('.bpe-panel', sr).hidden = false;
    render();
  }
  function closePanel() {
    if (!sr) return;
    $('.bpe-mask', sr).hidden = true;
    $('.bpe-panel', sr).hidden = true;
    // v2.0.1：重新打开设置时按老习惯从顶部开始，不继承上次的滚动位置
    lastRenderedTab = null;
    // 刻意不重新展开 dock：关闭设置后保持干净，二级菜单不会「又浮上来」
  }
  function switchTab(id) {
    id = TAB_ALIAS[id] || id;                   // v1.9.2：旧页签 / 历史卡片按钮兼容
    if (!TABS.some(t => t.id === id)) return;   // 防拼错 / 旧值造成空白页
    activeTab = id;
    try { Store.set('activeTab', id); } catch (e) {}
    if ($('.bpe-panel', sr) && $('.bpe-panel', sr).hidden) openPanel();
    else render();                              // 已打开时只重绘内容，不重复收浮层
  }

  function bindUI() {
    sr.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t) return;
      const act = t.dataset.act;
      // v1.8.1：第一级 FAB 的点击不再冒泡到 B 站 / document 上的监听，
      // 避免同一次 tap 被页面层的「外部点击收起浮层」逻辑二次处理。
      if (act === 'cmd:dock' || (act.startsWith('cmd:') && t.classList.contains('bpe-fab'))) {
        e.stopPropagation(); e.preventDefault();
        return Bus.exec('dock');
      }
      // 点二级菜单里的命令后保持展开（不收起 dock），方便连点
      if (act.startsWith('cmd:')) { e.stopPropagation(); return Bus.exec(act.slice(4)); }
      /* v1.9 浮层搜索：分类 / 联想 / 结果 / 历史 / 热搜，全部按索引或枚举取，
         不接受任意 URL 字符串，避免把外链拼进 data-act。 */
      if (act.startsWith('fstab:')) { e.stopPropagation(); return fsTab(act.slice(6)); }
      if (act.startsWith('fssug:')) { e.stopPropagation(); return fsPickSuggest(Number(act.slice(6))); }
      if (act.startsWith('fsopen:')) {
        e.stopPropagation();
        const seg = act.slice(7).split(':');
        return fsOpen(seg[0], seg.slice(1).join(':'));
      }
      if (act.startsWith('fshist:')) {
        e.stopPropagation();
        const w = fsHistory()[Number(act.slice(7))];
        if (w) doFloatSearch(w);
        return;
      }
      if (act.startsWith('fshot:')) {
        e.stopPropagation();
        const w = CORE.floatSearch.hot[Number(act.slice(6))];
        if (w) doFloatSearch(w);
        return;
      }
      if (act.startsWith('tab:')) return switchTab(act.slice(4));
      if (act.startsWith('rate:')) { const p = $('.bpe-ratepop', sr); if (p) p.hidden = true; return Bus.exec('rate', Number(act.slice(5))); }
      if (act.startsWith('zone:')) {
        const tid = Number(act.slice(5));
        const i = CFG.blockedTids.indexOf(tid);
        if (i >= 0) CFG.blockedTids.splice(i, 1); else CFG.blockedTids.push(tid);
        save(); applyCfg(); render(); return;
      }
      if (act.startsWith('updel:')) { CFG.blockedUps.splice(Number(act.slice(6)), 1); save(); applyCfg(); render(); return; }
      if (act === 'logincheck') return Bus.exec('loginCheck');
      if (act.startsWith('dl:')) return downloadAt(Number(act.slice(3)));
      if (act.startsWith('copy:')) return copyText((CORE.media[Number(act.slice(5))] || {}).url || '');
      switch (act) {
        case 'close': closePanel(); break;
        case 'panel': openPanel(); break;
        case 'ratepop': showRatePop(t); break;
        case 'peek': peekHidden(); break;
        case 'rec': recording = t.dataset.key; toast('请按下想绑定的按键…'); break;
        case 'searchgo': doFloatSearch(); break;
        case 'searchclose': closeFloatSearch(); break;
        case 'fsclear': {
          const i = $('.bpe-search-input', sr);
          if (i) { i.value = ''; fsSyncClear(); fsScheduleSuggest(''); try { i.focus(); } catch (_) {} }
          break;
        }
        case 'fshclear': fsClearHistory(); break;
        case 'barmin': CFG.barMinimized = true; save(); updateBar(); break;
        case 'barmax': CFG.barMinimized = false; save(); updateBar(); break;
        case 'barreset': CORE.barPos = null; Store.del('barPos'); CFG.barMinimized = false; save(); updateBar(); toast('专注条已回到左下角'); break;
        case 'savecap': saveCapture(); break;
        case 'closepreview': $('.bpe-preview', sr).hidden = true; break;
        case 'confirmyes': CORE.confirmResolve(true); break;
        case 'confirmno': CORE.confirmResolve(false); break;
        case 'mediarefresh': refreshMedia(); break;
        case 'copycmd': copyText('ffmpeg -i video.m4s -i audio.m4s -c copy output.mp4'); break;
        case 'upadd': {
          const mid = ($('#bpe-upmid', sr) || {}).value ? $('#bpe-upmid', sr).value.trim() : '';
          const name = ($('#bpe-upname', sr) || {}).value ? $('#bpe-upname', sr).value.trim() : '';
          if (!mid && !name) return toast('请至少填 mid 或昵称');
          CFG.blockedUps.push({ mid: mid, name: name || ('mid ' + mid) });
          save(); applyCfg(); render(); toast('已加入名单'); break;
        }
        case 'diag': {
          const diag = { version: CORE.version, ua: navigator.userAgent, href: location.href.split('?')[0],
            caps: CAP, conflicts: detectConflicts(), video: curVideo ? (curVideo.videoWidth + 'x' + curVideo.videoHeight) : null,
            hidden: CORE.hiddenCount, zoneCache: Object.keys(zoneCache).length, cfg: CFG, logs: CORE.logs.slice(-30) };
          copyText(JSON.stringify(diag, null, 2)); break;
        }
        case 'reset': CFG = JSON.parse(JSON.stringify(DEFAULTS)); zoneCache = {}; CORE.barPos = null;
          Store.del('zoneCache'); Store.del('barPos'); save(); applyCfg(); updateBar(); render();
          toast('已恢复默认设置并清空分区缓存'); break;
        case 'closestyle': {
          const s = document.getElementById('bpe-page-css');
          if (s) { s.disabled = !s.disabled; toast(s.disabled ? '已临时移除注入样式' : '已恢复注入样式'); }
          break;
        }
      }
    });
    /* v1.9：输入过程中实时联想（防抖在 fsScheduleSuggest 内）。
       Shadow DOM 里 input 事件不冒泡到 document，所以挂在 sr 上并开捕获。 */
    sr.addEventListener('input', e => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('bpe-search-input')) {
        fsSyncClear();
        fsScheduleSuggest(t.value || '');
      }
    }, true);
    sr.addEventListener('change', e => {
      const t = e.target;
      if (!t.dataset) return;
      if (t.dataset.cfg) {
        const k = t.dataset.cfg;
        CFG[k] = t.type === 'checkbox' ? t.checked : (t.type === 'number' ? Number(t.value) : t.value);
        if (k === 'preferredVolume') CFG[k] = Math.min(1, Math.max(0, CFG[k] || 0));
        if (k === 'holdThresholdMs') CFG[k] = Math.min(1200, Math.max(120, Number(CFG[k]) || 340));
        save(); applyCfg(); render();
      }
      if (t.dataset.key) {
        CFG.shortcuts[t.dataset.key] = t.value.trim() || DEFAULTS.shortcuts[t.dataset.key];
        save(); rebuildKeyMap(); render();
      }
    });
    $('.bpe-mask', sr).addEventListener('click', closePanel);
  }
  function showRatePop(anchor) {
    const p = $('.bpe-ratepop', sr);
    if (!p.hidden) { p.hidden = true; return; }
    p.className = 'bpe-ratepop bpe-searchbox';
    p.style.cssText = 'position:fixed;right:20px;bottom:calc(140px + env(safe-area-inset-bottom));width:min(320px,86vw);padding:16px;border-radius:18px;background:var(--bg);border:1px solid var(--line);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:var(--shadow);pointer-events:auto;z-index:7;';
    p.innerHTML = '<h3 style="margin:0 0 10px;font-size:14px">⚡ 选择倍速</h3><div class="bpe-chips">' +
      CFG.rateList.map(r => '<button class="bpe-chip ' + (Math.abs((CFG.rate || 1) - r) < 0.001 ? 'cur' : '') + '" data-act="rate:' + r + '">' + r + '×</button>').join('') + '</div>';
    p.hidden = false;
  }

  /* ============================================================
   * 15. 键盘：唯一一处捕获监听 + 改键录制
   * ============================================================ */
  let keyMap = {};
  function rebuildKeyMap() {
    keyMap = {};
    Object.keys(CFG.shortcuts).forEach(id => {
      const k = CFG.shortcuts[id];
      if (k) keyMap[k] = id;
    });
  }
  function keyName(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return '';
    const k = e.key;
    if (!k || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Dead', 'Unidentified'].indexOf(k) >= 0) return '';
    if (k === ' ') return e.shiftKey ? 'Shift+Space' : 'Space';
    if (k.length === 1) return e.shiftKey ? 'Shift+' + k.toUpperCase() : k.toLowerCase();
    return e.shiftKey ? 'Shift+' + k : k;   // 支持 Shift+Enter / Shift+F
  }
  function isEditable(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true ||
      (el.getAttribute && el.getAttribute('contenteditable') === 'true');
  }
  /* 从别的标签 / 网页回来：Safari 会把焦点还给 B 站搜索框，导致按键全变打字。
     v1.3 改成无条件夺回 —— 不再猜「是不是刚点的」，回来就立刻可用。 */
  document.addEventListener('pointerdown', () => { CORE.lastRealTap = Date.now(); }, true);
  // v1.6：官方弹幕输入框完全交还 B 站，不 blur、不拦 Enter / Esc / 任何键
  function isOfficialDmInput(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'div') return false;
    const sig = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' +
      ((el.getAttribute && ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('data-dm') || ''))) || '');
    return /danmaku|dm-input|bpx-player-dm|弹幕/i.test(sig);
  }
  function restoreShortcuts(reason) {
    let blurred = false;
    try { const a = document.activeElement; if (a && isEditable(a) && !isOfficialDmInput(a)) { a.blur(); blurred = true; } } catch (e) {}
    try { const sa = sr && sr.activeElement; if (sa && isEditable(sa)) { sa.blur(); blurred = true; } } catch (e) {}
    // v1.8：从别的标签 / 网页回来时，原生下拉也应复原（不把焦点抢回输入框）
    if (CORE.nativeSearch.open || CORE.nativeSearch.revealed) {
      nsRestoreForced();               // v1.8.1：临时亮出的顶栏必须一并还原
      CORE.nativeSearch.open = false;
      CORE.nativeSearch.input = null;
      CORE.nativeSearch.prevFocus = null;
      CORE.nativeSearchDiag = Object.assign({}, CORE.nativeSearchDiag || {}, {
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        result: '切回页面已复原', reason: reason, page: location.pathname
      });
    }
    if (CORE.floatSearch.open) closeFloatSearch();
    closeSearch();
    setKbdState(false);
    if (blurred) {
      LOG('Focus', '已从输入框夺回焦点（' + reason + '）');
      setTimeout(() => toast('⌨ 快捷键已恢复'), 140);
    }
    setTimeout(updateKbdState, 160);
  }
  document.addEventListener('focusin', e => {
    if (isEditable(e.target)) { CORE.lastInputFocusAt = Date.now(); updateKbdState(); }
  }, true);
  document.addEventListener('focusout', () => setTimeout(updateKbdState, 80), true);
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    const real = (e.composedPath && e.composedPath()[0]) || e.target;
    // v1.6：官方弹幕输入框的所有按键（含 Enter 发送 / Esc）一律交还 B 站，不拦不抢
    if (!recording && isOfficialDmInput(real)) return;
    /* v1.8：原生搜索展开期间，焦点在 B 站输入框里，「再按一下」也必须生效。
       必须在 isEditable(real) 让行之前处理，否则 S 会被当成打字输入进搜索框。 */
    if (!recording && CORE.nativeSearch.open) {
      const kk = keyName(e);
      if (kk && keyMap[kk] === 'searchZoom') {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        if (CFG.nativeSearchToggle) closeNativeSearch('再按一次搜索键');
        else { closeSearch(); CORE.nativeSearch.open = false; setKbdState(false); }
        return;
      }
    }
    /* v1.9：浮层展开期间焦点在输入框里，开关键必须能被接住，
       否则会被 isEditable 让行规则当成往浮层里打字（按 S 会多个 s）。
       两个键都收：Shift+S 是独立浮层键；S 在关掉「原生优先」时就是浮层键，
       即使开着原生优先，浮层已开时按 S 也按 toggle 语义关掉，避免两层叠着。 */
    if (!recording && CORE.floatSearch.open) {
      const fk = keyName(e);
      const cmd = fk && keyMap[fk];
      if (cmd === 'floatSearch' || cmd === 'searchZoom') {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        closeFloatSearch();
        return;
      }
    }
    // Esc 任何位置夺回快捷键：blur 两层输入框 + 收掉所有浮层
    if (e.key === 'Escape' && !recording) {
      // v1.8：Esc 也能收起原生下拉；不重复恢复焦点，交给下面的「夺回焦点」逻辑
      if (CORE.nativeSearch.open) closeNativeSearch('Esc', { silent: true, noRestoreFocus: true });
      try { const a = document.activeElement; if (a && isEditable(a) && !isOfficialDmInput(a)) a.blur(); } catch (_) {}
      try { const sa = sr && sr.activeElement; if (sa && isEditable(sa)) sa.blur(); } catch (_) {}
      closeFloatSearch();
      ['.bpe-preview', '.bpe-confirm', '.bpe-ratepop'].forEach(s => { const el = $(s, sr); if (el) el.hidden = true; });
      closePanel();                       // v1.9.1：Esc 也是关闭设置的第三条路径（× / 点遮罩 / Esc）
      setKbdState(false);
      return;
    }
    /* v1.9.1：设置面板展开时，除 Esc 外的全局快捷键一律让行。
       否则在「功能开关」页调设置、按到 s / g / b 会误触发搜索 / 学习模式 / 三连，
       看起来就像「改完逻辑开关错位」。面板内的输入与 change 不受影响（走 sr 监听）。 */
    if (!recording && sr && $('.bpe-panel', sr) && !$('.bpe-panel', sr).hidden) return;
    if (recording) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { recording = null; toast('已取消录键'); return; }
      const k = keyName(e);
      if (k) { CFG.shortcuts[recording] = k; recording = null; save(); rebuildKeyMap(); render(); toast('已绑定 ' + k); }
      return;
    }
    const inPanel = real && real.closest && (real.closest('.bpe-panel') || real.closest('.bpe-ratepop'));
    if (inPanel && isEditable(real)) return;
    if (real && real.closest && real.closest('.bpe-search')) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFloatSearch(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); fsMoveSuggest(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); fsMoveSuggest(-1); }
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        const f = CORE.floatSearch;
        if (f.suggest.length && f.sugIndex >= 0) fsPickSuggest(f.sugIndex);
        else doFloatSearch();
      }
      return;
    }
    if (real && real.closest && (real.closest('.bpe-preview') || real.closest('.bpe-confirm'))) {
      if (e.key === 'Escape') { $('.bpe-preview', sr).hidden = true; $('.bpe-confirm', sr).hidden = true; }
      return;
    }
    // ★ 直接点 B 站官方搜索框按 Enter 也拦下来：绝不让页面跳到 search / m 域
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && officialSearchInput(real)) {
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      const kw = (real.value || '').trim();
      try { real.blur(); } catch (_) {}
      hijackOfficialSearch(kw);
      LOG('Search', '已拦截官方搜索框回车');
      return;
    }
    if (isEditable(real)) { setKbdState(true); return; }
    const k = keyName(e);
    if (!k) return;
    /* v1.7 —— 官方「长按右方向键 → 3×，松开恢复」：脚本只观察，不拦不抢。
       绝不 preventDefault / stopPropagation，B 站完整收到 keydown + keyup。
       只有出现 repeat（或 keyup 时已超过阈值）才判定为「长按」；短按快进 5 秒不归原速。 */
    if (CFG.enabled && CFG.officialHoldToNormal && e.key === 'ArrowRight' && !keyMap['ArrowRight']) {
      if (!e.repeat) {
        const v0 = findVideo();
        CORE.rightHold = { since: Date.now(), long: false, baseRate: v0 ? v0.playbackRate : 1 };
      } else if (CORE.rightHold) {
        CORE.rightHold.long = true;
        if (!CORE.officialHold) {
          CORE.officialHold = { active: true, since: Date.now(), baseRate: CORE.rightHold.baseRate, official3xSeen: false };
          LOG('Rate', '检测到长按右方向键 → 交给 B 站官方 3×（脚本不抢写 playbackRate）');
        }
      }
    }
    const cmd = keyMap[k];
    if (!cmd) return;                 // 右方向键未绑命令 → 从这里自然放行给官方
    const always = ['fullscreen', 'fillReset', 'panel', 'dock'];
    if (!CFG.enabled && always.indexOf(cmd) < 0) return;
    /* v1.7 —— 升/降档键：短按仍升/降一档；长按「相反档键」直接取消倍速回 1×。
       相反档键：当前 >1× 时是降档 [，当前 <1× 时是升档 ]。
       同向长按保留连续升/降（不破坏原有手感），且取消只触发一次。 */
    if (CFG.longPressCancelRate && (cmd === 'rateUp' || cmd === 'rateDown')) {
      const dir = cmd === 'rateUp' ? 1 : -1;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) {
        const h = CORE.rateHold;
        if (!h || h.fired) return;
        if (h.opposite) { maybeCancelOnLongPress('repeat'); return; }
        Bus.exec(cmd);
        return;
      }
      const v = findVideo();
      const cur = v ? v.playbackRate : 1;
      const opposite = isOppositeStep(dir, cur);
      const h = CORE.rateHold = {
        dir: dir, opposite: opposite, base: cur, key: k, fired: false,
        timer: null, startAt: Date.now()
      };
      Bus.exec(cmd);                 // 首次按下立即一档，短按手感不变
      if (opposite) {
        h.timer = setTimeout(() => maybeCancelOnLongPress('timer'), Math.max(120, Number(CFG.holdThresholdMs) || 340));
      }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    Bus.exec(cmd);
  }, true);

  /* v1.7 唯一一处 keyup：只做状态清理 / 长按结算，绝不在这里发命令。
     Safari 外接键盘可能不发 repeat，所以 keyup 时按时间阈值补判一次。 */
  document.addEventListener('keyup', e => {
    const k = keyName(e);
    if (CORE.rateHold) {
      const h = CORE.rateHold;
      const same = k === h.key || e.key === '[' || e.key === ']';
      if (same) {
        if (h.timer) { clearTimeout(h.timer); h.timer = null; }
        if (!h.fired && h.opposite && (Date.now() - h.startAt) >= Math.max(120, Number(CFG.holdThresholdMs) || 340)) {
          maybeCancelOnLongPress('keyup');
        }
        CORE.rateHold = null;
      }
    }
    if (e.key === 'ArrowRight' && CORE.rightHold) {
      const h = CORE.rightHold;
      CORE.rightHold = null;
      const long = h.long || (Date.now() - h.since) >= Math.max(120, Number(CFG.holdThresholdMs) || 340);
      if (long && CFG.enabled && CFG.officialHoldToNormal) {
        if (!CORE.officialHold) {
          CORE.officialHold = { active: true, since: h.since, baseRate: h.baseRate, official3xSeen: false };
        }
        endOfficialHold();
      } else if (CORE.officialHold) {
        CORE.officialHold = null;    // 短按快进：不归原速，脚本恢复正常倍速管理
      }
    }
  }, true);
  // 切标签 / 窗口失焦时收不到 keyup：清掉长按状态，避免官方 3× 卡住或记忆残留
  window.addEventListener('blur', () => {
    if (CORE.rateHold) { if (CORE.rateHold.timer) clearTimeout(CORE.rateHold.timer); CORE.rateHold = null; }
    if (CORE.rightHold) {
      CORE.rightHold = null;
      if (CORE.officialHold) endOfficialHold();
    }
  });

  /* ============================================================
   * 16. 单一 MutationObserver + SPA 导航感知
   * ============================================================ */
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 180);
  }
  function scan() {
    findVideo();
    if (CFG.enabled && CFG.autoPlay) autoPlayVideo(findVideo());  // 晚插入的 video 也能自动起播
    fillWatchdog();   // B 站切全屏会改 DOM 类名，这里比 900ms 定时更及时
    if (CFG.enabled && (CFG.learnMode || CFG.showBlockButtons)) scanCards();
    updateBar();
  }
  const observer = new MutationObserver(() => scheduleScan());
  function applyCfg() {
    document.documentElement.classList.toggle('bpe-enabled', !!CFG.enabled);
    if (!CFG.enabled || !CFG.fillEnabled) resetVideoFill(true);
    else if (Fill.active) { Fill.lastMode = ''; updateVideoFill(); }
    if (!CFG.learnMode) {
      deepFind('.bpe-hide').forEach(c => { c.classList.remove('bpe-hide'); dropPh(c); });
      CORE.hiddenCount = 0;
    }
    scheduleScan();
    LOG('Cfg', '设置已应用（learnMode=' + CFG.learnMode + '）');
  }

  /* ============================================================
   * 17. 启动
   * ============================================================ */
  function boot() {
    addStyle(PAGE_CSS, 'bpe-page-css');
    buildUI();
    rebuildKeyMap();
    clearLegacyFill();          // 自救：清掉 v1.0/v1.1 留在页面上的黑屏类
    installSearchGuard();       // v1.3：拦掉 B 站原生搜索的一切跳转
    if (CAP.menu) {
      try {
        GM_registerMenuCommand('🎛 打开 BilibiliPlus Xi/Elio 设置', () => openPanel());
        GM_registerMenuCommand('🔍 原生搜索（再按一次关闭复原）', () => Bus.exec('searchZoom'));
        GM_registerMenuCommand('📋 复制搜索诊断（原生面板是否弹出）', () => Bus.exec('searchDiag'));
        GM_registerMenuCommand('🪟 浮层搜索（原生风格 · 联想词 · 分类结果）', () => Bus.exec('floatSearch'));
        GM_registerMenuCommand('📋 复制浮层搜索诊断（联想通道 / 分类 / 失败原因）', () => Bus.exec('floatDiag'));
        GM_registerMenuCommand('🔄 重试唤出 B 站原生搜索（播放页顶栏收起时）', () => Bus.exec('searchRetry'));
        GM_registerMenuCommand('🎛 展开 / 收起二级工具条', () => Bus.exec('dock'));
        GM_registerMenuCommand('↩︎ 倍速回到 1× 原速（清档位记忆）', () => Bus.exec('rateNormal'));
        GM_registerMenuCommand('📋 复制倍速诊断（长按 3× / 档键）', () => Bus.exec('rateDiag'));
        GM_registerMenuCommand('🎯 切换学习模式', () => Bus.exec('learn'));
        GM_registerMenuCommand('👁 弹幕显示开关（切换并验证状态）', () => Bus.exec('danmu'));
        GM_registerMenuCommand('📋 复制起播诊断（为什么没自动播）', () => Bus.exec('autoPlayDiag'));
        GM_registerMenuCommand('📋 复制音量诊断（记忆值 / 系统音量边界）', () => Bus.exec('volumeDiag'));
        GM_registerMenuCommand('🔊 立即解除静音（用记忆音量）', () => Bus.exec('unmuteNow'));
        GM_registerMenuCommand('📋 复制刷新诊断（R 键为什么没刷新）', () => Bus.exec('refreshDiag'));
        GM_registerMenuCommand('🎬 立即尝试自动起播', () => Bus.exec('autoPlayNow'));
        GM_registerMenuCommand('🔐 登录自检（排查「账号未登录」）', () => Bus.exec('loginCheck'));
        GM_registerMenuCommand('⛶ 全屏 / 铺满切换（转发 B 站按钮）', () => Bus.exec('fullscreen'));
        GM_registerMenuCommand('⇄ 切换填充模式', () => Bus.exec('fillToggle'));
        GM_registerMenuCommand('🧹 复位全屏状态（黑屏自救）', () => Bus.exec('fillReset'));
        GM_registerMenuCommand('⚡ 倍速 1× / 2× 切换', () => Bus.exec('rate', Math.abs((CFG.rate || 1) - 2) < 0.01 ? 1 : 2));
      } catch (e) { LOG('Menu', '注册失败：' + e.message); }
    }
    observer.observe(document.documentElement, { childList: true, subtree: true });
    /* v1.6.3：手势回调只做两件事 —— 记录手势时间 + 同步解除静音。
       Apple《为 Safari 传送视频内容》：在没有用户手势的情况下取消静音会暂停播放；
       所以 unmute 必须在这个真实手势回调里同步执行，不能 setTimeout、不能在 play().then()。
       旧版「play().then() + 60ms setTimeout + 还得等下一次手势」正是开播 1~2 秒没声音的根因。
       绝不在手势里补播（v1.6.2 的「暂停一次就停住」保持不变）。 */
    ['pointerdown', 'touchend', 'mousedown', 'keydown'].forEach(t =>
      document.addEventListener(t, e => {
        const first = !CORE.gestureSeen;
        CORE.gestureSeen = true;
        CORE.lastGestureAt = Date.now();
        const v = findVideo();
        if (!v) return;
        const inVolume = e.target && e.target.closest &&
          e.target.closest('[class*="volume"], [class*="voice"], [class*="mute"]');
        if (CFG.enabled && CFG.autoUnmute && v.muted && !inVolume) unmuteNow(v, '真实手势同步');
        if (first) apNote('已捕获首次真实手势 · 已同步解除静音（不补播）', { readyState: v.readyState });
      }, { capture: true, passive: true }));
    /* v1.6.3：iPad Safari 上 volume 只读、恒为 1，硬件音量键不触发 volumechange，
       所以额外从 B 站音量控件的真实数值（value / aria-valuenow）记「用户意图音量」。
       只在音量控件内生效，读不到数值就只记「见过滑块」，绝不编造。 */
    ['input', 'change', 'wheel'].forEach(t =>
      document.addEventListener(t, e => {
        const el = e.target;
        if (!el || !el.closest) return;
        const inVol = el.closest('[class*="volume"], [aria-label*="音量"], [data-volume]');
        if (!inVol) return;
        CORE.lastGestureAt = Date.now();
        let raw = el.value !== undefined ? Number(el.value) : NaN;
        if (!isFinite(raw) && el.getAttribute) raw = Number(el.getAttribute('aria-valuenow'));
        if (!isFinite(raw)) {
          CORE.volDiag = Object.assign({}, CORE.volDiag || {}, { sliderSeen: true, sliderValueUnreadable: true });
          return;
        }
        rememberVolume(raw > 1 ? raw / 100 : raw, 'bili-slider');
      }, { capture: true, passive: true }));
    window.addEventListener('popstate', () => {
      curVideo = null; unmuteTries = 0; scheduleScan(); restoreShortcuts('popstate');
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { restoreShortcuts('visibilitychange'); scheduleScan(); }
    });
    window.addEventListener('pageshow', () => restoreShortcuts('pageshow'));
    window.addEventListener('focus', () => restoreShortcuts('focus'));
    // 任何全屏状态变化都由 watchdog 统一判定：进则加 inline，退则原样还原
    ['fullscreenchange', 'webkitfullscreenchange', 'webkitbeginfullscreen', 'webkitendfullscreen', 'resize', 'orientationchange']
      .forEach(t => document.addEventListener(t, () => setTimeout(fillWatchdog, 180)));
    let lastUrl = location.href;
    setInterval(() => {
      updateKbdState();
      fillWatchdog();
      if (location.href !== lastUrl) {
        lastUrl = location.href; curVideo = null; unmuteTries = 0;
        // 新视频重新进入 20 秒起播窗口；apPlayed / apPaused 按 key 隔离，旧片记录不影响新片
        CORE.apStart = {}; CORE.apKicked = {}; CORE.apTries = 0; CORE.apOfficialClicked = false;
        stopAutoPlay();
        LOG('Nav', location.pathname); scheduleScan(); restoreShortcuts('spa');
      }
      // v1.6.3 复核：删掉这里与 scan() 重复的 autoPlayVideo(findVideo())。
      // 起播统一由 attachVideo 元数据事件 + scan()（MutationObserver / 2.5s tick）驱动，
      // 单一入口，不再每 900ms 无谓多跑一次 apAllowed。
    }, 900);
    setInterval(scheduleScan, 2500);
    applyCfg();
    render();
    updateBar();
    CORE.booted = true;
    LOG('Boot', 'BilibiliPlus Xi/Elio v' + CORE.version + ' 启动完成 · 全屏=转发按钮+video inline · Stay 能力 ' + Object.keys(CAP).filter(k => CAP[k]).length + '/9');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
