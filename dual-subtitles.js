// Dual Subtitles for Seanime Denshi 3.10.3's VideoCore player.
// A second text layer, conservative language-independent timing, and CJK fonts.
function init() {
    $ui.register((ctx) => {
        function createSubtitleTimingTools() {
            const MAX_ADVANCE = 180;
            function speechIntervals(cues) {
                const merged = [];
                const rows = (cues || []).filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) &&
                    c.start >= 0 && c.end > c.start && c.end - c.start < 30 && c.text &&
                    !/^[\s♪♫♬～〜~―ー…・.\-\[\]()（）「」]+$/.test(c.text))
                    .slice().sort((a, b) => a.start - b.start);
                rows.forEach(c => {
                    const last = merged[merged.length - 1];
                    if (last && c.start <= last.end + 0.15) last.end = Math.max(last.end, c.end);
                    else merged.push({ start: c.start, end: c.end });
                });
                return merged;
            }
            function bins(rows, step, length) {
                const out = new Uint8Array(length);
                rows.forEach(c => {
                    const end = Math.min(length, Math.round(c.end / step));
                    for (let i = Math.max(0, Math.round(c.start / step)); i < end; i++) out[i] = 1;
                });
                return out;
            }
            function fit(referenceCues, subtitleCues) {
                const reference = speechIntervals(referenceCues), subtitle = speechIntervals(subtitleCues);
                if (reference.length < 8 || subtitle.length < 8) return { anchors: [], reason: "Waiting for more embedded dialogue cues." };
                const first = reference[0].start, last = reference[reference.length - 1].end;
                if (last - first < 45 || last > 7200 || subtitle[subtitle.length - 1].end > 7380) {
                    return { anchors: [], reason: "Not enough usable reference coverage, or track exceeds the two-hour limit." };
                }
                // Cached cues can contain an unseen interior gap after a seek. Do not
                // confuse that with dialogue that is present but too dense to match
                // independently: agreeing matches can safely bracket the latter.
                const coverage = [];
                reference.forEach(c => {
                    const previous = coverage[coverage.length - 1];
                    if (previous && c.start - previous.end <= 60) previous.end = c.end;
                    else coverage.push({ start: c.start, end: c.end });
                });
                const limit = Math.ceil((Math.max(last, subtitle[subtitle.length - 1].end) + MAX_ADVANCE + 2) * 10);
                const coarseReference = bins(reference, 0.5, Math.ceil(limit / 5)), coarseSubtitle = bins(subtitle, 0.5, Math.ceil(limit / 5));
                const fineReference = bins(reference, 0.1, limit), fineSubtitle = bins(subtitle, 0.1, limit);
                function measure(ref, sub, from, to, shift) {
                    let a = 0, b = 0, overlap = 0;
                    for (let i = from; i < to; i++) {
                        const x = ref[i] || 0, y = sub[i + shift] || 0;
                        a += x; b += y; overlap += x && y ? 1 : 0;
                    }
                    const n = to - from, p = a / n, q = b / n;
                    // Chance-corrected correlation rejects dense unrelated subtitles.
                    const denominator = Math.sqrt(p * (1 - p) * q * (1 - q));
                    return denominator > 0 && p > 0.08 && p < 0.9 && q > 0.08 && q < 0.9
                        ? (overlap / n - p * q) / denominator : -1;
                }
                const anchors = [];
                for (let start = Math.floor(first / 60) * 60; start < last - 45; start += 60) {
                    const end = Math.min(last, start + 120);
                    if (reference.filter(c => c.end > start && c.start < end).length < 8) continue;
                    const from = Math.round(start * 2), to = Math.round(end * 2), candidates = [];
                    let best = { advance: 0, score: -1 };
                    for (let shift = -MAX_ADVANCE * 2; shift <= MAX_ADVANCE * 2; shift++) {
                        const score = measure(coarseReference, coarseSubtitle, from, to, shift);
                        candidates.push({ advance: shift / 2, score });
                        if (score > best.score) best = { advance: shift / 2, score };
                    }
                    const alternative = candidates.reduce((score, c) => Math.abs(c.advance - best.advance) > 3 ? Math.max(score, c.score) : score, -1);
                    if (best.score < 0.55 || best.score - alternative < 0.07 || Math.abs(best.advance) >= MAX_ADVANCE - 1) continue;
                    let refined = { advance: best.advance, score: -1 };
                    for (let shift = Math.round((best.advance - 0.7) * 10); shift <= Math.round((best.advance + 0.7) * 10); shift++) {
                        const score = measure(fineReference, fineSubtitle, Math.round(start * 10), Math.round(end * 10), shift);
                        if (score > refined.score) refined = { advance: shift / 10, score };
                    }
                    if (refined.score >= 0.55) anchors.push({ time: (start + end) / 2, advance: refined.advance, confidence: refined.score, from: start, to: end });
                }
                // Discard isolated jumps contradicted by both neighbouring windows.
                const stable = anchors.filter((a, i) => {
                    const left = anchors[i - 1], right = anchors[i + 1];
                    return !left || !right || Math.abs(left.advance - right.advance) > 1 ||
                        Math.abs(a.advance - left.advance) <= 1 || a.confidence > 0.88;
                });
                for (let i = 1; i < stable.length; i++) {
                    const left = stable[i - 1], right = stable[i];
                    if (Math.abs(right.advance - left.advance) <= 1) {
                        right.bridgeFromPrevious = right.from - left.to > 60 &&
                            coverage.some(c => c.start <= left.to && c.end >= right.from);
                        continue;
                    }
                    let edge = left.time, biggest = { size: 0, middle: (left.time + right.time) / 2 };
                    reference.filter(c => c.end > left.time && c.start < right.time).forEach(c => {
                        const next = Math.min(right.time, c.start);
                        if (next - edge > biggest.size) biggest = { size: next - edge, middle: (next + edge) / 2 };
                        edge = Math.max(edge, Math.min(right.time, c.end));
                    });
                    if (right.time - edge > biggest.size) biggest = { size: right.time - edge, middle: (right.time + edge) / 2 };
                    right.boundary = biggest.middle;
                }
                return { anchors: stable, reason: stable.length ? "" : "No confident timing match; original timing kept.",
                    referenceStart: first, referenceEnd: last };
            }
            function advanceAt(model, time) {
                if (!model || !model.anchors.length || !Number.isFinite(time) ||
                    time < model.referenceStart - 10 || time > model.referenceEnd + 1) return null;
                const anchors = model.anchors;
                let left = anchors[0];
                if (time <= left.time) return time >= left.from - 1 ? left.advance : null;
                for (let i = 1; i < anchors.length; i++) {
                    const right = anchors[i];
                    if (time < right.time) {
                        if (right.from - left.to > 60 && !right.bridgeFromPrevious && time > left.to && time < right.from) return null;
                        if (Math.abs(right.advance - left.advance) > 1) return time < right.boundary ? left.advance : right.advance;
                        return left.advance + (right.advance - left.advance) * ((time - left.time) / (right.time - left.time));
                    }
                    left = right;
                }
                return time <= left.to + 1 ? left.advance : null;
            }
            function fontBytesValid(buffer) {
                if (!buffer || buffer.byteLength < 1024) return false;
                const b = new Uint8Array(buffer), magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
                return (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || /^(OTTO|ttcf|wOFF|wOF2)$/.test(magic);
            }
            return { fit, advanceAt, fontBytesValid };
        }
        let installing = false;
        let bridge = null;
        let polling = false;
        let syncing = false;
        let commandId = 0;
        let lastSnapshot = "";
        let lastDiagnostic = "";
        let trayTracks = [];
        let trayStatus = "Starting the player helper…";
        let trayTimingStatus = "Waiting for subtitle tracks.";
        let trayFontStatus = "Japanese font support is ready to start.";
        let trayRecoveryStatus = "Native subtitle recovery is ready.";
        const trackRef = ctx.fieldRef("");
        const positionRef = ctx.fieldRef("top");
        const sizeRef = ctx.fieldRef("32");
        const delayRef = ctx.fieldRef("0");
        const autoRef = ctx.fieldRef(true);
        const bottomOffsetRef = ctx.fieldRef("12");
        const timingRef = ctx.fieldRef(true);
        const fontsRef = ctx.fieldRef(true);
        const recoveryRef = ctx.fieldRef(true);
        const tray = ctx.newTray({
            iconUrl: "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/png/128/emoji_u1f4ac.png",
            withContent: true, width: "370px"
        });

        async function sendCommand(operation, value) {
            if (syncing) return;
            if (!bridge) bridge = await ctx.dom.queryOne("script[data-dual-subtitles]");
            if (!bridge) {
                trayStatus = "The player helper is not running. Approve the plugin permissions, then reload it.";
                tray.update(); return;
            }
            bridge.setAttribute("data-dual-subtitles-command", JSON.stringify({ id: ++commandId, operation, value }));
        }
        async function syncTray() {
            if (polling || installing) return;
            polling = true;
            try {
                const current = await ctx.dom.queryOne("script[data-dual-subtitles]");
                if (!current) return;
                bridge = current;
                // queryOne returns a fresh attribute snapshot. Dataset getters expect
                // camelCase keys, NOT a dashed HTML attribute name.
                const raw = current.attributes["data-dual-subtitles-state"];
                if (!raw || raw === lastSnapshot) return;
                const state = JSON.parse(raw);
                lastSnapshot = raw;
                trayTracks = state.tracks || [];
                trayStatus = state.message || "Open an episode in Seanime's built-in player.";
                trayTimingStatus = state.timingStatus || "Waiting for subtitle tracks.";
                trayFontStatus = state.fontStatus || "Waiting for Seanime's subtitle renderer.";
                trayRecoveryStatus = state.nativeRecoveryStatus || "Native subtitle recovery is ready.";
                syncing = true;
                trackRef.setValue(state.selected || "");
                positionRef.setValue(state.settings.position);
                sizeRef.setValue(String(state.settings.size));
                delayRef.setValue(String(state.settings.delay));
                autoRef.setValue(!!state.settings.autoJapanese);
                bottomOffsetRef.setValue(String(state.settings.bottomOffset));
                timingRef.setValue(state.settings.autoTiming !== false);
                fontsRef.setValue(state.settings.japaneseFont !== false);
                recoveryRef.setValue(state.settings.nativeRecovery !== false);
                syncing = false;
                tray.update();
                const diagnostic = JSON.stringify({ version: state.version, tracks: trayTracks.length,
                    readyTracks: trayTracks.filter(track => track.cues > 0).length,
                    manager: !!state.manager, sockets: state.sockets, panelOpen: !!state.panelOpen,
                    position: state.settings.position, bottomOffset: state.settings.bottomOffset,
                    timing: trayTimingStatus, font: trayFontStatus, recovery: state.nativeRecoveryStatus || "",
                    nativeDiagnostic: state.nativeDiagnostic || null });
                if (diagnostic !== lastDiagnostic) {
                    lastDiagnostic = diagnostic;
                    console.log("Dual Subtitles: player state " + diagnostic);
                }
            } catch (error) {
                console.warn("Dual Subtitles: tray sync failed", error);
            } finally { syncing = false; polling = false; }
        }
        trackRef.onValueChange(value => sendCommand("select", value));
        positionRef.onValueChange(value => sendCommand("settings", { position: value }));
        sizeRef.onValueChange(value => sendCommand("settings", { size: value }));
        delayRef.onValueChange(value => sendCommand("settings", { delay: value }));
        autoRef.onValueChange(value => sendCommand("settings", { autoJapanese: value }));
        bottomOffsetRef.onValueChange(value => sendCommand("settings", { bottomOffset: value }));
        timingRef.onValueChange(value => sendCommand("settings", { autoTiming: value }));
        fontsRef.onValueChange(value => sendCommand("settings", { japaneseFont: value }));
        recoveryRef.onValueChange(value => sendCommand("settings", { nativeRecovery: value }));
        ctx.registerEventHandler("diagnose-native-subtitles", () => sendCommand("diagnose-native"));
        tray.render(() => tray.stack({ gap: 3, items: [
            tray.text("Dual Subtitles", { style: { fontWeight: "600", fontSize: "17px" } }),
            tray.text("Keep English selected in Seanime's normal subtitle menu. Choose Japanese here."),
            tray.select("Second subtitle track", { fieldRef: trackRef, options: [
                { label: "Off — one subtitle track", value: "" },
                ...trayTracks.filter(track => !track.unsupported).map(track => ({
                    label: (track.label || track.language || "Subtitle") + " · " + track.source,
                    value: track.id
                }))
            ] }),
            tray.switch("Automatically choose Japanese", { fieldRef: autoRef }),
            tray.select("Position", { fieldRef: positionRef, options: [
                { label: "Top", value: "top" },
                { label: "Above the normal bottom subtitles", value: "bottom" }
            ] }),
            tray.input("Bottom height (%) · 0–50", { fieldRef: bottomOffsetRef }),
            tray.text("With Position set to bottom: lower this number to bring the second track closer to the normal subtitles. Default: 12.",
                { style: { fontSize: "12px", opacity: "0.7" } }),
            tray.input("Text size (16–64)", { fieldRef: sizeRef }),
            tray.input("Second-track delay in seconds (+ shows later)", { fieldRef: delayRef }),
            tray.switch("Automatically match subtitle timing", { fieldRef: timingRef }),
            tray.text("Uses embedded dialogue timing, including changes after intros or cuts. Delay above remains an extra manual adjustment.",
                { style: { fontSize: "12px", opacity: "0.7" } }),
            tray.text(trayTimingStatus, { style: { whiteSpace: "pre-line", fontSize: "12px" } }),
            tray.switch("Recover missing native subtitles", { fieldRef: recoveryRef }),
            tray.text("Restores received embedded cues if Seanime loses them during loading or seeking. Does not change their timing or styling.",
                { style: { fontSize: "12px", opacity: "0.7" } }),
            tray.text(trayRecoveryStatus, { style: { whiteSpace: "pre-line", fontSize: "12px" } }),
            tray.switch("Load Japanese font for native subtitles", { fieldRef: fontsRef }),
            tray.text(trayFontStatus, { style: { whiteSpace: "pre-line", fontSize: "12px" } }),
            tray.text(trayStatus, { style: { whiteSpace: "pre-line", fontSize: "12px", opacity: "0.85" } }),
            tray.button("Refresh track list", { onClick: ctx.eventHandler("dual-subs-refresh", () => {
                lastSnapshot = ""; sendCommand("refresh"); syncTray();
            }) }),
            tray.button("Open controls / local subtitle file in player", {
                onClick: ctx.eventHandler("dual-subs-open-panel", () => sendCommand("open-panel", true))
            }),
            tray.text("If this helper was enabled mid-episode, select English once in Seanime's normal subtitle menu to connect its existing subtitle cache. Add missing Japanese with Subtitle Engine/Jimaku.",
                { style: { fontSize: "12px", opacity: "0.7" } })
        ] }));
        tray.onOpen(syncTray);
        ctx.setInterval(syncTray, 1000);

        function startDualSubtitles(initialInfo, makeTimingTools) {
            const globalKey = "__seanimeDualSubtitles";
            if (window[globalKey]) window[globalKey].dispose();
            const host = document.currentScript;
            if (!host) return;
            const storageKey = "seanime-dual-subtitles-settings-v1";
            function bottomOffset(value) {
                if (value === null || value === undefined || String(value).trim() === "") return 12;
                const number = Number(value);
                return Number.isFinite(number) ? Math.max(0, Math.min(50, number)) : 12;
            }
            const timingTools = makeTimingTools();
            let settings = { autoJapanese: true, size: 32, position: "top", delay: 0, bottomOffset: 12,
                autoTiming: true, japaneseFont: true, nativeRecovery: true };
            try {
                const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
                if (saved) settings = {
                    autoJapanese: saved.autoJapanese !== false,
                    size: Math.max(16, Math.min(64, Number(saved.size) || 32)),
                    position: saved.position === "bottom" ? "bottom" : "top",
                    delay: Math.max(-300, Math.min(300, Number(saved.delay) || 0)),
                    bottomOffset: bottomOffset(saved.bottomOffset),
                    autoTiming: saved.autoTiming !== false,
                    japaneseFont: saved.japaneseFont !== false,
                    nativeRecovery: saved.nativeRecovery !== false
                };
            } catch (_) {}
            let disposed = false;
            let playbackId = "";
            let generation = -1;
            let tracks = [];
            let selected = "";
            let primaryNumber = null;
            let nextFileNumber = 1000;
            let captionMode = false;
            let root = null;
            let video = null;
            let panel = null;
            let overlay = null;
            let select = null;
            let notice = null;
            let lastCaption = "";
            let lastStatus = "";
            let lastStyle = "";
            let lastBridgeState = "";
            let panelOpen = false;
            let userChose = false;
            let serial = 0;
            let subtitleManager = null;
            let readingManager = false;
            const managerCaches = new Map();
            const sockets = new Map();
            const removers = [];
            const requests = new Set();
            let timingStatus = "Waiting for subtitle tracks.";
            let fontStatus = "Waiting for a Japanese track and Seanime's subtitle renderer.";
            let fontData = null, fontRequest = null;
            let fontState = null;
            let nativeTiming = null;
            let lastTimingRun = 0;
            let nativeDiagnostic = null;
            let nativeRecoveryStatus = "Native subtitle recovery is ready.";
            let nativeRecoveryRequest = null, lastNativeCheck = 0, lastNativeChange = 0, nativeEpoch = 0;
            let nativeRecovered = 0;

            function save() {
                try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch (_) {}
            }
            function publishStatus(message) {
                if (notice && notice.textContent !== message) notice.textContent = message;
                if (lastStatus !== message) {
                    lastStatus = message;
                    host.setAttribute("data-dual-subtitles-status", message);
                }
            }
            function snapshot(message) {
                return { version: "1.4.2", playbackId, selected, primaryNumber, message: message || lastStatus,
                    manager: !!subtitleManager, sockets: sockets.size, panelOpen,
                    settings: { ...settings }, timingStatus, fontStatus, nativeDiagnostic, nativeRecoveryStatus,
                    tracks: tracks.map(track => ({ id: track.id, label: track.label, language: track.language,
                        source: track.source, cues: track.cues.length, unsupported: !!track.unsupported,
                        timing: track.timingModel ? { anchors: track.timingModel.anchors, reference: track.timingReference } : null })) };
            }
            function publishState(message) {
                publishStatus(message);
                const value = JSON.stringify(snapshot(message));
                if (lastBridgeState !== value) {
                    lastBridgeState = value;
                    host.setAttribute("data-dual-subtitles-state", value);
                }
            }
            function applyCommand(command) {
                if (disposed || !command) return;
                if (command.operation === "select") {
                    const wanted = String(command.value || "");
                    if (wanted && !tracks.some(track => track.id === wanted && !track.unsupported)) return;
                    selected = wanted; userChose = true; updateOptions();
                } else if (command.operation === "settings") {
                    const value = command.value || {};
                    if ("position" in value) settings.position = value.position === "bottom" ? "bottom" : "top";
                    if ("size" in value) settings.size = Math.max(16, Math.min(64, Number(value.size) || 32));
                    if ("delay" in value) settings.delay = Math.max(-300, Math.min(300, Number(value.delay) || 0));
                    if ("bottomOffset" in value) settings.bottomOffset = bottomOffset(value.bottomOffset);
                    if ("autoTiming" in value) settings.autoTiming = !!value.autoTiming;
                    if ("japaneseFont" in value) settings.japaneseFont = !!value.japaneseFont;
                    if ("nativeRecovery" in value) {
                        settings.nativeRecovery = !!value.nativeRecovery;
                        nativeEpoch++; nativeRecoveryRequest = null;
                    }
                    if ("autoJapanese" in value) { settings.autoJapanese = !!value.autoJapanese; userChose = false; }
                    save(); updateOptions();
                    // Rebuild the player controls so they show settings changed from the tray.
                    if (root) { const currentRoot = root; buildUI(currentRoot); }
                } else if (command.operation === "open-panel") {
                    panelOpen = true; scan();
                    if (panel) panel.style.display = "block";
                    if (!root) publishState("Open an episode in Seanime's built-in player first.");
                    else render();
                } else if (command.operation === "refresh") {
                    tracks.forEach(track => { track.timingKey = ""; });
                    syncManager(); scan(); captureNativeDiagnostics(); render();
                } else if (command.operation === "diagnose-native") {
                    captureNativeDiagnostics();
                }
                updateHelpers(true); render();
            }
            async function captureNativeDiagnostics() {
                const manager = subtitleManager, renderer = manager && manager.libassRenderer;
                const episode = playbackId, time = Number(video && video.currentTime);
                const number = manager && manager.getSelectedTrackNumberOrNull();
                const track = manager && manager.eventTracks && manager.eventTracks[number];
                const summarize = c => ({ start: c.Start, duration: c.Duration, style: c.Style,
                    readOrder: c.ReadOrder, text: String(c.Text || "").slice(0, 90) });
                const near = c => c.Start / 1000 < time + 12 && (c.Start + c.Duration) / 1000 > time - 12;
                const base = { playbackId: episode, time, track: number, label: track && track.info.name,
                    delay: manager && manager.settings && manager.settings.subtitleDelay,
                    rendererOffset: renderer && renderer.timeOffset, translating: !!(manager && manager.shouldTranslate) };
                try {
                    if (!track || !renderer || !renderer.renderer || !renderer.renderer.getEvents) {
                        nativeDiagnostic = { ...base, error: "No embedded main track or renderer is connected." };
                    } else {
                        await renderer.ready;
                        const events = await renderer.renderer.getEvents();
                        const styles = renderer.renderer.getStyles ? await renderer.renderer.getStyles() : [];
                        if (disposed || playbackId !== episode || subtitleManager !== manager) return;
                        const cached = Array.from(track.events.values()).map(c => c.assEvent).filter(Boolean);
                        nativeDiagnostic = { ...base, cached: cached.length, rendered: events.length,
                            expected: cached.filter(near).slice(0, 10).map(summarize),
                            actual: events.filter(near).slice(0, 10).map(summarize),
                            styleMap: track.styles, styles: styles.map(c => ({ name: c.Name, font: c.FontName, size: c.FontSize })) };
                    }
                } catch (error) { nativeDiagnostic = { ...base, error: String(error.message || error) }; }
                if (!disposed && playbackId === episode) render();
            }
            function nativeEventKey(event) {
                return event.startTime + "|" + event.duration + "|" + event.text;
            }
            function rememberNativeEvents(events) {
                (events || []).forEach(event => {
                    const track = tracks.find(t => t.kind === "embedded" && t.number === Number(event.trackNumber));
                    if (!track || track.unsupported || !Number.isFinite(event.startTime) || !Number.isFinite(event.duration) ||
                        event.startTime < 0 || event.duration <= 0 || typeof event.text !== "string") return;
                    if (!track.nativeEvents) track.nativeEvents = new Map();
                    const key = nativeEventKey(event);
                    if (track.nativeEvents.has(key) || track.nativeEvents.size >= 50000) return;
                    track.nativeEvents.set(key, event);
                    const time = Number(video && video.currentTime) * 1000;
                    if (track.number === primaryNumber && event.startTime < time + 15000 &&
                        event.startTime + event.duration > time - 5000) {
                        nativeEpoch++; lastNativeChange = Date.now();
                    }
                });
            }
            async function recoverNativeSubtitles() {
                if (!settings.nativeRecovery) { nativeRecoveryStatus = "Native subtitle recovery is off."; return; }
                const manager = subtitleManager, renderer = manager && manager.libassRenderer;
                const number = manager && manager.getSelectedTrackNumberOrNull();
                const track = manager && manager.eventTracks && manager.eventTracks[number];
                if (!video || video.seeking || !track || manager.shouldTranslate || /PGS|VOBSUB|HDMV|DVB|BITMAP/i.test(track.info.codecID || "") ||
                    !renderer || !renderer.renderer || typeof renderer.renderer.getEvents !== "function" ||
                    typeof renderer.renderer.createEvent !== "function" || typeof manager._recordSubtitleEvent !== "function") return;
                const now = Date.now();
                if (nativeRecoveryRequest || now - lastNativeCheck < 400 || now - lastNativeChange < 350) return;
                lastNativeCheck = now;
                const request = {}; nativeRecoveryRequest = request;
                const episode = playbackId, epoch = nativeEpoch;
                const current = () => !disposed && settings.nativeRecovery && playbackId === episode &&
                    subtitleManager === manager && manager.libassRenderer === renderer &&
                    manager.getSelectedTrackNumberOrNull() === number && !manager.shouldTranslate && !video.seeking &&
                    nativeEpoch === epoch && nativeRecoveryRequest === request;
                try {
                    await renderer.ready;
                    if (!current()) return;
                    const time = (Number(video.currentTime) + (Number(renderer.timeOffset) || 0)) * 1000;
                    const near = event => event.startTime < time + 12000 && event.startTime + event.duration > time - 2000;
                    const observed = tracks.find(t => t.kind === "embedded" && t.number === number);
                    // A discarded seek batch still contains absolute-time text from
                    // this same playback. Recover nearby cues, never another episode.
                    if (observed && observed.nativeEvents) {
                        observed.nativeEvents.forEach(event => {
                            if (!near(event)) return;
                            const result = manager._recordSubtitleEvent(event);
                            // Protect against an upstream cache identifier being reused
                            // for a different absolute-time cue after a seek.
                            const previous = result && result.cachedEntry && result.cachedEntry.event;
                            if (previous && nativeEventKey(previous) !== nativeEventKey(event)) {
                                manager._recordSubtitleEvent({ ...event, extraData: { ...event.extraData,
                                    _id: "dual-recovery:" + nativeEventKey(event) } });
                            }
                        });
                    }
                    const expected = Array.from(track.events.values()).filter(c => c.assEvent && c.event && near(c.event));
                    if (!expected.length) return;
                    const rendered = await renderer.renderer.getEvents();
                    if (!current() || !Array.isArray(rendered)) return;
                    const key = event => event.Start + "|" + event.Duration + "|" + event.Text;
                    const present = new Set(rendered.map(key));
                    let repaired = 0;
                    for (const cached of expected) {
                        if (!current()) return;
                        const event = cached.assEvent;
                        if (present.has(key(event))) continue;
                        // Keep Seanime's own ASS styling, margins, effects and order.
                        await renderer.renderer.createEvent({ ...event });
                        present.add(key(event)); repaired++;
                    }
                    if (repaired && current()) {
                        nativeRecovered += repaired;
                        nativeRecoveryStatus = "Recovered " + nativeRecovered + " missing native subtitle cue(s).";
                        await renderer.resize?.(); // redraw when paused after a seek
                    } else if (!nativeRecovered) nativeRecoveryStatus = "Native subtitle cache checked.";
                } catch (error) {
                    if (current()) {
                        nativeRecoveryStatus = "Native subtitle recovery check failed: " + String(error.message || error);
                        lastNativeCheck = Date.now() + 5000;
                    }
                } finally { if (nativeRecoveryRequest === request) nativeRecoveryRequest = null; }
            }
            function decodeEntities(text) {
                const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
                return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
                    if (entity[0] !== "#") return named[entity.toLowerCase()] || whole;
                    const value = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
                    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
                        ? String.fromCodePoint(value) : whole;
                });
            }
            function plainText(text, ass) {
                text = String(text || "");
                if (ass || /\{\\[^}]*\}/.test(text)) {
                    let drawing = false;
                    let output = "";
                    let from = 0;
                    const tags = ass ? /\{([^}]*)\}/g : /\{(\\[^}]*)\}/g;
                    let tag;
                    while ((tag = tags.exec(text))) {
                        if (!drawing) output += text.slice(from, tag.index);
                        const commands = /\\p(\d+)\b|\\r(?:[^\\]*)/g;
                        let command;
                        while ((command = commands.exec(tag[1]))) drawing = command[1] ? Number(command[1]) > 0 : false;
                        from = tags.lastIndex;
                    }
                    if (!drawing) output += text.slice(from);
                    text = output.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ");
                }
                return decodeEntities(text.replace(/<[^>]*>/g, "")).replace(/\r/g, "").trim();
            }
            function timestamp(text) {
                const parts = String(text || "").trim().replace(",", ".").split(":");
                if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(?:\.\d+)?$/.test(p))) return NaN;
                return parts.reduce((value, part) => value * 60 + Number(part), 0);
            }
            function cue(start, end, text) {
                return Number.isFinite(start) && Number.isFinite(end) && end > start && text ? { start, end, text } : null;
            }
            function parseSubtitles(content, format) {
                content = String(content || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
                const isAss = /^(ass|ssa)$/i.test(format || "") || /^\s*\[Events\]/mi.test(content);
                const cues = [];
                if (isAss) {
                    let inEvents = false;
                    let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
                    content.split("\n").forEach(line => {
                        if (/^\s*\[/.test(line)) { inEvents = /^\s*\[Events\]/i.test(line); return; }
                        if (!inEvents) return;
                        if (/^\s*Format:/i.test(line)) {
                            fields = line.replace(/^\s*Format:\s*/i, "").split(",").map(x => x.trim().toLowerCase());
                            return;
                        }
                        if (!/^\s*Dialogue:/i.test(line)) return;
                        const raw = line.replace(/^\s*Dialogue:\s*/i, "");
                        const values = [];
                        let from = 0;
                        for (let i = 0; i < fields.length - 1; i++) {
                            const comma = raw.indexOf(",", from);
                            if (comma < 0) return;
                            values.push(raw.slice(from, comma)); from = comma + 1;
                        }
                        values.push(raw.slice(from));
                        const result = cue(timestamp(values[fields.indexOf("start")]), timestamp(values[fields.indexOf("end")]),
                            plainText(values[fields.indexOf("text")], true));
                        if (result) cues.push(result);
                    });
                } else {
                    content.split(/\n\s*\n/).forEach(block => {
                        if (/^\s*(NOTE|STYLE|REGION)\b/.test(block)) return;
                        const lines = block.split("\n");
                        const index = lines.findIndex(line => line.includes("-->"));
                        if (index < 0) return;
                        const match = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[index]);
                        if (!match) return;
                        const result = cue(timestamp(match[1]), timestamp(match[2]), plainText(lines.slice(index + 1).join("\n"), false));
                        if (result) cues.push(result);
                    });
                }
                return cues.sort((a, b) => a.start - b.start || a.end - b.end);
            }
            function indexCues(track) {
                track.cues.sort((a, b) => a.start - b.start || a.end - b.end);
                let end = -Infinity;
                track.maxEnds = track.cues.map(c => (end = Math.max(end, c.end)));
            }
            function activeText(track, time) {
                let lo = 0, hi = track.cues.length;
                while (lo < hi) {
                    const mid = (lo + hi) >>> 1;
                    if (track.cues[mid].start <= time) lo = mid + 1; else hi = mid;
                }
                const active = [];
                for (let i = lo - 1; i >= 0 && track.maxEnds[i] > time; i--) {
                    if (track.cues[i].end > time) active.push(track.cues[i].text);
                }
                return [...new Set(active.reverse())].join("\n");
            }
            function japanese(track) {
                return /^(ja|jpn)(-|$)/i.test(track.language || "") || /japanese|日本語|\bJP\b/i.test(track.label || "");
            }
            function releaseNativeTiming() {
                if (nativeTiming && nativeTiming.renderer.timeOffset === nativeTiming.applied) {
                    nativeTiming.renderer.timeOffset = nativeTiming.original;
                }
                nativeTiming = null;
            }
            function applyNativeTiming() {
                const renderer = subtitleManager && subtitleManager.libassRenderer;
                const main = primaryNumber === null ? null : tracks.find(t => t.number === primaryNumber);
                const advance = settings.autoTiming && main && main.kind === "file"
                    ? timingTools.advanceAt(main.timingModel, Number(video && video.currentTime)) : null;
                if (!renderer || advance === null || advance === false || advance === undefined) { releaseNativeTiming(); return; }
                if (nativeTiming && nativeTiming.renderer !== renderer) releaseNativeTiming();
                if (!nativeTiming) nativeTiming = { renderer, original: Number(renderer.timeOffset) || 0, applied: null };
                // Seanime's manual native delay remains untouched in its preferences.
                const baseline = -(Number(subtitleManager.settings && subtitleManager.settings.subtitleDelay) || 0);
                nativeTiming.original = baseline;
                const next = baseline + advance;
                if (nativeTiming.applied !== next || renderer.timeOffset !== next) {
                    renderer.timeOffset = next; nativeTiming.applied = next;
                }
            }
            function nativeDefaultFont(manager) {
                const custom = manager && manager.settings && manager.settings.subtitleCustomization;
                return custom && custom.enabled && custom.fontName ? custom.fontName.split(".")[0] : "roboto medium";
            }
            function releaseNativeFont() {
                const previous = fontState;
                fontState = null;
                if (previous && previous.override && previous.renderer.renderer) {
                    Promise.resolve(previous.renderer.renderer.setDefaultFont(nativeDefaultFont(previous.manager)))
                        .catch(error => console.warn("Dual Subtitles: restoring native font failed", error));
                }
            }
            async function japaneseFontBytes() {
                if (fontData) return fontData;
                if (fontRequest) return fontRequest;
                const episode = playbackId;
                const controller = new AbortController(); requests.add(controller);
                fontRequest = (async () => {
                    const sources = [new URL("/assets/NotoSansJP-Regular.ttf", location.origin).href,
                        "https://raw.githubusercontent.com/google/fonts/295d98a7a0c17c68f1341eaeea354e7960ea70d3/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"];
                    for (const url of sources) {
                        try {
                            const response = await fetch(url, { signal: controller.signal });
                            if (!response.ok) continue;
                            const data = await response.arrayBuffer();
                            // A 200 OK HTML error page is not a font.
                            if (!timingTools.fontBytesValid(data)) continue;
                            if (disposed || episode !== playbackId || controller.signal.aborted) throw new Error("Font request cancelled.");
                            fontData = new Uint8Array(data); return fontData;
                        } catch (error) { if (controller.signal.aborted) throw error; }
                    }
                    throw new Error("No valid Japanese font could be loaded. Install NotoSansJP-Regular.ttf in Seanime's assets folder.");
                })();
                const pending = fontRequest;
                try { return await pending; }
                finally { requests.delete(controller); if (fontRequest === pending) fontRequest = null; }
            }
            async function updateJapaneseFont() {
                const manager = subtitleManager, renderer = manager && manager.libassRenderer;
                if (!settings.japaneseFont) { releaseNativeFont(); fontStatus = "Japanese font support is off."; return; }
                if (!renderer || !renderer.renderer || !tracks.some(japanese)) {
                    fontStatus = "Waiting for a Japanese track and Seanime's subtitle renderer."; return;
                }
                if (fontState && fontState.renderer !== renderer) releaseNativeFont();
                if (!fontState) fontState = { manager, renderer, loaded: false, busy: false, override: false, retryAt: 0 };
                const state = fontState, episode = playbackId;
                if (state.busy || Date.now() < state.retryAt) return;
                state.busy = true;
                try {
                    if (!state.loaded) {
                        fontStatus = "Loading Japanese fallback font…";
                        await renderer.ready;
                        const bytes = await japaneseFontBytes();
                        if (disposed || episode !== playbackId || state !== fontState || !settings.japaneseFont) return;
                        await renderer.renderer.addFonts([bytes]);
                        state.loaded = true;
                    }
                    if (disposed || episode !== playbackId || state !== fontState || !settings.japaneseFont) return;
                    const main = primaryNumber === null ? null : tracks.find(t => t.number === primaryNumber), wanted = !!(main && japanese(main));
                    if (wanted !== state.override) {
                        await renderer.renderer.setDefaultFont(wanted ? "Noto Sans JP" : nativeDefaultFont(manager));
                        state.override = wanted;
                        await renderer.resize?.();
                    }
                    fontStatus = "Japanese fallback font loaded: Noto Sans JP.";
                } catch (error) {
                    if (!disposed && state === fontState) {
                        fontStatus = String(error.message || error); state.retryAt = Date.now() + 30000;
                        console.warn("Dual Subtitles: Japanese font load failed", error);
                    }
                } finally { state.busy = false; if (!disposed && state === fontState) render(); }
            }
            function updateHelpers(force) {
                if (disposed) return;
                updateJapaneseFont();
                if (!settings.autoTiming) { timingStatus = "Automatic timing is off; manual delay only."; releaseNativeTiming(); return; }
                const active = tracks.filter(t => t.kind === "file" && !t.unsupported &&
                    (t.id === selected || (primaryNumber !== null && t.number === primaryNumber)));
                if (!active.length) { timingStatus = "Waiting for an added subtitle track."; return; }
                const references = tracks.filter(t => t.kind === "embedded" && !t.unsupported && t.cues.length >= 8 &&
                    !/signs|songs|forced/i.test(t.label || ""));
                references.sort((a, b) => {
                    const rank = t => /^(en|eng)(-|$)/i.test(t.language || "") ? 0 : t.number === primaryNumber ? 1 : 2;
                    return rank(a) - rank(b) || b.cues.length - a.cues.length;
                });
                const reference = references[0];
                if (!reference) { timingStatus = "Waiting for embedded dialogue cues. No timing guess will be applied without a reference."; return; }
                if (!force && lastTimingRun && Date.now() - lastTimingRun < 1500) return;
                const messages = [];
                active.forEach(track => {
                    if (!track.loaded) { loadTrack(track); return; }
                    const key = reference.id + ":" + reference.cues.length + ":" + reference.cues[0].start + ":" +
                        reference.cues[reference.cues.length - 1].end + ":" + track.cues.length + ":" +
                        (track.cues[0] && track.cues[0].start) + ":" + (track.cues[track.cues.length - 1] && track.cues[track.cues.length - 1].end);
                    if (key !== track.timingKey) {
                        lastTimingRun = Date.now();
                        track.timingKey = key;
                        track.timingModel = timingTools.fit(reference.cues, track.cues);
                        track.timingReference = reference.label || reference.language || "Embedded dialogue";
                    }
                    const model = track.timingModel;
                    const role = track.id === selected && track.number === primaryNumber ? "Main/second track" :
                        track.id === selected ? "Second track" : "Main track";
                    const label = role + " · " + (track.label || track.language || "Subtitle") + ": ";
                    if (!model.anchors.length) { messages.push(label + model.reason); return; }
                    const sections = [];
                    model.anchors.forEach(a => { if (!sections.length || Math.abs(sections[sections.length - 1] - a.advance) > 1) sections.push(a.advance); });
                    const now = timingTools.advanceAt(model, Number(video && video.currentTime));
                    const correction = now === null ? "0.0s applied here (waiting for a reliable match)" :
                        Math.abs(now) < 0.05 ? "0.0s applied (already aligned)" :
                            (-now).toFixed(1) + "s applied (" + Math.abs(now).toFixed(1) + "s " + (now > 0 ? "earlier" : "later") + ")";
                    messages.push(label + "Auto timing: " + correction +
                        "; " + sections.length + " section(s), reference: " + track.timingReference + ".");
                });
                timingStatus = [...new Set(messages)].join("\n") || "Waiting for readable added subtitles.";
            }
            function trackName(track) {
                return (track.label || track.language || "Subtitle") + " · " + track.source;
            }
            function chooseAutomatic() {
                const current = tracks.find(track => track.id === selected);
                if (!userChose && settings.autoJapanese && (!current || !current.cues.length)) {
                    const match = tracks.find(track => !track.unsupported && japanese(track) && track.cues.length) ||
                        tracks.find(track => !track.unsupported && japanese(track));
                    if (match) selected = match.id;
                }
            }
            function updateOptions() {
                chooseAutomatic();
                if (!select) { render(); return; }
                select.replaceChildren();
                const off = document.createElement("option");
                off.value = ""; off.textContent = "Off — one subtitle track"; select.appendChild(off);
                tracks.forEach(track => {
                    const option = document.createElement("option");
                    option.value = track.id;
                    option.textContent = trackName(track) + (track.unsupported ? " (image subtitles unsupported)" : "");
                    option.disabled = !!track.unsupported;
                    select.appendChild(option);
                });
                select.value = selected;
                render();
            }
            function reset(info) {
                releaseNativeTiming(); releaseNativeFont();
                requests.forEach(controller => controller.abort()); requests.clear();
                fontRequest = null;
                playbackId = info ? String(info.id || "") : "";
                generation = -1; tracks = []; selected = ""; primaryNumber = null; userChose = false;
                subtitleManager = null;
                managerCaches.clear();
                timingStatus = "Waiting for subtitle tracks.";
                lastTimingRun = 0;
                nativeDiagnostic = null;
                nativeEpoch++; nativeRecoveryRequest = null;
                lastNativeCheck = 0; lastNativeChange = Date.now(); nativeRecovered = 0;
                nativeRecoveryStatus = "Native subtitle recovery is ready.";
                fontStatus = "Waiting for a Japanese track and Seanime's subtitle renderer.";
                nextFileNumber = 1000;
                captionMode = !!(info && (info.subtitleTracks || []).some(track => !track.useLibassRenderer));
                const embedded = info && info.mkvMetadata && info.mkvMetadata.subtitleTracks || [];
                embedded.forEach(track => {
                    const unsupported = /PGS|VOBSUB|HDMV|DVB|BITMAP/i.test(track.codecID || "");
                    tracks.push({ id: "embedded-" + track.number, number: Number(track.number),
                        label: track.name || track.languageIETF || track.language,
                        language: track.languageIETF || track.language || "", source: "Embedded",
                        codec: track.codecID || "", kind: "embedded", unsupported,
                        cues: [], maxEnds: [], keys: new Set(), loaded: true });
                });
                (info && info.subtitleTracks || []).forEach((track, index) => {
                    if (captionMode && track.useLibassRenderer) return;
                    const number = captionMode ? index : nextFileNumber++;
                    addFile(track, number, "Included file");
                });
                if (overlay) overlay.textContent = "";
                lastCaption = "";
                updateOptions();
            }
            function addFile(info, number, source) {
                const id = "file-" + (++serial);
                const track = { id, number, label: info.label || info.name || "External subtitle",
                    language: info.language || "", source: source || "Subtitle Engine / added file",
                    kind: "file", format: info.type || info.format || "", uri: info.src || info.uri || info.sourceUrl || "",
                    content: info.content || "", cues: [], maxEnds: [], loaded: false, loading: false, error: "" };
                tracks.push(track);
                if (track.content) {
                    track.cues = parseSubtitles(track.content, track.format); indexCues(track); track.loaded = true;
                    if (!track.cues.length) track.error = "No readable text cues in this file.";
                }
                updateOptions();
                return track;
            }
            async function loadTrack(track) {
                if (track.loaded || track.loading || track.kind === "embedded") return;
                track.loading = true;
                const controller = new AbortController(); requests.add(controller);
                const episode = playbackId;
                try {
                    if (!track.uri) throw new Error("No subtitle content or file URL is available. Add it again with Subtitle Engine.");
                    const uri = track.uri.replace("{{SERVER_URL}}", location.origin);
                    const url = new URL(uri, location.href);
                    if (!/^(https?:|blob:)$/.test(url.protocol)) throw new Error("Unsupported subtitle URL.");
                    const response = await fetch(url.href, { signal: controller.signal });
                    if (!response.ok) throw new Error("Subtitle download failed (" + response.status + ").");
                    const content = await response.text();
                    if (disposed || playbackId !== episode || !tracks.includes(track)) return;
                    track.cues = parseSubtitles(content, track.format); indexCues(track); track.loaded = true;
                    if (!track.cues.length) track.error = "No readable text cues in this file.";
                } catch (error) {
                    if (!controller.signal.aborted && !disposed && tracks.includes(track)) track.error = String(error.message || error);
                } finally {
                    track.loading = false; requests.delete(controller);
                    if (!disposed) render();
                }
            }
            function receiveBatch(batch) {
                if (!batch || (batch.playbackId && batch.playbackId !== playbackId)) return;
                const events = Array.isArray(batch) ? batch : batch.events || [];
                // Legacy untagged packets may be displayed by the existing adapter,
                // but are not safe to re-inject into a different native playback.
                if (batch.playbackId === playbackId && playbackId) rememberNativeEvents(events);
                const gen = Number(batch.generationId);
                if (Number.isFinite(gen) && gen < generation) return;
                if (Number.isFinite(gen)) generation = gen;
                const changed = new Set();
                events.forEach(event => {
                    const track = tracks.find(t => t.kind === "embedded" && t.number === Number(event.trackNumber));
                    if (!track || track.unsupported || track.cues.length >= 50000) return;
                    const result = cue(Number(event.startTime) / 1000, (Number(event.startTime) + Number(event.duration)) / 1000,
                        plainText(event.text, /ASS|SSA/i.test(event.codecID || track.codec)));
                    if (!result) return;
                    const key = result.start + "|" + result.end + "|" + result.text;
                    if (track.keys.has(key)) return;
                    track.keys.add(key); track.cues.push(result); changed.add(track);
                });
                changed.forEach(indexCues);
                updateHelpers();
                render();
            }
            function syncManager(candidate) {
                if (disposed || readingManager) return;
                const manager = candidate || subtitleManager;
                if (!manager || typeof manager.getTracks !== "function" ||
                    typeof manager.getFileTrack !== "function" ||
                    typeof manager.getSelectedTrackNumberOrNull !== "function" ||
                    typeof manager.onSubtitleEvents !== "function") return;
                if (video && manager.videoElement && manager.videoElement !== video) return;
                readingManager = true;
                try {
                    const info = manager.playbackInfo;
                    if (!info || !info.id) return;
                    if (String(info.id) !== playbackId) {
                        // A delayed selection event from the previous episode must not
                        // roll back a newer watch/video-loaded event on the same video.
                        if (playbackId || !candidate) return;
                        reset(info);
                    }
                    subtitleManager = manager;
                    const main = manager.getSelectedTrackNumberOrNull();
                    if (primaryNumber !== main) { nativeEpoch++; lastNativeChange = Date.now(); }
                    primaryNumber = main;
                    const known = manager.getTracks() || [];
                    known.forEach(native => {
                        const kind = native.type === "event" ? "embedded" : "file";
                        const number = Number(native.number);
                        let track = tracks.find(t => t.kind === kind && t.number === number);
                        if (!track && kind === "embedded") {
                            track = { id: "embedded-" + number, number, kind, source: "Embedded",
                                codec: native.codecID || "", unsupported: /PGS|VOBSUB|HDMV|DVB|BITMAP/i.test(native.codecID || ""),
                                cues: [], maxEnds: [], keys: new Set(), loaded: true };
                            tracks.push(track);
                        }
                        if (kind === "file") {
                            const file = manager.getFileTrack(number);
                            if (!file) return;
                            // Converted content is already loaded by Seanime. No need to
                            // refetch it, change its native selection, or re-add the file.
                            const content = file.content || file.info.content || "";
                            if (!track) track = addFile({ ...file.info, content,
                                format: file.content ? "ass" : file.info.type || file.info.format }, number);
                            else if (content && track.cacheContent !== content) {
                                track.content = content;
                                track.format = file.content ? "ass" : file.info.type || file.info.format;
                                track.cues = parseSubtitles(content, track.format); indexCues(track);
                                track.loaded = true; track.error = track.cues.length ? "" : "No readable text cues in this file.";
                            }
                            track.cacheContent = content;
                            nextFileNumber = Math.max(nextFileNumber, number + 1);
                        }
                        if (track) {
                            track.label = native.label || track.label || native.languageIETF || native.language;
                            track.language = native.languageIETF || native.language || track.language || "";
                        }
                    });
                    // Event tracks retain the original millisecond-timed cues for all
                    // languages, not just the native selected track (Seanime 3.10.3).
                    const events = [];
                    Object.values(manager.eventTracks || {}).forEach(track => {
                        if (track.events && typeof track.events.values === "function") {
                            const previous = managerCaches.get(track.info.number);
                            if (previous && previous.map === track.events && previous.size === track.events.size) return;
                            managerCaches.set(track.info.number, { map: track.events, size: track.events.size });
                            for (const cached of track.events.values()) if (cached.event) events.push(cached.event);
                        }
                    });
                    if (events.length) receiveBatch({ playbackId, events });
                    updateOptions();
                    updateHelpers();
                } catch (error) {
                    console.warn("Dual Subtitles: subtitle cache read failed", error);
                } finally { readingManager = false; }
            }
            // The manager is an EventTarget. Discover it through its normal events,
            // preserving dispatch's arguments, return value, and native listeners.
            // This allows activation midway through a video to recover cached data.
            const originalDispatch = EventTarget.prototype.dispatchEvent;
            function observedDispatch(event) {
                const result = originalDispatch.apply(this, arguments);
                if (!disposed && event && /^(trackselected|trackdeselected|trackadded|tracksloaded|settingsupdated)$/.test(event.type)) {
                    nativeEpoch++; lastNativeChange = Date.now();
                    if (event.type === "settingsupdated" && fontState && fontState.manager === this) {
                        // Native customization resets the fallback font; reapply only
                        // after the user's own style update has finished.
                        fontState.override = false;
                    }
                    syncManager(this);
                }
                return result;
            }
            EventTarget.prototype.dispatchEvent = observedDispatch;
            function receive(packet, outgoing) {
                if (!packet || !packet.payload) return;
                const event = packet.payload;
                if (packet.type === "native-player" && !outgoing) {
                    if (event.type === "watch") reset(event.payload);
                    else if (event.type === "subtitle-event") receiveBatch(event.payload);
                    else if (event.type === "shutdown") reset(null);
                } else if (packet.type === "videocore") {
                    if (!outgoing && event.type === "add-external-subtitle-track" && root) {
                        const number = captionMode ? tracks.filter(t => t.kind === "file").length - 1 : nextFileNumber++;
                        addFile(event.payload || {}, number);
                    } else if (outgoing && (event.type === "video-loaded" || event.type === "video-playback-state")) {
                        const state = event.payload && event.payload.state;
                        const info = state && state.playbackInfo;
                        if (info && String(info.id || "") !== playbackId) reset(info);
                    } else if (outgoing && event.type === "video-terminated") reset(null);
                    else if (outgoing && event.type === "video-subtitle-track") {
                        const number = Number(event.payload && event.payload.trackNumber);
                        if (number !== primaryNumber) { nativeEpoch++; lastNativeChange = Date.now(); }
                        primaryNumber = number; render();
                    } else if (outgoing && event.type === "video-media-caption-track") {
                        primaryNumber = Number(event.payload && event.payload.trackIndex); render();
                    }
                }
            }
            function parsePacket(data, outgoing) {
                if (typeof data !== "string" || !/"(?:native-player|videocore)"/.test(data)) return;
                try { receive(JSON.parse(data), outgoing); } catch (error) {
                    console.warn("Dual Subtitles: could not read subtitle event", error);
                }
            }
            function attachSocket(socket) {
                if (sockets.has(socket)) return;
                try { if (new URL(socket.url).pathname !== "/events") return; } catch (_) { return; }
                const listener = event => { if (!disposed) parsePacket(event.data, false); };
                socket.addEventListener("message", listener);
                sockets.set(socket, listener);
            }
            // Observe the existing Seanime connection, without opening another connection,
            // sending commands, changing messages, or intercepting any unrelated socket.
            // The plugin API's getTextTracks is a no-op in Seanime 3.10.3; this also makes
            // newly added Subtitle Engine tracks available without changing that plugin.
            const originalSend = WebSocket.prototype.send;
            function observedSend(data) {
                if (!disposed) {
                    try {
                        attachSocket(this);
                        if (sockets.has(this)) parsePacket(data, true);
                    } catch (_) {}
                }
                return originalSend.apply(this, arguments);
            }
            WebSocket.prototype.send = observedSend;

            function element(tag, text, css) {
                const item = document.createElement(tag);
                if (text) item.textContent = text;
                if (css) item.style.cssText = css;
                return item;
            }
            function field(label, control) {
                const wrapper = element("label", label, "display:grid;gap:5px;margin-top:10px;font-size:13px");
                wrapper.appendChild(control); panel.appendChild(wrapper);
            }
            function listen(target, type, handler) {
                target.addEventListener(type, handler);
                removers.push(() => target.removeEventListener(type, handler));
            }
            function teardownUI() {
                removers.splice(0).forEach(remove => remove());
                [overlay, panel].forEach(item => { if (item) item.remove(); });
                overlay = panel = select = notice = null;
                lastCaption = ""; lastStyle = ""; root = video = null;
            }
            function buildUI(newRoot) {
                teardownUI(); root = newRoot;
                panel = element("div", "", "position:absolute;right:18px;top:24px;z-index:10000;pointer-events:auto;cursor:auto;width:340px;max-width:calc(100% - 36px);max-height:calc(100% - 48px);overflow:auto;padding:14px;border:1px solid #ffffff44;border-radius:10px;background:#12121cf5;color:white;font:13px/1.5 system-ui;box-shadow:0 6px 24px #0008");
                panel.setAttribute("data-dual-subtitles-panel", "");
                panel.style.display = panelOpen ? "block" : "none";
                panel.appendChild(element("strong", "Dual Subtitles"));
                const close = element("button", "Close", "float:right;padding:3px 9px;border:1px solid #ffffff44;border-radius:5px;background:#242433;color:white;cursor:pointer");
                close.type = "button"; close.setAttribute("data-dual-subtitles-close", "");
                panel.appendChild(close);
                function closePanel() { panelOpen = false; panel.style.display = "none"; render(); }
                listen(close, "click", closePanel);
                panel.appendChild(element("div", "Keep English selected in Seanime's normal subtitle menu. Choose Japanese here.", "margin-top:7px;color:#ddd"));
                select = element("select", "", "width:100%;padding:7px;background:#242433;color:white;border:1px solid #ffffff44;border-radius:5px");
                select.setAttribute("data-dual-subtitles-select", ""); field("Second subtitle track", select);
                listen(select, "change", () => { selected = select.value; userChose = true; render(); });
                const auto = element("input"); auto.type = "checkbox"; auto.checked = settings.autoJapanese;
                field("Automatically choose an available Japanese track", auto);
                listen(auto, "change", () => { settings.autoJapanese = auto.checked; save(); userChose = false; updateOptions(); });
                const position = element("select", "", select.style.cssText);
                [["top", "Top"], ["bottom", "Above the normal bottom subtitles"]].forEach(pair => {
                    const option = element("option", pair[1]); option.value = pair[0]; position.appendChild(option);
                });
                position.value = settings.position; field("Position", position);
                listen(position, "change", () => { settings.position = position.value; save(); render(); });
                const height = element("input", "", select.style.cssText); height.type = "number";
                height.min = "0"; height.max = "50"; height.step = "0.5"; height.value = String(settings.bottomOffset);
                height.setAttribute("data-dual-subtitles-bottom-offset", ""); field("Bottom height (%) · lower brings subtitles closer", height);
                panel.appendChild(element("div", "Applies to bottom position only. Default: 12; raise it if the tracks overlap.", "margin-top:5px;font-size:11px;color:#aaa"));
                listen(height, "change", () => {
                    settings.bottomOffset = bottomOffset(height.value); height.value = String(settings.bottomOffset); save(); render();
                });
                const size = element("input", "", select.style.cssText); size.type = "number";
                size.min = "16"; size.max = "64"; size.step = "2"; size.value = String(settings.size); field("Text size (scaled to player width)", size);
                listen(size, "change", () => { settings.size = Math.max(16, Math.min(64, Number(size.value) || 32)); save(); render(); });
                const delay = element("input", "", select.style.cssText); delay.type = "number";
                delay.min = "-300"; delay.max = "300"; delay.step = "0.1"; delay.value = String(settings.delay);
                field("Second-track delay in seconds (+ shows later)", delay);
                listen(delay, "change", () => { settings.delay = Math.max(-300, Math.min(300, Number(delay.value) || 0)); save(); render(); });
                const timing = element("input"); timing.type = "checkbox"; timing.checked = settings.autoTiming;
                field("Automatically match subtitle timing", timing);
                listen(timing, "change", () => { settings.autoTiming = timing.checked; save(); updateHelpers(); render(); });
                const fonts = element("input"); fonts.type = "checkbox"; fonts.checked = settings.japaneseFont;
                field("Load Japanese font for native subtitles", fonts);
                listen(fonts, "change", () => { settings.japaneseFont = fonts.checked; save(); updateHelpers(); render(); });
                const file = element("input"); file.type = "file"; file.accept = ".ass,.ssa,.srt,.vtt"; field("Or open a second subtitle file", file);
                listen(file, "change", async () => {
                    const chosen = file.files && file.files[0]; if (!chosen) return;
                    const episode = playbackId;
                    try {
                        if (chosen.size > 16 * 1024 * 1024) throw new Error("Subtitle file is larger than 16 MB.");
                        const content = await chosen.text();
                        if (disposed || episode !== playbackId) return;
                        const track = addFile({ label: chosen.name, content, format: chosen.name.split(".").pop() }, null, "Opened file");
                        selected = track.id; userChose = true; updateOptions();
                    } catch (error) { publishStatus(String(error.message || error)); }
                });
                notice = element("div", "", "margin-top:12px;color:#c5c5df;white-space:pre-line");
                notice.setAttribute("role", "status"); panel.appendChild(notice);
                panel.appendChild(element("div", "Second-track ASS styling and drawings are removed for clear reading. It stays in sync when you pause, seek, or change speed.", "margin-top:9px;font-size:11px;color:#aaa"));
                overlay = element("div", "", "position:absolute;left:5%;right:5%;z-index:70;pointer-events:none;white-space:pre-line;text-align:center;font-family:'Yu Gothic','Meiryo','Noto Sans JP',sans-serif;font-weight:600;line-height:1.4;color:white;text-shadow:-2px -2px 1px #000,2px -2px 1px #000,-2px 2px 1px #000,2px 2px 1px #000,0 3px 5px #000;overflow:hidden;max-height:45%;display:none");
                overlay.setAttribute("data-dual-subtitles-overlay", "");
                listen(panel, "click", event => event.stopPropagation());
                listen(panel, "pointerdown", event => event.stopPropagation());
                listen(panel, "keydown", event => {
                    event.stopPropagation();
                    if (event.key === "Escape") closePanel();
                });
                root.appendChild(overlay); root.appendChild(panel);
                updateOptions();
            }
            function scan() {
                if (disposed) return;
                if (!host.isConnected) { dispose(); return; }
                const roots = document.querySelectorAll('[data-vc-element="container"]');
                const found = [...roots].reverse().find(item => item.getClientRects().length);
                if (!found) { if (root) teardownUI(); return; }
                if (found !== root) buildUI(found);
                video = root.querySelector('video[data-video-core-element]');
            }
            function render() {
                if (disposed) return;
                applyNativeTiming();
                recoverNativeSubtitles();
                if (!overlay || !root) {
                    publishState("Open an episode in Seanime's built-in player to display both tracks.");
                    return;
                }
                video = root.querySelector('video[data-video-core-element]');
                const track = tracks.find(item => item.id === selected);
                let text = "";
                let message = "Second subtitles are off. Choose a track or add Japanese with Subtitle Engine.";
                if (track) {
                    if (track.unsupported) message = "This image-based subtitle track cannot be shown as learning text.";
                    else if (track.number !== null && track.number === primaryNumber) {
                        message = "This is also the main track. Select English in Seanime's normal subtitle menu to show both.";
                    } else if (track.error) message = track.error;
                    else if (!video) message = "Waiting for the video player…";
                    else if (!track.loaded) { message = "Loading the second subtitle track…"; loadTrack(track); }
                    else {
                        const advance = settings.autoTiming ? timingTools.advanceAt(track.timingModel, Number(video.currentTime)) : null;
                        text = activeText(track, Number(video.currentTime) - settings.delay + (advance === null ? 0 : advance));
                        message = trackName(track) + " · " + track.cues.length + " cues";
                        if (track.kind === "embedded" && !track.cues.length) message += subtitleManager
                            ? "\nNo cached text yet. Seek once or reopen the episode to request subtitle data."
                            : "\nSelect English once in Seanime's normal subtitle menu to connect its existing subtitle cache.";
                    }
                } else if (!tracks.length) message = "No tracks received yet. Add Japanese with Subtitle Engine, open a subtitle file here, or start an episode containing both languages.";
                const fontSize = Math.max(14, Math.min(72, settings.size * (root.clientWidth || 1280) / 1280)) + "px";
                const styleKey = settings.position + ":" + fontSize + ":" + settings.bottomOffset;
                if (styleKey !== lastStyle) {
                    lastStyle = styleKey;
                    overlay.style.top = settings.position === "top" ? "10%" : "auto";
                    overlay.style.bottom = settings.position === "bottom" ? settings.bottomOffset + "%" : "auto";
                    overlay.style.fontSize = fontSize;
                }
                if (text !== lastCaption) { overlay.textContent = text; lastCaption = text; }
                const display = text ? "block" : "none";
                if (overlay.style.display !== display) overlay.style.display = display;
                publishState(message + "\n" + timingStatus + "\n" + fontStatus);
            }
            function dispose() {
                if (disposed) return;
                disposed = true;
                releaseNativeTiming(); releaseNativeFont();
                clearInterval(renderTimer); clearInterval(scanTimer); observer.disconnect(); commandObserver.disconnect();
                requests.forEach(controller => controller.abort()); requests.clear();
                sockets.forEach((listener, socket) => socket.removeEventListener("message", listener)); sockets.clear();
                if (WebSocket.prototype.send === observedSend) WebSocket.prototype.send = originalSend;
                if (EventTarget.prototype.dispatchEvent === observedDispatch) EventTarget.prototype.dispatchEvent = originalDispatch;
                subtitleManager = null;
                teardownUI(); tracks = [];
                if (window[globalKey] && window[globalKey].dispose === dispose) delete window[globalKey];
            }
            const observer = new MutationObserver(scan);
            const commandObserver = new MutationObserver(() => {
                try { applyCommand(JSON.parse(host.getAttribute("data-dual-subtitles-command") || "null")); }
                catch (error) { console.warn("Dual Subtitles: tray command failed", error); }
            });
            commandObserver.observe(host, { attributes: true, attributeFilter: ["data-dual-subtitles-command"] });
            const renderTimer = setInterval(render, 80);
            const scanTimer = setInterval(() => { scan(); syncManager(); updateHelpers(); }, 1200);
            observer.observe(document.body, { childList: true, subtree: true });
            window[globalKey] = { version: "1.4.2", dispose, getState: () => snapshot() };
            reset(initialInfo || null); scan(); render();
        }

        async function install() {
            if (installing) return;
            installing = true;
            try {
                const body = await ctx.dom.queryOne("body"); if (!body) return;
                const previous = await ctx.dom.queryOne("script[data-dual-subtitles]"); if (previous) previous.remove();
                if (!ctx.videoCore) throw new Error("Seanime has not exposed the player API. Approve the playback permission for Dual Subtitles.");
                const info = ctx.videoCore.getCurrentPlaybackInfo();
                const script = await ctx.dom.createElement("script");
                script.setAttribute("data-dual-subtitles", "1.4.2");
                bridge = script;
                script.setText("(" + startDualSubtitles.toString() + ")(" + JSON.stringify(info || null) + ",(" + createSubtitleTimingTools.toString() + "));");
                body.append(script);
                console.log("Dual Subtitles: page helper installed.");
                // Seanime 3.10.3's sendGet* methods are no-ops. The normal periodic
                // video-status message attaches our passive connection listener.
            } catch (error) {
                console.warn("Dual Subtitles: could not start", error);
                trayStatus = String(error.message || error); tray.update();
                ctx.toast.error("Dual Subtitles could not start. Check its playback and UI-script permissions.");
            } finally { installing = false; }
        }
        ctx.dom.onReady(install);
        ctx.dom.onMainTabReady(install);
    });
}
