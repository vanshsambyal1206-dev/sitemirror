/* Fixture behaviour: an API fetch with session data, a lazy section, and a
   pushState route so the crawler's SPA discovery has something to find. */
(function () {
  'use strict';

  var out = document.getElementById('api-out');
  if (out) {
    fetch('/api/data.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        out.textContent = 'api: ' + data.items.length + ' items · session ' + data.session + ' · expires ' + data.expires_at;
      })
      .catch(function () {
        out.textContent = 'api: failed';
      });
  }

  var routeBtn = document.getElementById('spa-link');
  if (routeBtn) {
    routeBtn.addEventListener('click', function () {
      history.pushState({}, '', '/app/route-a');
      var routeOut = document.getElementById('route-out');
      if (routeOut) routeOut.textContent = 'client route: ' + location.pathname;
      document.title = 'App Route A — Fixture';
    });
  }
})();
