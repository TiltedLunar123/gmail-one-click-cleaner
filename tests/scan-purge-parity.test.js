/**
 * @jest-environment node
 *
 * Scan/purge parity (8.5).
 *
 * The Mailbox Report and the Storage X-ray both show a number with a
 * Clean button next to it. Until 8.5 the number and the button asked
 * Gmail two different questions: the counts went out raw, while the
 * purge went through applyGlobalGuards. So a report band read
 *
 *     category:updates older_than:1y                     -> 5,000
 *
 * and the run that followed searched
 *
 *     category:updates older_than:1y -is:starred -is:important
 *                                    -is:unread -has:userlabels
 *
 * and cleared nothing, because `category:updates` is notification mail
 * nobody opens and `-is:unread` removed the whole band. The user was
 * told 5,000 and got 0, twice, and reasonably concluded the product was
 * broken.
 *
 * The rule this pins: a number displayed beside an action is measured
 * through the same filter that action applies. Everything else here
 * follows from that:
 *
 *   - the scans send the guard settings, rather than letting
 *     sanitizeConfig default a missing guard to ON
 *   - the counts are measured with those guards applied
 *   - the mail the guards hold back is measured too and surfaced,
 *     because an honest report of zeroes still has to explain itself
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf-8");

const engineSrc = read("contentScript.js");
const popupSrc = read("popup.js");
const bgSrc = read("background.js");
const popupHtml = read("popup.html");

/** The body of a named function in the engine, up to the next one. */
const fnBody = (src, startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  expect(from).toBeGreaterThan(-1);
  const to = src.indexOf(endMarker, from);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
};

describe("the report counts what its Clean button acts on", () => {
  const scan = fnBody(engineSrc, "async function reportScan(", "async function smartScan(");

  test("band searches go through applyGlobalGuards", () => {
    expect(scan).toContain("applyGlobalGuards(steps[i].query)");
  });

  test("no band search is issued raw", () => {
    // The exact defect: openSearch(steps[i].query) counted one thing
    // while the purge deleted another.
    expect(scan).not.toContain("openSearch(steps[i].query)");
  });

  test("sender attribution is guarded too", () => {
    // Sampling the raw band would name senders whose mail the purge
    // cannot touch, sending the user after the wrong people.
    expect(scan).toContain("applyGlobalGuards(def.query)");
    expect(scan).not.toContain("openSearch(def.query)");
  });

  test("the purge still applies the same guards, so parity is real", () => {
    // If this ever stopped being true the parity would be vacuous.
    expect(engineSrc).toContain("const guardedQuery = applyGlobalGuards(query);");
  });
});

describe("the storage x-ray counts what its purge acts on", () => {
  const scan = fnBody(engineSrc, "async function storageScan(", "async function reportScan(");

  test("tier searches go through applyGlobalGuards", () => {
    expect(scan).toContain("applyGlobalGuards(queries[i])");
    expect(scan).not.toContain("openSearch(queries[i])");
  });
});

describe("the subscription scan is deliberately NOT guarded", () => {
  const scan = fnBody(engineSrc, "async function subscriptionScan(", "async function unsubscribeRun(");

  test("it stays raw, because unsubscribing is not deleting", () => {
    // The parity rule is "measure what the action does". The action
    // here clicks an unsubscribe link; it does not move mail, so the
    // delete guards have nothing to say about it. Guarding this scan
    // would hide senders the user could genuinely unsubscribe from.
    expect(scan).toContain("openSearch(queries[i])");
    expect(scan).not.toContain("applyGlobalGuards");
  });
});

