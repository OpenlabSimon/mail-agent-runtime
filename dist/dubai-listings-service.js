// DubaiListingsService — read-only wrapper over the scraper's collector DB.
//
// This is the bridge between the MarketplaceAgent (which lives in the P2P
// marketplace protocol) and the real scraped Airbnb inventory. It exposes a
// single method `searchListings()` that the agent calls when a user asks for
// rental recommendations.
//
// Design notes:
//  - Read-only: opened with { readOnly: true }. The advisor has no business
//    writing to the scraper's database, and a typo in a future refactor must
//    not corrupt the scraped inventory.
//  - Multi-city DB, Dubai-only filter: the collector DB (airbnb-collector.db)
//    holds every city the scraper covers — dubai-*, bali-*, bangkok, etc. —
//    distinguished by a `city` column. This service name is "Dubai"ListingsService
//    and it hardcodes `WHERE s.city LIKE 'dubai%'` to prevent Bali rows from
//    leaking into a Dubai rental recommendation. If we ever want a Bali
//    equivalent, extract a city prefix parameter; for now YAGNI.
//  - Amenity filter is AND-of-keywords: every keyword in `amenities` must
//    match at least one row in listing_amenities for the snapshot. Implemented
//    as a chain of INTERSECT subqueries, which sqlite handles well on this
//    table size (~200 listings).
//  - Description is returned truncated. The full text can run ~6000 chars per
//    listing, which would blow the agent's context window if it pulled 10
//    results. The agent wraps this text in <untrusted_content> before showing
//    it to the model — descriptions are scraped from Airbnb and can contain
//    injection attempts.
//  - Return shape uses `untrusted_description` as the field name to match the
//    convention in MarketplaceService and remind callers to wrap it.
import { DatabaseSync } from "node:sqlite";
// Default result cap — deliberately generous. The service only applies HARD
// filters (amenities, price bounds). Ranking and final selection are the
// LLM's job: the agent should be able to see enough candidates to reason
// about "cheapest", "best rating per dollar", "closest to X" etc. on its
// own, instead of us baking preference logic into SQL.
const DEFAULT_LIMIT = 25;
const DESC_MAX_CHARS = 600;
// When the caller passes a radius filter, the SQL LIMIT is applied BEFORE
// distance filtering — so we need to pull the entire Dubai slice of the
// collector table, then distance-filter in memory, then apply the real
// limit. Must be large enough that all Dubai rows fit; the collector DB
// currently holds ~1400 Dubai rows and grows slowly. If it ever crosses
// this cap we'll start silently truncating — cheapest-first sort means
// the priciest corners of Dubai would be missing from radius results.
//
// An earlier version used a small multiplier (limit * 10). That broke the
// moment we repointed from the 189-row snapshot to the full 1400-row
// collector: the 200 cheapest Dubai rows all lived in Deira/Dubailand, so
// a Marina radius filter scrubbed every candidate out. Don't reintroduce
// the multiplier — just fetch wide.
const RADIUS_SQL_LIMIT = 10000;
// Earth's mean radius in kilometres — for Haversine.
const EARTH_KM = 6371;
function haversineKm(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}
function buildMapUrl(lat, lng) {
    if (lat == null || lng == null)
        return null;
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
export class DubaiListingsService {
    constructor(dbPath) {
        this.db = new DatabaseSync(dbPath, { readOnly: true });
    }
    close() {
        this.db.close();
    }
    searchListings(opts) {
        const limit = Math.max(1, Math.min(50, opts.limit ?? DEFAULT_LIMIT));
        const hasAnchor = opts.anchorLat != null && opts.anchorLng != null;
        const hasRadius = hasAnchor && opts.maxKm != null;
        // When radius-filtering, fetch wide (effectively the entire Dubai slice)
        // and truncate after the Haversine pass; otherwise the early SQL LIMIT
        // can throw away every valid in-range row. See RADIUS_SQL_LIMIT comment.
        const sqlFetchLimit = hasRadius ? RADIUS_SQL_LIMIT : limit;
        // Hardcoded Dubai-only guard. The collector DB is multi-city; without
        // this filter a "cheap listing" search would happily return Bali or
        // Bangkok rows. All Dubai zone slugs in scraper-config.dubai-zones.yaml
        // and the multi-city scraper-config.yaml dubai entry start with "dubai".
        const where = ["s.nightly_price IS NOT NULL", "s.city LIKE 'dubai%'"];
        const params = [];
        if (opts.minPrice != null) {
            where.push("s.nightly_price >= ?");
            params.push(opts.minPrice);
        }
        if (opts.maxPrice != null) {
            where.push("s.nightly_price <= ?");
            params.push(opts.maxPrice);
        }
        if (opts.minBedrooms != null) {
            where.push("s.bedrooms >= ?");
            params.push(opts.minBedrooms);
        }
        if (opts.maxBedrooms != null) {
            where.push("s.bedrooms <= ?");
            params.push(opts.maxBedrooms);
        }
        if (opts.minRating != null) {
            where.push("s.rating_overall >= ?");
            params.push(opts.minRating);
        }
        // Amenity AND-filter via INTERSECT chain. Empty list is a no-op.
        const amenities = (opts.amenities ?? []).map((a) => a.trim()).filter(Boolean);
        if (amenities.length > 0) {
            const subs = amenities.map(() => `SELECT listing_snapshot_id FROM listing_amenities WHERE amenity_name LIKE ?`).join(" INTERSECT ");
            where.push(`s.listing_snapshot_id IN (${subs})`);
            for (const a of amenities)
                params.push(`%${a}%`);
        }
        // The service does NOT rank by user preference. Order is a stable
        // cheapest-first so that when the LLM hits its limit, it at least sees
        // the budget end of the spectrum — but the LLM is expected to review the
        // whole result set and pick final recommendations itself.
        const sql = `
      SELECT
        s.listing_snapshot_id,
        s.listing_id,
        s.title,
        s.nightly_price,
        s.price_total,
        s.currency,
        s.property_type,
        s.guest_capacity,
        s.bedrooms,
        s.bathrooms,
        s.rating_overall,
        s.review_count,
        s.url,
        s.lat,
        s.lng,
        s.description
      FROM listing_snapshots s
      WHERE ${where.join(" AND ")}
      ORDER BY s.nightly_price ASC
      LIMIT ?
    `;
        params.push(sqlFetchLimit);
        const rawRows = this.db.prepare(sql).all(...params);
        // Distance annotation + optional radius filter. Preserve the price ASC
        // order — the service does not re-sort by distance; the LLM still ranks.
        const anchorLat = opts.anchorLat;
        const anchorLng = opts.anchorLng;
        const withDistance = rawRows.map((r) => {
            let dist = null;
            if (hasAnchor && r.lat != null && r.lng != null) {
                dist = haversineKm(anchorLat, anchorLng, r.lat, r.lng);
            }
            return { ...r, distance_km: dist };
        });
        const filtered = hasRadius
            ? withDistance.filter((r) => r.distance_km != null && r.distance_km <= opts.maxKm)
            : withDistance;
        const rows = filtered.slice(0, limit);
        if (rows.length === 0)
            return [];
        // Second pass: for each matched snapshot, collect the amenity names that
        // hit the filter so the agent can show the user which requirements landed.
        const amenityStmt = this.db.prepare(`SELECT amenity_name FROM listing_amenities WHERE listing_snapshot_id = ?`);
        return rows.map((r) => {
            const all = amenityStmt.all(r.listing_snapshot_id)
                .map((a) => a.amenity_name);
            const matched = amenities.length > 0
                ? all.filter((name) => amenities.some((q) => name.toLowerCase().includes(q.toLowerCase())))
                : [];
            const desc = r.description ?? "";
            const truncated = desc.length > DESC_MAX_CHARS ? desc.slice(0, DESC_MAX_CHARS) + "…" : desc;
            return {
                listing_id: r.listing_id,
                title: r.title,
                nightly_price: r.nightly_price,
                price_total: r.price_total,
                currency: r.currency,
                property_type: r.property_type,
                guest_capacity: r.guest_capacity,
                bedrooms: r.bedrooms,
                bathrooms: r.bathrooms,
                rating_overall: r.rating_overall,
                review_count: r.review_count,
                url: r.url,
                lat: r.lat,
                lng: r.lng,
                map_url: buildMapUrl(r.lat, r.lng),
                distance_km: r.distance_km,
                matched_amenities: matched,
                untrusted_description: truncated,
            };
        });
    }
}
