(() => {
  "use strict";

  // =========================
  // What's new (8.9)
  // =========================
  // Renders changelog-data.js, which tools/build-changelog.mjs generates
  // from CHANGELOG.md. Nothing here fetches anything: the log is baked
  // into the package, because a request for a packaged file is still a
  // request, and "makes no network calls" is the claim the listings and
  // the AMO reviewer notes rest on.
  //
  // Opening this page is also what clears the dot on the popup's version
  // button, so the marker is written even if the data fails to render.

  const CHANGELOG_VERSION = "8.19.0";

  // Local, not sync. It describes this installation ("you have read the
  // notes for 8.9.0 in this browser"), and sync would have another
  // machine's reading history silence the dot here.
  const SEEN_KEY = "changelogSeenVersion";

  const el = (id) => document.getElementById(id);

  const currentVersion = () => {
    try {
      return chrome?.runtime?.getManifest?.().version || CHANGELOG_VERSION;
    } catch {
      return CHANGELOG_VERSION;
    }
  };

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  // Runs arrive as [kind, text] with kind "" | "b" | "c" | "bc", or as a
  // bare string for the common all-plain case. Everything becomes a text
  // node or a <strong>/<code> around one, so nothing in the log can turn
  // into markup no matter what a future entry contains.

  function appendRuns(parent, runs) {
    if (typeof runs === "string") {
      parent.appendChild(document.createTextNode(runs));
      return;
    }
    if (!Array.isArray(runs)) return;
    for (const run of runs) {
      if (!Array.isArray(run)) continue;
      const kind = String(run[0] || "");
      // Innermost first: a code span inside a bold run stays monospaced
      // AND bold, which is how the log writes queries inside a lede.
      let node = document.createTextNode(run[1]);
      if (kind.includes("c")) {
        const code = document.createElement("code");
        code.appendChild(node);
        node = code;
      }
      if (kind.includes("b")) {
        const strong = document.createElement("strong");
        strong.appendChild(node);
        node = strong;
      }
      parent.appendChild(node);
    }
  }

  const paragraph = (runs) => {
    const p = document.createElement("p");
    appendRuns(p, runs);
    return p;
  };

  function bulletList(items) {
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      appendRuns(li, item.text);
      if (Array.isArray(item.sub) && item.sub.length) {
        const inner = document.createElement("ul");
        for (const sub of item.sub) {
          const subLi = document.createElement("li");
          appendRuns(subLi, sub);
          inner.appendChild(subLi);
        }
        li.appendChild(inner);
      }
      ul.appendChild(li);
    }
    return ul;
  }

  const anchorFor = (version) => "v" + String(version).replace(/[^A-Za-z0-9.]/g, "-");

  function renderRelease(entry, isCurrent) {
    const section = document.createElement("section");
    section.className = isCurrent ? "release is-current" : "release";
    section.id = anchorFor(entry.version);
    section.setAttribute("aria-labelledby", section.id + "-h");

    const head = document.createElement("div");
    head.className = "release-head";

    const h2 = document.createElement("h2");
    h2.id = section.id + "-h";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = entry.version;
    h2.appendChild(num);
    if (entry.title) h2.appendChild(document.createTextNode(entry.title));
    head.appendChild(h2);

    if (isCurrent) {
      const tag = document.createElement("span");
      tag.className = "tag tag-primary";
      tag.textContent = "you are running this";
      head.appendChild(tag);
    }
    section.appendChild(head);

    for (const intro of entry.intro || []) section.appendChild(paragraph(intro));
    if (entry.items && entry.items.length) section.appendChild(bulletList(entry.items));

    for (const sec of entry.sections || []) {
      const h3 = document.createElement("h3");
      h3.textContent = sec.name;
      section.appendChild(h3);
      for (const intro of sec.intro || []) section.appendChild(paragraph(intro));
      if (sec.items && sec.items.length) section.appendChild(bulletList(sec.items));
    }

    return section;
  }

  function renderIndex(entries, current) {
    const nav = el("releaseIndex");
    if (!nav) return;
    for (const entry of entries) {
      const a = document.createElement("a");
      a.href = "#" + anchorFor(entry.version);
      a.textContent = entry.version;
      if (entry.version === current) {
        a.className = "is-current";
        a.setAttribute("aria-current", "true");
      }
      nav.appendChild(a);
    }
    nav.hidden = entries.length < 2;
  }

  function renderOlderNote(shown, total) {
    const note = el("olderNote");
    if (!note) return;
    const hidden = Math.max(0, total - shown);
    if (!hidden) return;
    note.textContent =
      `Showing the newest ${shown} of ${total} releases. The other ${hidden} ` +
      "are in the full log on GitHub, linked below.";
    note.hidden = false;
  }

  function renderEmpty(message) {
    const list = el("releaseList");
    if (!list) return;
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = message;
    list.appendChild(div);
  }

  // ---------------------------------------------------------------
  // Seen marker
  // ---------------------------------------------------------------

  async function markSeen(version) {
    if (!window.GCC || !GCC.hasChromeStorage("local")) return;
    try {
      await GCC.promisify(
        chrome.storage.local.set.bind(chrome.storage.local),
        { [SEEN_KEY]: version }
      );
    } catch {
      // A dot that stays on is a cosmetic annoyance, never a failure
      // worth surfacing on a page about release notes.
    }
  }

  // ---------------------------------------------------------------
  // Theme (5.0 pattern, same on every extension page)
  // ---------------------------------------------------------------

  async function initThemeSwitcher() {
    const root = el("themeSwitcher");
    if (!root || !window.GCC) return;
    const current = await GCC.theme.get();
    for (const btn of root.querySelectorAll("button[data-theme-value]")) {
      btn.setAttribute("aria-pressed", btn.dataset.themeValue === current ? "true" : "false");
      btn.addEventListener("click", async () => {
        const applied = await GCC.theme.set(btn.dataset.themeValue);
        root.querySelectorAll("button[data-theme-value]").forEach((b) => {
          b.setAttribute("aria-pressed", b.dataset.themeValue === applied ? "true" : "false");
        });
      });
    }
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  async function init() {
    if (window.GCC?.theme?.init) await GCC.theme.init();
    await initThemeSwitcher();

    const version = currentVersion();

    const badge = el("versionBadge");
    if (badge) {
      badge.textContent = "v" + version;
      badge.setAttribute("aria-label", "Version " + version);
    }

    // Written before rendering, so a data problem still clears the dot
    // rather than leaving it stuck on forever.
    await markSeen(version);

    const list = el("releaseList");
    const data = typeof GCC_CHANGELOG !== "undefined" ? GCC_CHANGELOG : null;
    const entries = Array.isArray(data?.entries) ? data.entries : [];

    if (!list) return;
    if (!entries.length) {
      renderEmpty("The release notes could not be loaded. The full log is on GitHub.");
      return;
    }

    renderIndex(entries, version);
    for (const entry of entries) {
      list.appendChild(renderRelease(entry, entry.version === version));
    }
    renderOlderNote(entries.length, Number(data.total) || entries.length);

    // Deep link from the popup's "what changed" affordance lands on the
    // running version rather than the top of the page.
    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