describe("Smart Suggestions count what their own button acts on (8.6)", () => {
  const scan = fnBody(engineSrc, "async function smartScan(", "async function driveMoveBackControl(");
  const sharedSrc = read("shared.js");

  test("each surviving sender is measured through applyGlobalGuards", () => {
    // The defect: the card read "402 emails, 100% unread, mostly older
    // than 6 months" from the raw `from:(sender)` total, and its Delete
    // old mail button sent `from:(sender) older_than:6m` through
    // applyGlobalGuards, which appends -is:unread. A suggestion sold on
    // never-opened mail could only ever clean nothing.
    expect(scan).toContain("reachable = await fetchCount(applyGlobalGuards(actionQuery));");
  });

  test("the measured query is the ACTION's query, not the signal query", () => {
    // Guarding the signal queries instead would have been worse than
    // useless: a guarded `is:unread` count is always zero, so the
    // unread ratio (45 of the 100 score points) would read zero for
    // every sender in every mailbox.
    expect(scan).toContain("const action = smartPrimaryActionFor(scored[i].signals);");
    expect(scan).toContain("const actionQuery = smartActionQuery(scored[i].email, action);");
  });

  test("a sender the guards empty is not suggested, and is counted", () => {
    // Dropping it silently is how an honest scan starts looking like a
    // broken one.
    expect(scan).toContain("heldBackSenders += 1;");
    expect(scan).toContain("heldBackCount += Number(scored[i].estCount) || 0;");
    expect(scan).toContain("heldBackSenders,");
    expect(scan).toContain("heldBackCount");
  });

  test("unsubscribe is deliberately not measured, same rule as the subscription scan", () => {
    // That action clicks a link; it does not move mail, so the delete
    // guards have nothing to say about it and there is no count to
    // promise.
    expect(engineSrc).toContain('if (action === "purgeLarge") return `from:(${email}) larger:5M older_than:6m`;');
    const builder = fnBody(engineSrc, "function smartActionQuery(", "// Signal sampling for one sender");
    expect(builder).toContain('return "";');
    expect(scan).toContain("if (actionQuery) {");
  });

  test("the popup renders the action the scan measured, not a fresh decision", () => {
    // Deciding again in the popup is how the number and the button
    // drift apart the moment the policy or the stored signals move.
    expect(popupSrc).toContain("const action = GCC.smart.resolvedAction(sender);");
    expect(popupSrc).not.toContain("const action = GCC.smart.primaryAction(sender);");
    expect(sharedSrc).toContain("const smartResolvedAction = (sender) =>");
  });

  test("the count beside the button comes from reachable, and is silent when unmeasured", () => {
    const helper = fnBody(sharedSrc, "const smartActionCountText = (sender) => {", "const smart = Object.freeze({");
    expect(helper).toContain("const raw = sender?.reachable;");
    // A stored suggestion from before 8.6, or an unsubscribe card, has
    // no measured count. Saying nothing beats a number nothing honours.
    expect(helper).toContain('if (typeof raw !== "number" || !Number.isFinite(raw)) return "";');
    expect(helper).toContain('if (action === "unsubscribe") return "";');
    expect(popupSrc).toContain("const willTake = GCC.smart.actionCountText(sender);");
  });

  test("reachable survives the worker round trip, and missing is not zero", () => {
    // The popup reads the union-merged list back out of storage, so a
    // sanitizer that dropped the field would put the raw total back
    // beside the button on the very next popup open.
    expect(bgSrc).toContain('if (typeof raw?.reachable === "number" && Number.isFinite(raw.reachable)) {');
    expect(bgSrc).toContain("if (SMART_ACTION_NAMES.includes(raw?.action)) entry.action = raw.action;");
    // Auto-Pilot runs unattended, so a sender it can never clean is a
    // scheduled report of zero.
    expect(bgSrc).toContain('.filter((s) => typeof s.reachable !== "number" || s.reachable > 0)');
  });

  test("bulk apply caps once, and the query, the status and the marker agree", () => {
    // buildBulkRule drops everything past MAX_BULK_PER_RUN, so checking
    // 30 senders produced a query carrying 25, a status line reading
    // "Cleaning up 30 senders" and an applied marker claiming all 30.
    const bulk = fnBody(popupSrc, "const capped = emails.slice(0, GCC.smart.LIMITS.MAX_BULK_PER_RUN);", "const handleSmartDismiss");
    expect(bulk).toContain("if (emails.length > capped.length) {");
    expect(bulk).toContain("GCC.smart.buildBulkRule(capped)");
    expect(bulk).toContain("GCC.storageXray.sanitizeEmails(capped)");
    expect(bulk).not.toContain("buildBulkRule(emails)");
  });
});

describe("the popup sends the guards rather than letting them default", () => {
  test("there is one helper and every scan uses it", () => {
    expect(popupSrc).toContain("const buildScanGuards = async () => ({");
    const uses = popupSrc.split("await buildScanGuards()").length - 1;
    // report, x-ray, and (8.6) the smart scan.
    expect(uses).toBe(3);
  });

  test("it carries every guard applyGlobalGuards reads", () => {
    const helper = fnBody(popupSrc, "const buildScanGuards = async () => ({", "// =========================");
    for (const key of [
      "guardSkipStarred",
      "guardSkipImportant",
      "guardSkipUnread",
      "guardSkipUserLabels",
      "safeMode",
      "minAge",
      "whitelist",
      "protectKeywords"
    ]) {
      expect(helper).toContain(key);
    }
  });

  test("every scan config includes it", () => {
    for (const kind of ['runKind: "reportScan"', 'runKind: "storageScan"']) {
      const at = popupSrc.indexOf(kind);
      expect(at).toBeGreaterThan(-1);
      expect(popupSrc.slice(at, at + 160)).toContain("buildScanGuards()");
    }
    // 8.6: the smart scan measures through the guards now, so it needs
    // the user's real switches. It used to send only the whitelist and
    // the protected keywords, leaving sanitizeConfig to default all
    // four guards to ON for a user who had turned them off.
    const smartAt = popupSrc.indexOf('runKind: "smartScan"');
    expect(smartAt).toBeGreaterThan(-1);
    expect(popupSrc.slice(smartAt, smartAt + 700)).toContain("buildScanGuards()");
  });

  test("sending them explicitly is the point, because missing reads as ON", () => {
    // sanitizeConfig treats an absent guard as enabled, so a scan that
    // sent nothing would count as though all four were set even for a
    // user who had turned them off. That is the same lie, mirrored.
    expect(engineSrc).toContain("guardSkipUnread: config.guardSkipUnread !== false");
    expect(engineSrc).toContain("guardSkipUserLabels: config.guardSkipUserLabels !== false");
  });
});

