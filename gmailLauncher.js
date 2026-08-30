// gmailLauncher.js - the surface inside Gmail (9.2)
//
// Every other part of this extension lives behind the toolbar icon, and
// Chrome keeps that icon folded into the puzzle-piece menu until someone
// pins it. So an install could sit there for months having never scanned
// anything: the mailbox report, the storage x-ray and the whole recovery
// net are all one click away from a button most people never find.
//
// This file draws a small button in the corner of Gmail and, from it, the
// one thing worth doing first: the free read-only mailbox report. It is
// the only always-on part of the extension, so the rules it follows are
// stricter than anywhere else.
//
//   - It renders into a shadow root. Nothing it defines can leak into
//     Gmail's stylesheet and nothing Gmail defines can reach in.
//   - It touches exactly one node of the page, the host element it
//     appends to <body>. It never reads mail, never walks Gmail's DOM
//     and never looks at the message list.
//   - It decides nothing. Whether it may draw at all, whether the user
//     has been greeted, and what the report says are all answered by the
//     service worker, which is the only side that can read the licence
//     and the install source.
//   - It starts one kind of run: the read-only report. Anything that
//     moves mail stays in the popup, behind the confirmations that
//     already guard it.
(() => {
  "use strict";

  const LAUNCHER_VERSION = "9.2.0";

  // One host node, one id. A second injection (an extension update
  // re-running the script into a live tab) finds this and stands down
  // rather than stacking a second button on the first.
  const HOST_ID = "gcc-launcher-root";

  // Gmail Chat is served from the same origin as the mailbox, so the
  // manifest match alone is not enough: /chat is not a mailbox, and the
  // worker's isMailboxTab draws the same line down the /mail/ path. 8.21
  // fixed the engine for this and 9.0 found the popup still had it, so
  // the check is written the same way here on purpose.
  const isMailboxPath = () => /^\/mail\//.test(location.pathname);

  if (window.top !== window) return;
  if (!isMailboxPath()) return;
  if (document.getElementById(HOST_ID)) return;

  // =========================
  // Small helpers
  // =========================

  // Same shape as the popup's t(): catalogue key, inline English
  // fallback, optional substitutions. The fallback is what ships in the
  // file so a missing catalogue entry degrades to English rather than to
  // an empty panel.
  const t = (key, fallback, subs) => {
    try {
      const msg = chrome.i18n?.getMessage?.(key, subs);
      return msg || fallback;
    } catch {
      return fallback;
    }
  };

  // Resolves to null rather than rejecting. A content script outlives
  // its extension: after an update or a reload the port is gone and
  // sendMessage throws "Extension context invalidated" synchronously,
  // which would otherwise take the whole click handler down.
  const send = (message) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        // Read it so Chrome does not log "Unchecked runtime.lastError".
        void chrome.runtime?.lastError;
        resolve(resp || null);
      });
    } catch {
      resolve(null);
    }
  });

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value !== null && value !== undefined) {
        node.setAttribute(key, String(value));
      }
    }
    for (const child of [].concat(children)) {
      if (child) node.appendChild(child);
    }
    return node;
  };

  const num = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  };

  // "12,480" or "12,480+". The plus is the report's own "at least"
  // notation, carried through rather than rewritten: the scan says
  // whether Gmail stated a total, and a number that was never stated
  // must not be shown as if it had been.
  const fmtCount = (value, atLeast) => {
    const n = num(value);
    let text;
    try {
      text = n.toLocaleString();
    } catch {
      text = String(n);
    }
    return atLeast ? `${text}+` : text;
  };

  // =========================
  // Styles
  // =========================
  //
  // The extension's own palette ("Signal": neon cyan on cool ink),
  // declared on :host because Gmail defines none of these tokens and a
  // shadow root inherits custom properties from a document that has
  // them, not from a stylesheet it cannot see.
  const STYLE = `
    :host {
      --gcc-ink: #0b1118;
      --gcc-ink-2: #111a24;
      --gcc-line: rgba(148, 178, 200, 0.18);
      --gcc-text: #e6f0f6;
      --gcc-muted: #93a7b6;
      --gcc-primary: #22d3ee;
      --gcc-primary-strong: #7bf1fd;
      --gcc-on-primary: #04181d;
      all: initial;
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483000;
      font-family: "Google Sans", Roboto, Arial, sans-serif;
      color: var(--gcc-text);
    }
    * { box-sizing: border-box; }
    button {
      font: inherit;
      color: inherit;
      cursor: pointer;
      border: 0;
      background: none;
    }
    .pill {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 38px;
      padding: 0 16px 0 13px;
      border-radius: 19px;
      background: var(--gcc-ink);
      border: 1px solid rgba(34, 211, 238, 0.45);
      box-shadow: 0 6px 20px rgba(4, 12, 18, 0.34);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.1px;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .pill:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(4, 12, 18, 0.42); }
    .pill:focus-visible { outline: 2px solid var(--gcc-primary); outline-offset: 2px; }
    .pill svg { flex: 0 0 auto; }
    .pill .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--gcc-primary);
      box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.22);
    }
    .panel {
      width: 320px;
      max-height: 78vh;
      overflow-y: auto;
      border-radius: 14px;
      background: var(--gcc-ink);
      border: 1px solid var(--gcc-line);
      box-shadow: 0 18px 48px rgba(4, 12, 18, 0.48);
      padding: 16px;
    }
    .head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
    .head h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
      flex: 1 1 auto;
    }
    .icon-btn {
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      border-radius: 7px;
      color: var(--gcc-muted);
      line-height: 1;
      font-size: 15px;
    }
    .icon-btn:hover { background: rgba(148, 178, 200, 0.12); color: var(--gcc-text); }
    .icon-btn:focus-visible { outline: 2px solid var(--gcc-primary); outline-offset: 1px; }
    p { margin: 0 0 12px; font-size: 12.5px; line-height: 1.5; color: var(--gcc-muted); }
    p.tight { margin-bottom: 8px; }
    .stats { display: flex; gap: 10px; margin: 0 0 12px; }
    .stat {
      flex: 1 1 0;
      background: var(--gcc-ink-2);
      border: 1px solid var(--gcc-line);
      border-radius: 10px;
      padding: 10px;
    }
    .stat b {
      display: block;
      font-size: 19px;
      font-weight: 600;
      color: var(--gcc-primary-strong);
      line-height: 1.2;
    }
    .stat span { display: block; margin-top: 3px; font-size: 11px; line-height: 1.35; color: var(--gcc-muted); }
    .rows { margin: 0 0 12px; }
    .row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 0;
      border-top: 1px solid var(--gcc-line);
      font-size: 12.5px;
    }
    .row span { color: var(--gcc-muted); }
    .row b { font-weight: 600; }
    .cta {
      display: block;
      width: 100%;
      padding: 10px 14px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--gcc-primary-strong), var(--gcc-primary));
      color: var(--gcc-on-primary);
      font-size: 13px;
      font-weight: 600;
      text-align: center;
    }
    .cta:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .cta[disabled] { opacity: 0.6; cursor: default; }
    .ghost {
      display: block;
      width: 100%;
      margin-top: 8px;
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid var(--gcc-line);
      font-size: 12.5px;
      color: var(--gcc-muted);
      text-align: center;
    }
    .ghost:hover { color: var(--gcc-text); background: rgba(148, 178, 200, 0.08); }
    .ghost:focus-visible { outline: 2px solid var(--gcc-primary); outline-offset: 1px; }
    .foot { margin: 12px 0 0; font-size: 11px; line-height: 1.45; color: var(--gcc-muted); }
    .link {
      display: block;
      margin: 12px auto 0;
      padding: 2px 4px;
      font-size: 11px;
      color: var(--gcc-muted);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .link:hover { color: var(--gcc-text); }
    .link:focus-visible { outline: 2px solid var(--gcc-primary); outline-offset: 1px; }
    .spinner {
      width: 18px;
      height: 18px;
      margin: 4px 0 12px;
      border-radius: 50%;
      border: 2px solid rgba(34, 211, 238, 0.25);
      border-top-color: var(--gcc-primary);
      animation: gcc-spin 0.9s linear infinite;
    }
    @keyframes gcc-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .spinner { animation-duration: 3s; }
      .pill { transition: none; }
    }
    .hidden { display: none !important; }
  `;

  // =========================
  // State
  // =========================

  const state = {
    open: false,
    // idle | greet | scanning | result | error | hide | stale
    view: "idle",
    report: null,
    error: "",
    // The report timestamp as it was when a scan started. The scan is
    // finished when this changes, which is a fact the worker already
    // stores; polling for it beats inventing a second progress channel,
    // and it stays true if the popup is what finished the scan.
    baselineAt: 0,
    pollTimer: 0,
    pollUntil: 0,
    pinHint: false
  };

  let shadow = null;

  // =========================
  // Icon
  // =========================
  //
  // Drawn rather than loaded. An <img> would need the icon file in
  // web_accessible_resources, which puts a URL on the page that any site
  // could probe to test whether this extension is installed.
  const SVG_NS = "http://www.w3.org/2000/svg";

  const sparkle = (size) => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    const big = document.createElementNS(SVG_NS, "path");
    big.setAttribute("d", "M10 2.5l1.9 5.3 5.3 1.9-5.3 1.9L10 16.9l-1.9-5.3-5.3-1.9 5.3-1.9z");
    big.setAttribute("fill", "#22d3ee");
    const small = document.createElementNS(SVG_NS, "path");
    small.setAttribute("d", "M17.5 14l0.9 2.4 2.4 0.9-2.4 0.9-0.9 2.4-0.9-2.4-2.4-0.9 2.4-0.9z");
    small.setAttribute("fill", "#7bf1fd");
    svg.appendChild(big);
    svg.appendChild(small);
    return svg;
  };

  // =========================
  // Views
  // =========================

  const pill = () => el("button", {
    class: "pill",
    type: "button",
    "aria-label": t("launcherPill", "Clean Gmail"),
    onclick: () => openPanel()
  }, [
    sparkle(17),
    el("span", { text: t("launcherPill", "Clean Gmail") }),
    state.view === "greet" ? el("i", { class: "dot" }) : null
  ]);

  // One control in the header, and it closes. An earlier draft put a
  // minimise glyph beside it for Hide, which is the same shape people
  // read as "collapse this for now" and would have meant "take this
  // button away for a month". Hide is a worded link at the foot instead.
  const header = (title) => el("div", { class: "head" }, [
    el("h1", { text: title }),
    el("button", {
      class: "icon-btn",
      type: "button",
      text: "×",
      title: t("launcherClose", "Close"),
      "aria-label": t("launcherClose", "Close"),
      onclick: () => closePanel()
    })
  ]);

  const hideLink = () => el("button", {
    class: "link",
    type: "button",
    text: t("launcherHide", "Hide"),
    onclick: () => setView("hide")
  });

  const pinHintLine = () => (state.pinHint
    ? el("p", {
      class: "foot",
      text: t("launcherPinHint", "Pin the extension in your browser toolbar to reach every tool.")
    })
    : null);

  const scanCta = (label) => el("button", {
    class: "cta",
    type: "button",
    text: label,
    onclick: () => startScan()
  });

  const viewGreet = () => [
    header(t("launcherGreetTitle", "Your Gmail cleaner is ready")),
    el("p", {
      text: t(
        "launcherGreetBody",
        "Nothing has been scanned yet. The scan is free and read-only: it counts what is safe to clear and moves nothing."
      )
    }),
    scanCta(t("launcherScanCta", "Scan this mailbox")),
    el("button", {
      class: "ghost",
      type: "button",
      text: t("launcherNotNow", "Not now"),
      onclick: () => closePanel()
    }),
    el("p", {
      class: "foot",
      text: t("launcherPinHint", "Pin the extension in your browser toolbar to reach every tool.")
    })
  ];

  const viewIdle = () => [
    header(t("launcherIdleTitle", "Clean up this mailbox")),
    el("p", {
      text: t(
        "launcherGreetBody",
        "Nothing has been scanned yet. The scan is free and read-only: it counts what is safe to clear and moves nothing."
      )
    }),
    scanCta(t("launcherScanCta", "Scan this mailbox")),
    pinHintLine(),
    hideLink()
  ];

  const viewScanning = () => [
    header(t("launcherScanningTitle", "Reading your mailbox")),
    el("div", { class: "spinner" }),
    el("p", {
      text: t(
        "launcherScanningBody",
        "A few searches, nothing opened and nothing moved. Give it a moment."
      )
    })
  ];

  const viewError = () => [
    header(t("launcherIdleTitle", "Clean up this mailbox")),
    el("p", { text: state.error }),
    scanCta(t("launcherScanCta", "Scan this mailbox"))
  ];

  const viewStale = () => [
    header(t("launcherIdleTitle", "Clean up this mailbox")),
    el("p", {
      text: t("launcherStale", "The extension was updated. Reload Gmail to use this button.")
    })
  ];

  const viewHide = () => [
    header(t("launcherHideAsk", "Hide this button?")),
    el("p", { text: t("launcherHiddenNote", "Settings has a switch to bring it back.") }),
    el("button", {
      class: "cta",
      type: "button",
      text: t("launcherHide30", "For 30 days"),
      onclick: () => hide(false)
    }),
    el("button", {
      class: "ghost",
      type: "button",
      text: t("launcherHideOff", "Turn it off"),
      onclick: () => hide(true)
    })
  ];

  // The three rows under the two big numbers: the steps with mail in
  // them, biggest first. Band names come from the catalogue the popup's
  // own plan uses, so the two surfaces cannot drift apart in wording.
  const topBands = (report) => [...(Array.isArray(report?.bands) ? report.bands : [])]
    .filter((band) => band && num(band.count) > 0)
    .sort((a, b) => num(b.count) - num(a.count))
    .slice(0, 3);

  const viewResult = () => {
    const report = state.report || {};
    const bands = topBands(report);
    const rows = bands.map((band) => el("div", { class: "row" }, [
      el("span", { text: t(`reportBand_${band.id}`, band.id) }),
      el("b", { text: fmtCount(band.count, band.atLeast) })
    ]));

    const nodes = [header(t("launcherResultTitle", "What this mailbox is holding"))];

    if (!rows.length) {
      nodes.push(el("p", {
        text: t("launcherResultEmpty", "Nothing old enough to clear yet. That is a clean mailbox.")
      }));
    } else {
      nodes.push(el("div", { class: "stats" }, [
        el("div", { class: "stat" }, [
          el("b", { text: fmtCount(report.cleanableCount, report.cleanableAtLeast) }),
          el("span", { text: t("launcherStatEmails", "emails old enough to clear") })
        ]),
        el("div", { class: "stat" }, [
          el("b", { text: `${fmtCount(report.largeMb, true)} MB` }),
          el("span", { text: t("launcherStatStorage", "in old, large mail") })
        ])
      ]));
      nodes.push(el("div", { class: "rows" }, rows));
    }

    nodes.push(el("button", {
      class: "cta",
      type: "button",
      text: t("launcherOpenCta", "Open the cleaner"),
      onclick: () => openCleaner()
    }));
    nodes.push(el("button", {
      class: "ghost",
      type: "button",
      text: t("launcherRescan", "Scan again"),
      onclick: () => startScan()
    }));
    if (rows.length) {
      nodes.push(el("p", {
        class: "foot",
        text: t(
          "launcherResultFoot",
          "A plus sign means at least that many. Every count comes from Gmail's own search."
        )
      }));
    }
    nodes.push(pinHintLine());
    nodes.push(hideLink());
    return nodes;
  };

  const VIEWS = {
    greet: viewGreet,
    idle: viewIdle,
    scanning: viewScanning,
    result: viewResult,
    error: viewError,
    stale: viewStale,
    hide: viewHide
  };

  // takeFocus only when the person asked for the panel. Every other
  // render is a state change they did not initiate (a scan finishing,
  // the worker answering), and moving the caret out of whatever they
  // were typing in Gmail for one of those would be its own bug.
  const render = (takeFocus) => {
    if (!shadow) return;
    shadow.textContent = "";
    shadow.appendChild(el("style", { text: STYLE }));
    if (!state.open) {
      shadow.appendChild(pill());
      return;
    }
    const panel = el("div", {
      class: "panel",
      role: "dialog",
      "aria-modal": "false",
      "aria-label": t("launcherPill", "Clean Gmail")
    }, (VIEWS[state.view] || viewIdle)());
    shadow.appendChild(panel);
    if (!takeFocus) return;
    const focusable = panel.querySelector(".cta, .ghost, .icon-btn");
    if (focusable && typeof focusable.focus === "function") focusable.focus();
  };

  const setView = (view) => {
    state.view = view;
    render();
  };

  // =========================
  // Mounting
  // =========================

  const mount = () => {
    if (document.getElementById(HOST_ID)) return;
    const host = el("div", { id: HOST_ID, "data-gcc-version": LAUNCHER_VERSION });
    // Open, not closed: the suite drives this file through the shadow
    // root it builds, and a closed root would only be testable by
    // reaching for internals the page has no business seeing either.
    shadow = host.attachShadow({ mode: "open" });
    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) {
        event.stopPropagation();
        closePanel();
      }
    });
    document.body.appendChild(host);
    render();
  };

  const unmount = () => {
    stopPolling();
    shadow = null;
    document.getElementById(HOST_ID)?.remove();
  };

  // Gmail replaces large parts of its own tree as it navigates. The host
  // sits directly under <body> and has never been observed to go, but a
  // button that silently disappears is indistinguishable from a broken
  // extension, so this puts it back instead.
  const watchForRemoval = () => {
    if (typeof MutationObserver !== "function" || !document.body) return;
    const observer = new MutationObserver(() => {
      if (!shadow) return;
      if (!document.getElementById(HOST_ID)) {
        shadow = null;
        mount();
      }
    });
    observer.observe(document.body, { childList: true });
  };

  // =========================
  // Actions
  // =========================

  const openPanel = async () => {
    state.open = true;
    if (state.view !== "greet" && state.view !== "scanning") {
      state.view = state.report ? "result" : "idle";
    }
    render(true);

    // Then catch up, because this panel was built when the page loaded
    // and the popup may have run a scan since. Rendering first keeps the
    // click instant; the second render only happens when the answer
    // actually differs from what is already on screen.
    if (state.view !== "idle" && state.view !== "result") return;
    const resp = await send({ type: "gmailCleanerLauncherState" });
    if (!resp?.ok || !state.open) return;
    if (resp.show === false) return unmount();
    // Checked again after the await: a click lands in the milliseconds
    // the worker takes to answer, and a fresher report is no reason to
    // replace a Hide confirmation or a scan in progress with it.
    if (state.view !== "idle" && state.view !== "result") return;
    const fresh = Number(resp.report?.updatedAt) || 0;
    if (fresh === (Number(state.report?.updatedAt) || 0)) return;
    state.report = resp.report;
    setView(state.report ? "result" : "idle");
  };

  const closePanel = () => {
    state.open = false;
    if (state.view === "greet" || state.view === "error" || state.view === "hide") {
      state.view = state.report ? "result" : "idle";
    }
    render();
  };

  const stopPolling = () => {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  };

  // Never forces the panel open. Someone who started a scan and then
  // closed the panel has said what they want the corner of their mailbox
  // to look like; the pill still carries the answer when they ask for it.
  const failScan = (key, fallback) => {
    stopPolling();
    state.error = t(key, fallback);
    setView("error");
  };

  // The scan is done when the worker's stored report carries a newer
  // timestamp than the one this panel started from. No second progress
  // channel, and it stays correct when the run was finished by the popup
  // or by a scan that was already in flight.
  const poll = async () => {
    state.pollTimer = 0;
    const resp = await send({ type: "gmailCleanerLauncherState" });
    if (!resp) return setView("stale");
    if (resp.show === false) return unmount();

    const updatedAt = Number(resp.report?.updatedAt) || 0;
    if (updatedAt > state.baselineAt) {
      stopPolling();
      state.report = resp.report;
      return setView("result");
    }
    if (Date.now() >= state.pollUntil) {
      return failScan(
        "launcherScanSlow",
        "The scan is taking longer than usual. Open the extension from the toolbar to watch it."
      );
    }
    state.pollTimer = setTimeout(poll, 2000);
  };

  const SCAN_ERRORS = Object.freeze({
    busy: ["launcherBusy", "Something is already running in this tab. Try again once it finishes."],
    no_mailbox: ["launcherScanFailed", "Could not start the scan here. Open the extension from the toolbar instead."],
    untrusted: ["launcherScanFailed", "Could not start the scan here. Open the extension from the toolbar instead."],
    swallowed: ["launcherBusy", "Something is already running in this tab. Try again once it finishes."]
  });

  const startScan = async () => {
    stopPolling();
    state.baselineAt = Number(state.report?.updatedAt) || 0;
    state.open = true;
    setView("scanning");

    const resp = await send({ type: "gmailCleanerLauncherScan" });
    if (!resp) return setView("stale");
    if (!resp.ok) {
      const [key, fallback] = SCAN_ERRORS[resp.error] || SCAN_ERRORS.no_mailbox;
      return failScan(key, fallback);
    }
    // Three minutes. A report is fifteen searches and finishes inside a
    // minute on a normal mailbox; past this it is better to hand the
    // person the popup, which can actually show the run, than to spin.
    state.pollUntil = Date.now() + 180000;
    state.pollTimer = setTimeout(poll, 2000);
  };

  const openCleaner = async () => {
    const resp = await send({ type: "gmailCleanerLauncherOpenPopup" });
    if (resp?.ok) return closePanel();
    // chrome.action.openPopup() is Chrome 127 and later, and Firefox has
    // its own rules about it. When it will not open, say where the icon
    // is rather than doing nothing visible.
    state.pinHint = true;
    render();
  };

  const hide = async (forever) => {
    await send({ type: "gmailCleanerLauncherHide", forever: forever === true });
    unmount();
  };

  // =========================
  // Boot
  // =========================

  const boot = async () => {
    const resp = await send({ type: "gmailCleanerLauncherState" });
    // No answer at all means no service worker to talk to, which on a
    // freshly reloaded extension is a tab holding a dead port. Drawing a
    // button whose every click fails is worse than drawing nothing.
    if (!resp?.ok || resp.show === false) return;

    state.report = resp.report || null;
    if (resp.greet) {
      // Cleared before the panel is drawn, not after it is dismissed: a
      // second Gmail tab opening in the same second must not greet as
      // well, and a greeting nobody closed should still count as given.
      send({ type: "gmailCleanerLauncherGreeted" });
      state.view = "greet";
      state.open = true;
    } else if (resp.busy) {
      // A run started somewhere else is already driving this mailbox.
      // The pill draws, closed, and says nothing about it.
      state.view = state.report ? "result" : "idle";
    } else {
      state.view = state.report ? "result" : "idle";
    }

    mount();
    watchForRemoval();
  };

  boot();
})();
