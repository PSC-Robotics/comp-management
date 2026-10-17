import { type FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { escapeHtml } from '../lib/html.js';

/**
 * Display picker for unattended screens (the Raspberry Pi kiosk image opens it when no display is
 * pinned). It lists the enabled displays of published competitions; the choice is remembered in
 * the browser, and on later visits it opens again after a short countdown that a key press or
 * click interrupts, so a screen can be repointed with just a keyboard or mouse.
 */
export function registerKioskRoutes(app: FastifyInstance): void {
  app.get('/kiosk', async (_request, reply) => {
    const { rows } = await pool.query<{ slug: string; title: string; display_type: string; competition_name: string }>(
      `SELECT d.slug, d.title, d.display_type, c.name AS competition_name
       FROM public_displays d JOIN competitions c ON c.id = d.competition_id
       WHERE d.enabled = true AND c.status IN ('published', 'live', 'complete')
       ORDER BY c.status = 'live' DESC, c.name, d.title`
    );
    const groups = new Map<string, typeof rows>();
    for (const row of rows) groups.set(row.competition_name, [...(groups.get(row.competition_name) ?? []), row]);
    const list = rows.length
      ? [...groups].map(([competition, displays]) => `<h2>${escapeHtml(competition)}</h2><ul>${displays.map((display) =>
        `<li><a href="/display/${encodeURIComponent(display.slug)}" data-slug="${escapeHtml(display.slug)}">${escapeHtml(display.title)}<small>${escapeHtml(display.display_type)}</small></a></li>`).join('')}</ul>`).join('')
      : '<p>No displays are available yet. Enable a display on a published competition; this page checks again every 30 seconds.</p>';
    reply.header('cache-control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose a display</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:3vw 5vw;font:clamp(16px,2.2vw,28px)/1.4 system-ui,sans-serif;background:#111;color:#eee}
h1{font-size:1.6em;margin:0 0 .3em}h2{font-size:1em;margin:1.2em 0 .4em;opacity:.7}ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(14em,1fr));gap:.5em}
a{display:block;padding:.6em .8em;border:2px solid #444;border-radius:.4em;color:inherit;text-decoration:none;background:#1c1c1c}
a:focus,a:hover{outline:none;border-color:#4da3ff;background:#18324d}small{display:block;opacity:.6;font-size:.7em}
#resume{padding:1em;border:2px solid #4da3ff;border-radius:.4em;margin-bottom:1em}#resume[hidden]{display:none}
</style></head><body>
<div id="resume" hidden>Opening <strong id="resume-title"></strong> in <span id="resume-seconds">10</span> s. Press any key or click to choose a different display.</div>
<h1>Choose a display</h1><p style="opacity:.7">Arrow keys or Tab to move, Enter to open.</p>${list}
<script>
(function () {
  var KEY = 'kiosk-display';
  var links = Array.prototype.slice.call(document.querySelectorAll('a[data-slug]'));
  function remember(slug) {
    try { localStorage.setItem(KEY, slug); } catch (e) {}
    document.cookie = KEY + '=' + encodeURIComponent(slug) + ';path=/;max-age=31536000;samesite=lax';
  }
  function remembered() {
    var value = null;
    try { value = localStorage.getItem(KEY); } catch (e) {}
    if (value) return value;
    var match = document.cookie.match(/(?:^|; )kiosk-display=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  links.forEach(function (link) { link.addEventListener('click', function () { remember(link.dataset.slug); }); });
  if (!links.length) { setTimeout(function () { location.reload(); }, 30000); return; }
  // Arrow keys move between the choices (WPE and TV remotes rarely have a useful Tab key).
  addEventListener('keydown', function (event) {
    var index = links.indexOf(document.activeElement);
    if (index < 0) return;
    var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    links[(index + step + links.length) % links.length].focus();
  });
  var previous = remembered();
  var target = links.filter(function (link) { return link.dataset.slug === previous; })[0];
  (target || links[0]).focus();
  if (!target || /[?&]choose\\b/.test(location.search)) return;
  var seconds = 10, timer;
  document.getElementById('resume-title').textContent = target.firstChild.textContent;
  document.getElementById('resume').hidden = false;
  function cancel() {
    clearInterval(timer);
    document.getElementById('resume').hidden = true;
    removeEventListener('keydown', cancel, true);
    removeEventListener('mousedown', cancel, true);
    removeEventListener('touchstart', cancel, true);
  }
  addEventListener('keydown', cancel, true);
  addEventListener('mousedown', cancel, true);
  addEventListener('touchstart', cancel, true);
  timer = setInterval(function () {
    seconds -= 1;
    document.getElementById('resume-seconds').textContent = String(seconds);
    if (seconds <= 0) { clearInterval(timer); location.href = target.href; }
  }, 1000);
})();
</script></body></html>`);
  });
}
