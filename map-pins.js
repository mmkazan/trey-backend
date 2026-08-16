/* Trey — drawing dots on a Google Static Maps picture.
 *
 * Shared by go.html (the street) and leads.html (the desk), because the Web
 * Mercator maths also exists server-side in nearby.js and three copies of the
 * same projection is how every dot ends up quietly in the wrong place. Two is
 * the minimum (one client, one server) and a test asserts they agree.
 *
 * WHY DRAW THE DOTS AT ALL, rather than letting Google burn them into the image:
 * a baked-in pin can't follow the filter or the sort, and re-fetching a picture
 * on every tap costs a Static Maps call each time. Drawing them here is instant,
 * free, and can never disagree with the list beside it.
 *
 * Positions are PERCENTAGES of the picture, not pixels, because the <img> is
 * width:100% — its real size isn't known until layout and changes when a phone
 * is rotated or a window resized. Percentages survive all of that with no
 * resize listener.
 */
(function (root) {
  "use strict";

  // Must match projX/projY in netlify/functions/nearby.js exactly.
  function projX(lng, world) { return ((lng + 180) / 360) * world; }
  function projY(lat, world) {
    var s = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * Math.PI / 180)));
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  }

  /**
   * Where a point sits on the picture, or null if it falls outside it.
   * @param map {img, centre:{lat,lng}, zoom, width, height} as returned by nearby.js
   */
  function pinPos(map, lat, lng) {
    if (!map || lat == null || lng == null) return null;
    var world = 256 * Math.pow(2, map.zoom);
    var x = (map.width / 2 + projX(lng, world) - projX(map.centre.lng, world)) / map.width * 100;
    var y = (map.height / 2 + projY(lat, world) - projY(map.centre.lat, world)) / map.height * 100;
    if (x < -1 || x > 101 || y < -1 || y > 101) return null;
    return { x: x.toFixed(2), y: y.toFixed(2) };
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /**
   * Build the map markup.
   *
   * @param o.map    the picture + projection from nearby.js
   * @param o.pins   [{lat,lng,cls,label,title,onclick}] — the ones that matter
   * @param o.dim    [{lat,lng}] — present but not in view (filtered out)
   * @param o.me     {lat,lng} — your position or the search centre
   * @param o.meLabel single character for the centre dot ("Y" or "+")
   * @param o.meTitle hover text for the centre dot
   * @param o.legend [{colour,label}] — drawn under the picture
   * @param o.alt    alt text for the image
   * @returns HTML string, or "" when there's no picture to draw on
   */
  function html(o) {
    var map = o && o.map;
    if (!map || !map.img) return "";
    var dots = "";

    (o.pins || []).forEach(function (p) {
      var pos = pinPos(map, p.lat, p.lng);
      if (!pos) return;
      var style = "left:" + pos.x + "%;top:" + pos.y + "%";
      var title = esc(p.title || "");
      dots += p.onclick
        ? '<button class="pin ' + esc(p.cls || "") + '" style="' + style + '" onclick="' +
          esc(p.onclick) + '" title="' + title + '" aria-label="' + title + '">' +
          esc(p.label == null ? "" : p.label) + "</button>"
        : '<span class="pin ' + esc(p.cls || "") + '" style="' + style + '" title="' + title + '">' +
          esc(p.label == null ? "" : p.label) + "</span>";
    });

    // Deliberately subordinate: keeps the street recognisable without competing
    // with the doors you're actually going to.
    (o.dim || []).forEach(function (d) {
      var pos = pinPos(map, d.lat, d.lng);
      if (!pos) return;
      dots += '<span class="dim" style="left:' + pos.x + '%;top:' + pos.y + '%"></span>';
    });

    if (o.me) {
      var mp = pinPos(map, o.me.lat, o.me.lng);
      if (mp) {
        dots += '<span class="pin you" style="left:' + mp.x + '%;top:' + mp.y + '%" title="' +
          esc(o.meTitle || "") + '">' + esc(o.meLabel == null ? "Y" : o.meLabel) + "</span>";
      }
    }

    var legend = (o.legend || []).map(function (l) {
      return '<span><i style="background:' + esc(l.colour) +
        (l.faint ? ";opacity:.5;width:7px;height:7px" : "") + '"></i>' + esc(l.label) + "</span>";
    }).join("");

    return '<div class="mapwrap"><img class="map" src="' + map.img + '" alt="' +
      esc(o.alt || "Map") + '" />' + dots + "</div>" +
      (legend ? '<div class="maplegend">' + legend + "</div>" : "");
  }

  /** How many of these could actually be drawn — for an honest "N of M shown". */
  function countPlaceable(map, items) {
    var n = 0;
    (items || []).forEach(function (i) { if (pinPos(map, i.lat, i.lng)) n++; });
    return n;
  }

  root.TreyMap = { projX: projX, projY: projY, pinPos: pinPos, html: html, countPlaceable: countPlaceable };
  // Also exported for the test suite, which checks this projection against the
  // server's to the pixel.
  if (typeof module !== "undefined" && module.exports) module.exports = root.TreyMap;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
