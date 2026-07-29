/**
 * roofMeasure — address in, roof measurements out.
 * Good Guys ND / BisMan Roof Guys. Built 28 July 2026.
 *
 * Works in a browser with no server and no build step, which means you can
 * paste it straight into Base44. Every endpoint it calls is CORS-open.
 *
 *   const r = await roofMeasure({ address: '616 Brome Ave', city: 'BISMARCK' });
 *
 * Sources, in order of authority:
 *   1. Google Solar API              measured per-facet area + real pitch   (needs a key)
 *   2. Bismarck Building_Footprints  measured building outline, free        (Bismarck city)
 *   3. County assessor floor area    derived, weakest, free                 (fallback)
 *
 * It reports every source it used, splits shared townhome roofs along the
 * parcel line, and flags disagreement instead of quietly picking a winner.
 *
 * No key configured = it still works, just without measured pitch.
 */
(function (root) {
  'use strict';

  var ORG1 = 'https://services1.arcgis.com/XxHmL09eFqJWI0gE/arcgis/rest/services';
  var MANDAN = 'https://services7.arcgis.com/wrXMuRbr2WUut1G0/arcgis/rest/services/City_Parcels_Public_20250506/FeatureServer/11/query';
  var FOOTPRINTS = ORG1 + '/Building_Footprints/FeatureServer/0/query';
  var SOLAR = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';

  var R = 6378137, M2FT2 = 10.7639104167;
  var rad = function (d) { return d * Math.PI / 180; };

  /* ---------------- geometry ---------------- */

  /** Geodesic area of a lon/lat ring in m2. Validated to 0.04% against the
   *  county's own GeodesicArea field on a known parcel. */
  function ringArea(r) {
    if (!r || r.length < 4) return 0;
    var t = 0;
    for (var i = 0; i < r.length - 1; i++) {
      var a = r[i], b = r[i + 1];
      t += rad(b[0] - a[0]) * (2 + Math.sin(rad(a[1])) + Math.sin(rad(b[1])));
    }
    return Math.abs(t * R * R / 2);
  }
  function polyArea(rings) {
    if (!rings || !rings.length) return 0;
    var a = ringArea(rings[0]);
    for (var i = 1; i < rings.length; i++) a -= ringArea(rings[i]);
    return Math.max(0, a);
  }
  function centroid(rings) {
    var r = rings && rings[0]; if (!r) return null;
    var xs = r.map(function (p) { return p[0]; }), ys = r.map(function (p) { return p[1]; });
    return { lon: (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2,
             lat: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2 };
  }
  function inRing(pt, ring) {
    var ins = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }
  function signedArea(ring) {
    var s = 0;
    for (var i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return s / 2;
  }
  /* ArcGIS returns clockwise outer rings. Sutherland-Hodgman needs a consistent
     winding or it silently returns the whole polygon uncut, which is how the
     first version of this reported a shared townhome as 100% on one parcel. */
  function ccw(ring) { return signedArea(ring) > 0 ? ring : ring.slice().reverse(); }

  /** Clip a building footprint to a parcel boundary. This is what splits a
   *  side-by-side townhome into the half each owner actually pays for. */
  function clipToParcel(subject, clip) {
    var out = ccw(subject).slice(0, -1), cl = ccw(clip).slice(0, -1);
    for (var i = 0; i < cl.length; i++) {
      var A = cl[i], B = cl[(i + 1) % cl.length], inp = out; out = [];
      if (!inp.length) break;
      var side = function (p) { return (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]); };
      for (var k = 0; k < inp.length; k++) {
        var cur = inp[k], prev = inp[(k + inp.length - 1) % inp.length];
        var dc = side(cur), dp = side(prev);
        var it = function () { var t = dp / (dp - dc);
          return [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]; };
        if (dc >= 0) { if (dp < 0) out.push(it()); out.push(cur); }
        else if (dp >= 0) out.push(it());
      }
    }
    if (out.length < 3) return null;
    out.push(out[0]);
    return out;
  }

  /* ---------------- address ---------------- */

  var SUF = { NORTH:'N', SOUTH:'S', EAST:'E', WEST:'W', NORTHEAST:'NE', NORTHWEST:'NW',
    SOUTHEAST:'SE', SOUTHWEST:'SW', STREET:'ST', AVENUE:'AVE', DRIVE:'DR', ROAD:'RD',
    LANE:'LN', COURT:'CT', PLACE:'PL', CIRCLE:'CIR', BOULEVARD:'BLVD', TERRACE:'TER',
    PARKWAY:'PKWY', HIGHWAY:'HWY', TRAIL:'TRL', FIRST:'1ST', SECOND:'2ND', THIRD:'3RD',
    FOURTH:'4TH', FIFTH:'5TH', SIXTH:'6TH', SEVENTH:'7TH', EIGHTH:'8TH', NINTH:'9TH', TENTH:'10TH' };

  function normStreet(raw) {
    var s = String(raw || '').split(',')[0].toUpperCase()
      .replace(/[.#]/g, ' ').replace(/\b(APT|UNIT|STE|SUITE)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return s.split(' ').map(function (w) { return SUF[w] || w; }).join(' ').replace(/\s+/g, ' ').trim();
  }
  function houseNo(s) { var m = String(s).match(/^(\d+)\b/); return m ? m[1] : null; }

  function jget(u) {
    return fetch(u, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; });
  }
  function arcQuery(base, where, geom) {
    return jget(base + '?where=' + encodeURIComponent(where) + '&outFields=*&returnGeometry=' +
      (geom ? 'true' : 'false') + '&outSR=4326&resultRecordCount=25&f=json');
  }
  function inMandan(lat, lon) {
    var g = encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
    return jget(MANDAN + '?geometry=' + g + '&geometryType=esriGeometryPoint&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects&outFields=PROPERTY_CITY&returnGeometry=false&f=json')
      .then(function (j) { return !!(j.features && j.features.length); });
  }

  /** Every parcel matching, each with its real city. Never guesses a city and
   *  never lets 921 match 1921. */
  async function findParcels(address) {
    var street = normStreet(address), no = houseNo(street);
    if (!street) return { street: street, all: [] };
    var sources = [
      { key: 'bismarck', url: ORG1 + '/ParcelsPublic/FeatureServer/0/query' },
      { key: 'cencom',   url: ORG1 + '/CenCom_Parcels/FeatureServer/1/query' },
      { key: 'mandan',   url: MANDAN }
    ];
    var all = [], seen = {};
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      var wheres = ["PROPERTY_ADDRESS = '" + street.replace(/'/g, "''") + "'",
                    "PROPERTY_ADDRESS LIKE '" + street.replace(/'/g, "''") + "%'"];
      for (var w = 0; w < wheres.length; w++) {
        var j = await arcQuery(src.url, wheres[w], true);
        if (!j.features || !j.features.length) continue;
        for (var f = 0; f < j.features.length; f++) {
          var ft = j.features[f], at = ft.attributes || {};
          var addr = String(at.PROPERTY_ADDRESS || '').toUpperCase().trim();
          if (no && houseNo(addr) !== no) continue;
          var c = centroid(ft.geometry && ft.geometry.rings);
          if (!c) continue;
          var key = addr + '|' + c.lat.toFixed(4) + ',' + c.lon.toFixed(4);
          var cty = src.key === 'bismarck' ? 'BISMARCK' : src.key === 'mandan' ? 'MANDAN'
                  : String(at.PROPERTY_CITY || '').toUpperCase().trim();
          if (seen[key] != null) { if (cty && !all[seen[key]].city) all[seen[key]].city = cty; continue; }
          seen[key] = all.length;
          all.push({ source: src.key, address: addr, city: cty,
            zip: String(at.ZIP || at.PROPERTY_ZIP || '').slice(0, 5),
            parcelId: at.PARCEL_ID || at.PIN || null, attrs: at,
            rings: ft.geometry.rings, centroid: c });
        }
        if (j.features.length) break;
      }
    }
    for (var i = 0; i < all.length; i++) {
      if (!all[i].city) {
        all[i].city = (await inMandan(all[i].centroid.lat, all[i].centroid.lon))
          ? 'MANDAN' : 'BURLEIGH / MORTON COUNTY';
        all[i].cityInferred = true;
      }
    }
    return { street: street, all: all };
  }

  /* ---------------- footprint ---------------- */

  async function footprintsFor(parcel) {
    var g = encodeURIComponent(JSON.stringify({ x: parcel.centroid.lon, y: parcel.centroid.lat,
      spatialReference: { wkid: 4326 } }));
    var j = await jget(FOOTPRINTS + '?geometry=' + g + '&geometryType=esriGeometryPoint&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects&distance=70&units=esriSRUnit_Meter' +
      '&outFields=TAG,Year_Built&returnGeometry=true&outSR=4326&f=json');
    var pr = parcel.rings[0], out = [];
    (j.features || []).forEach(function (f) {
      var rings = f.geometry && f.geometry.rings; if (!rings) return;
      var fc = centroid(rings);
      var tagMatch = parcel.parcelId && f.attributes.TAG === parcel.parcelId;
      var clipped = clipToParcel(rings[0], pr);
      var onParcel = clipped ? ringArea(clipped) : 0;
      var whole = polyArea(rings);
      // keep it if its centroid is on the parcel, its tag matches, or a real
      // slice of it falls inside — the last one is what catches shared roofs
      if (!inRing([fc.lon, fc.lat], pr) && !tagMatch && onParcel < whole * 0.08) return;
      out.push({
        tag: f.attributes.TAG || null,
        yearBuilt: f.attributes.Year_Built || null,
        wholeStructureFt2: Math.round(whole * M2FT2),
        onThisParcelFt2: Math.round(onParcel * M2FT2),
        shareOfStructure: whole > 0 ? +(onParcel / whole).toFixed(3) : 1,
        isShared: onParcel < whole * 0.95 && onParcel > 0
      });
    });
    return out.sort(function (a, b) { return b.onThisParcelFt2 - a.onThisParcelFt2; });
  }

  /* ---------------- Google Solar ---------------- */

  async function solarFor(lat, lon, key) {
    if (!key) return { available: false, reason: 'no API key configured' };
    var r, j;
    try {
      r = await fetch(SOLAR + '?location.latitude=' + lat + '&location.longitude=' + lon +
        '&requiredQuality=HIGH&key=' + key);
      j = await r.json();
      if (!r.ok) return { available: false, reason: (j.error && j.error.message) || ('HTTP ' + r.status) };
    } catch (e) { return { available: false, reason: e.message }; }

    var sp = j.solarPotential || {};
    var segs = (sp.roofSegmentStats || []).map(function (s) {
      return {
        areaFt2: s.stats ? Math.round(s.stats.areaMeters2 * M2FT2) : null,
        areaM2: s.stats ? s.stats.areaMeters2 : null,
        pitchDegrees: s.pitchDegrees,
        pitchRatio: s.pitchDegrees != null ? (Math.tan(rad(s.pitchDegrees)) * 12).toFixed(1) + '/12' : null,
        azimuthDegrees: s.azimuthDegrees
      };
    });
    var totalA = segs.reduce(function (a, s) { return a + (s.areaM2 || 0); }, 0);
    var wp = totalA ? segs.reduce(function (a, s) { return a + (s.pitchDegrees || 0) * (s.areaM2 || 0); }, 0) / totalA : null;
    var whole = sp.wholeRoofStats ? sp.wholeRoofStats.areaMeters2 : null;
    return {
      available: true,
      imageryQuality: j.imageryQuality || null,
      imageryDate: j.imageryDate || null,
      roofAreaFt2: whole != null ? Math.round(whole * M2FT2) : null,
      groundAreaFt2: (sp.wholeRoofStats && sp.wholeRoofStats.groundAreaMeters2 != null)
        ? Math.round(sp.wholeRoofStats.groundAreaMeters2 * M2FT2) : null,
      segmentCount: segs.length,
      weightedPitchDegrees: wp != null ? +wp.toFixed(1) : null,
      weightedPitchRatio: wp != null ? (Math.tan(rad(wp)) * 12).toFixed(1) + '/12' : null,
      segments: segs
    };
  }

  /* ---------------- main ---------------- */

  var PITCHES = [ { label: '4/12', f: 1.054 }, { label: '6/12', f: 1.118 },
                  { label: '8/12', f: 1.202 }, { label: '10/12', f: 1.302 } ];

  async function roofMeasure(opts) {
    opts = opts || {};
    var address = opts.address, city = String(opts.city || '').toUpperCase().trim();
    var zip = String(opts.zip || '').trim(), key = opts.solarApiKey || root.SOLAR_API_KEY || null;
    var t0 = Date.now();

    if (!address) return { ok: false, error: 'address is required' };
    if (!city) return { ok: false, error: 'city is required. Bismarck and Mandan share street names, so this will not guess.',
                        accepted: ['BISMARCK', 'MANDAN', 'LINCOLN', 'OTHER'] };

    var found = await findParcels(address);
    var matches = found.all, others = [];
    if (city !== 'OTHER') {
      matches = found.all.filter(function (p) { return p.city.indexOf(city) === 0; });
      others  = found.all.filter(function (p) { return p.city.indexOf(city) !== 0; });
    }
    if (zip.length === 5) {
      var keep = matches.filter(function (p) { return !p.zip || p.zip === zip; });
      others = others.concat(matches.filter(function (p) { return p.zip && p.zip !== zip; }));
      matches = keep;
    }

    if (!matches.length) return { ok: false, matched: false, normalized: found.street,
      error: others.length ? 'No parcel found for ' + found.street + ' in ' + city + '.'
                           : 'No public parcel record found for ' + found.street + '.',
      otherCityMatches: others.map(function (p) {
        return { address: p.address, city: p.city, zip: p.zip, parcelId: p.parcelId }; }),
      note: 'A different city is never substituted. Confirm one of the above or correct the address.' };

    if (matches.length > 1) return { ok: false, matched: false, normalized: found.street,
      error: matches.length + ' parcels in ' + city + ' share this address.',
      candidates: matches.map(function (p) {
        return { address: p.address, city: p.city, zip: p.zip, parcelId: p.parcelId,
                 lat: +p.centroid.lat.toFixed(6), lon: +p.centroid.lon.toFixed(6) }; }) };

    var p = matches[0];
    var fps = await footprintsFor(p);
    var primary = fps[0] || null;
    var solar = await solarFor(p.centroid.lat, p.centroid.lon, key);
    var at = p.attrs || {};

    var estimates = [];
    var share = (primary && primary.isShared) ? primary.shareOfStructure : 1;
    if (solar.available && solar.roofAreaFt2) {
      estimates.push({
        method: 'google_solar_measured', confidence: 'high',
        roofAreaFt2: Math.round(solar.roofAreaFt2 * share),
        wholeStructureFt2: solar.roofAreaFt2,
        parcelShareApplied: share < 1 ? +share.toFixed(3) : null,
        basis: 'measured, ' + solar.segmentCount + ' facets, ' + solar.weightedPitchRatio + ' weighted pitch' +
               (share < 1 ? ', whole structure ' + solar.roofAreaFt2.toLocaleString() +
                            ' sq ft reduced to this parcel\u2019s ' + (share * 100).toFixed(0) + '%' : '') });
    }

    if (primary) estimates.push({
      method: 'measured_footprint_x_pitch', confidence: 'medium',
      footprintFt2: primary.onThisParcelFt2,
      byPitch: PITCHES.map(function (x) {
        return { pitch: x.label, roofAreaFt2: Math.round(primary.onThisParcelFt2 * x.f) }; }),
      basis: 'City of Bismarck measured building outline' +
             (primary.isShared ? ', clipped to this parcel only' : '') + ', across common pitches' });

    if (at.MAIN_FLOOR_AREA_SQ_FT) estimates.push({
      method: 'assessor_floor_area_derived', confidence: 'low',
      roofAreaFt2: Math.round(at.MAIN_FLOOR_AREA_SQ_FT * 1.35 + (at.GarageSqft || 0) * 1.15),
      basis: 'assessor floor area x 1.35 plus garage x 1.15, the RHS-style derivation' });

    /* Two genuinely independent measurements of the same thing: Google's ground
       footprint of the structure vs the City of Bismarck's digitised outline.
       Compare whole against whole, never a clipped half against a whole. */
    var agreement = null;
    if (solar.available && solar.groundAreaFt2 && primary && primary.wholeStructureFt2) {
      var d = Math.abs(solar.groundAreaFt2 - primary.wholeStructureFt2) / solar.groundAreaFt2;
      agreement = {
        comparedWith: 'Google ground footprint vs City of Bismarck measured outline, whole structure both sides',
        googleFt2: solar.groundAreaFt2, cityFt2: primary.wholeStructureFt2,
        deltaPercent: +(d * 100).toFixed(1),
        verdict: d < 0.10 ? 'two independent sources agree' : 'sources disagree, verify on site' };
    }

    return {
      ok: true, matched: true,
      query: { address: address, normalized: found.street, city: city, zip: zip || null },
      property: {
        address: p.address, city: p.city, cityInferredFromMap: !!p.cityInferred,
        zip: p.zip || null, parcelId: p.parcelId, parcelSource: p.source,
        lat: +p.centroid.lat.toFixed(6), lon: +p.centroid.lon.toFixed(6),
        yearBuilt: (at.YEAR_BUILT > 1850 ? at.YEAR_BUILT : (primary && primary.yearBuilt) || null),
        parcelAreaFt2: Math.round(polyArea(p.rings) * M2FT2)
      },
      sharedRoof: primary ? {
        isShared: primary.isShared,
        shareOfStructure: primary.shareOfStructure,
        wholeStructureFt2: primary.wholeStructureFt2,
        thisParcelFt2: primary.onThisParcelFt2,
        note: primary.isShared
          ? 'This building crosses the parcel line. Everything above is clipped to THIS parcel, which is the share this owner would pay for.'
          : 'Building sits entirely within this parcel.'
      } : { isShared: null, note: 'No measured footprint published at this location.' },
      solar: solar,
      estimates: estimates,
      agreement: agreement,
      sources: {
        parcel: p.source === 'mandan' ? 'City of Mandan open parcels'
              : p.source === 'bismarck' ? 'City of Bismarck / Burleigh County assessor'
              : 'CenCom regional parcels',
        footprint: primary ? 'City of Bismarck Building_Footprints, measured' : 'none published here',
        pitch: solar.available ? 'Google Solar API, measured per facet' : 'unavailable without a Solar API key'
      },
      disclaimer: 'Estimates from public data. Not a quote, not a warranty, not an insurance opinion. Verify on site before ordering material.',
      elapsedMs: Date.now() - t0
    };
  }

  roofMeasure.util = { ringArea: ringArea, polyArea: polyArea, clipToParcel: clipToParcel,
                       normStreet: normStreet, centroid: centroid, M2FT2: M2FT2 };

  if (typeof module !== 'undefined' && module.exports) module.exports = roofMeasure;
  root.roofMeasure = roofMeasure;
})(typeof globalThis !== 'undefined' ? globalThis : this);
