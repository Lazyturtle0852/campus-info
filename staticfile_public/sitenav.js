// キャンパス人数（/ と /archive/day/:date）とバス混雑予報（/bus と /bus/:date）で共通のヘッダー。
// 「人数 ⇄ バス」の切り替えと日付の移動を1か所にまとめ、切り替えても同じ日付のまま見られるようにする。
// <div id="siteNav"></div> の直後で読み込むと、URL から表示中のモードと日付を読み取って描く。
(function () {
    const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

    const css = `
        .site-head { max-width: 1120px; margin: 0 auto; padding: 20px 24px 0; }
        .site-head .row1 { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
        .site-head h1 { margin: 0; font-size: 1.5em; }
        .site-head h1 a { color: inherit; text-decoration: none; }
        .site-head .meta { color: var(--muted); font-size: 0.85em; }
        .site-head .row2 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 20px; margin-top: 14px; }
        .seg {
            --seg: #1e3a6e;
            position: relative;
            display: inline-grid;
            grid-template-columns: 1fr 1fr;
            padding: 4px;
            border: 1.5px solid var(--seg);
            border-radius: 999px;
            background-color: var(--card);
        }
        .seg::before {
            content: "";
            position: absolute;
            top: 4px; bottom: 4px; left: 4px;
            width: calc(50% - 4px);
            border-radius: 999px;
            background-color: var(--seg);
            transition: transform 0.2s ease;
        }
        .seg.bus::before, .seg.right::before { transform: translateX(100%); }
        .seg a, .seg button {
            position: relative;
            padding: 6px 22px;
            border-radius: 999px;
            color: var(--seg);
            font-weight: bold;
            text-align: center;
            text-decoration: none;
            white-space: nowrap;
            transition: color 0.2s ease;
        }
        .seg button { border: none; background: none; font: inherit; font-weight: bold; cursor: pointer; }
        .seg a[aria-current="page"], .seg button[aria-pressed="true"] { color: #ffffff; }
        .site-links { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 0.88em; }
        .datebar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; }
        .datebar .mid { display: flex; align-items: center; gap: 8px; }
        .datebar .pick {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 4px 14px;
            border: 1px solid var(--line-strong);
            border-radius: 8px;
            background-color: var(--card);
            font-size: 1.25em;
            font-weight: bold;
            cursor: pointer;
            font-variant-numeric: tabular-nums;
        }
        .datebar .pick:hover { background-color: var(--softer); }
        .datebar .pick svg { width: 18px; height: 18px; color: var(--muted); }
        .datebar .pick input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
        .datebar .today-tag { color: var(--now); font-size: 0.85em; font-weight: bold; }
        .datebar .nav {
            display: inline-block;
            padding: 6px 12px;
            border: 1px solid var(--line-strong);
            border-radius: 8px;
            background-color: var(--card);
            color: var(--text);
            text-decoration: none;
            font-size: 0.88em;
            white-space: nowrap;
        }
        .datebar .nav:hover { background-color: var(--softer); }
        @media (max-width: 560px) {
            .site-head { padding-left: 16px; padding-right: 16px; }
            .site-head h1 { font-size: 1.25em; }
            .seg { width: 100%; }
            .seg a, .seg button { padding: 6px 8px; }
            .datebar .pick { font-size: 1.05em; padding: 4px 10px; }
            .datebar .nav { padding: 6px 8px; }
            .datebar .nav .full { display: none; }
        }
    `;

    function parseDate(s) { const p = s.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
    function addDays(s, n) { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
    function label(s) { const d = parseDate(s); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "(" + DOW_JA[d.getUTCDay()] + ")"; }
    function tokyoToday() { return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()); }

    const today = tokyoToday();
    const path = location.pathname;
    const busMatch = path.match(/^\/bus(?:\/(\d{4}-\d{2}-\d{2}))?\/?$/);
    const dayMatch = path.match(/^\/archive\/day\/(\d{4}-\d{2}-\d{2})\/?$/);
    const mode = busMatch ? "bus" : "campus";
    const date = (busMatch && busMatch[1]) || (dayMatch && dayMatch[1]) || today;

    // 今日はそれぞれのトップ（いまの人数・自動更新つき）、それ以外は日別ページへ
    function urlFor(m, d) {
        if (m === "bus") return d === today ? "/bus" : "/bus/" + d;
        return d === today ? "/" : "/archive/day/" + d;
    }

    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const prev = addDays(date, -1), next = addDays(date, 1);
    const calIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
    const host = document.getElementById("siteNav");
    host.outerHTML =
        '<header class="site-head">' +
            '<div class="row1">' +
                '<h1><a href="' + urlFor(mode, today) + '">SFCキャンパス予報</a></h1>' +
                '<div class="meta" id="updated"></div>' +
            "</div>" +
            '<div class="row2">' +
                '<nav class="seg ' + mode + '" aria-label="表示の切り替え">' +
                    '<a href="' + urlFor("campus", date) + '"' + (mode === "campus" ? ' aria-current="page"' : "") + ">キャンパス人数</a>" +
                    '<a href="' + urlFor("bus", date) + '"' + (mode === "bus" ? ' aria-current="page"' : "") + ">バス混雑予報</a>" +
                "</nav>" +
                '<div class="site-links"><a href="/about">しくみの説明 →</a><a href="/records">予報の実績表 →</a></div>' +
            "</div>" +
            '<div class="datebar">' +
                '<a class="nav" href="' + urlFor(mode, prev) + '">← <span class="full">' + label(prev) + "</span></a>" +
                '<div class="mid">' +
                    '<label class="pick" title="日付を選ぶ">' + calIcon + "<span>" + label(date) + "</span>" +
                        '<input type="date" id="sitePick" value="' + date + '" aria-label="日付を選ぶ"></label>' +
                    (date === today ? '<span class="today-tag">今日</span>' : '<a class="nav" href="' + urlFor(mode, today) + '">今日</a>') +
                "</div>" +
                '<a class="nav" href="' + urlFor(mode, next) + '"><span class="full">' + label(next) + "</span> →</a>" +
            "</div>" +
        "</header>";

    const pick = document.getElementById("sitePick");
    pick.addEventListener("click", function () {
        try { pick.showPicker(); } catch (e) { /* showPicker が無いブラウザは標準の動きに任せる */ }
    });
    pick.addEventListener("change", function () {
        if (/^\d{4}-\d{2}-\d{2}$/.test(pick.value) && pick.value !== date) location.href = urlFor(mode, pick.value);
    });
})();
