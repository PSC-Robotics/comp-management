/**
 * Browser script shared by every screen (non-SR displays inline it; SR screens
 * and the admin page load it from /assets/clock-sync.js) so they all estimate
 * server time the same way: NTP-style samples against /api/time, keeping the
 * one with the fastest round trip from the last two minutes. Exposes
 * window.ServerClock.now() (server time in ms) and .offset.
 */
export const clockSyncScript = String.raw`(function () {
  if (window.ServerClock) return;
  var samples = [];
  var offset = 0;
  var uncertainty = Infinity;
  var synced = false;
  var listeners = [];
  function best() {
    var cutoff = Date.now() - 120000;
    samples = samples.filter(function (sample) { return sample.at >= cutoff; });
    return samples.reduce(function (chosen, sample) { return !chosen || sample.rtt < chosen.rtt ? sample : chosen; }, null);
  }
  function sample() {
    var sentAt = Date.now();
    var started = performance.now();
    return fetch('/api/time', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        var rtt = performance.now() - started;
        if (!isFinite(body.serverTime) || rtt > 5000) return;
        var estimate = body.serverTime - (sentAt + rtt / 2);
        var current = best();
        // This device's clock jumped (e.g. it synced its own time): forget older samples.
        if (current && Math.abs(estimate - current.offset) > 1000 + rtt) samples = [];
        samples.push({ offset: estimate, rtt: rtt, at: Date.now() });
        var chosen = best();
        offset = chosen.offset;
        uncertainty = chosen.rtt / 2;
        synced = true;
        listeners.forEach(function (listener) { try { listener(offset); } catch (error) {} });
      })
      .catch(function () {});
  }
  // A quick burst finds a fast round trip; then a fresh sample every 10 seconds.
  var burst = 0;
  (function next() { sample().then(function () { if (++burst < 6) setTimeout(next, 150); }); })();
  setInterval(sample, 10000);
  window.ServerClock = {
    now: function () { return Date.now() + offset; },
    get offset() { return offset; },
    get uncertainty() { return uncertainty; },
    get synced() { return synced; },
    onChange: function (listener) { listeners.push(listener); }
  };
})();`;