describe("an honest report still explains itself", () => {
  const scan = fnBody(engineSrc, "async function reportScan(", "async function smartScan(");

  test("the headline is measured both ways", () => {
    expect(scan).toContain('id: "__headlineRaw"');
    expect(scan).toContain("guarded: false");
    expect(scan).toContain("guarded: true");
  });

  test("the gap is reported, and cannot go negative", () => {
    expect(scan).toContain("const guardedOutCount = Math.max(0, unguardedCount - cleanableCount);");
    expect(scan).toContain("guardedOutCount");
  });

  test("the extra search is inside the query budget", () => {
    // 1 raw headline + 1 guarded headline + 10 bands + 2 attribution.
    const limit = Number(engineSrc.match(/MAX_QUERIES: (\d+)/)[1]);
    const bands = (engineSrc.match(/id: "(sizeHuge|sizeLarge|sizeBig|promotions|social|updates|forums|newsletters|inboxAncient|inboxOld)"/g) || []).length;
    expect(bands).toBeGreaterThan(0);
    expect(bands + 2).toBeLessThanOrEqual(limit);
    // shared.js has to agree or the engine's own assertion trips.
    expect(read("shared.js")).toContain(`MAX_QUERIES: ${limit}`);
  });

  test("the worker persists it, clamped like every other number", () => {
    expect(bgSrc).toContain("guardedOutCount: clampReportNumber(msg?.guardedOutCount)");
  });

  test("the popup renders it and offers a way to the guards", () => {
    expect(popupHtml).toContain('id="reportGuardNote"');
    expect(popupSrc).toContain("const renderGuardNote = () => {");
    expect(popupSrc).toContain("state.report.guardedOutCount");
    // Naming which guards are responsible is the actionable half.
    const note = fnBody(popupSrc, "const renderGuardNote = () => {", "const renderReport = () => {");
    expect(note).toContain("skipUnreadEl");
    expect(note).toContain("skipLabeledEl");
  });

  test("it stays hidden when there is nothing to explain", () => {
    const note = fnBody(popupSrc, "const renderGuardNote = () => {", "const renderReport = () => {");
    // No scan yet, nothing held back, or every guard already off.
    expect(note).toContain("!state.report.updatedAt || held < 1");
    expect(note).toContain("if (!which.length)");
  });
});

describe("the tab bar survives translation", () => {
  test("the popup is wide enough to stop fighting itself", () => {
    // 380px was the width the tab bar overflowed at and the width every
    // list row was fighting for. Chrome allows up to 800.
    const block = popupHtml.slice(popupHtml.indexOf("body {"), popupHtml.indexOf("::selection"));
    const width = Number(block.match(/width:\s*(\d+)px/)[1]);
    expect(width).toBeGreaterThanOrEqual(420);
    expect(width).toBeLessThanOrEqual(800);
  });

  test("a tab can shrink below its own label", () => {
    // min-width defaults to auto on a flex item, so a tab could not
    // shrink past its text and the bar overflowed the popup
    // instead of compressing.
    const block = popupHtml.slice(
      popupHtml.indexOf('.tab-bar [role="tab"] {'),
      popupHtml.indexOf('.tab-bar [role="tab"] svg')
    );
    expect(block).toMatch(/min-width:\s*0/);
    expect(block).toMatch(/overflow:\s*hidden/);
  });

  test("the label ellipsises rather than pushing the bar wider", () => {
    expect(popupHtml).toContain('.tab-bar [role="tab"] > span {');
    const block = popupHtml.slice(
      popupHtml.indexOf('.tab-bar [role="tab"] > span {'),
      popupHtml.indexOf('.tab-bar [role="tab"]:hover')
    );
    expect(block).toMatch(/text-overflow:\s*ellipsis/);
  });

  test("every locale's tab labels are short enough to fit four across", () => {
    // A character count cannot decide this and is not pretending to:
    // "Relatorio" (9) fits and Cyrillic "Hranilishche" (9) does not,
    // because a character is not a fixed width. The real check was done
    // by rendering popup.html at its real width, swapping in each
    // locale's four labels, and asking the browser which spans
    // overflowed. All seven pass; two labels were shortened to make
    // them (de tabStorage, ru tabStorage). The ellipsis rule above is
    // what keeps a future translation from breaking the bar rather
    // than merely truncating it.
    //
    // So this is a smoke test for the obvious regression: a label long
    // enough that no budget would have saved it, which is the shape the
    // bug actually took ("Unsubscribe", "Cancelar inscricao").
    const LOCALES = ["en", "pt_BR", "es", "fr", "de", "ru", "ja"];
    for (const locale of LOCALES) {
      const catalog = JSON.parse(read(path.join("_locales", locale, "messages.json")));
      for (const key of ["tabReport", "tabClean", "tabUnsubscribe", "tabStorage"]) {
        const label = catalog[key].message;
        if (label.length > 10) {
          throw new Error(`${locale}/${key} is ${label.length} chars: "${label}"`);
        }
      }
    }
  });
});
