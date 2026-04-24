export type DubaiListingRow = {
    listing_id: string;
    title: string | null;
    /** Nightly price in the listing's native currency (see `currency` field). Do NOT assume AED. */
    nightly_price: number | null;
    /** Total price for the scraped booking window in the listing's native currency. */
    price_total: number | null;
    /**
     * Raw currency label as captured from the source page. The current scrape is
     * China-locale Airbnb so this is "￥" (CNY) for every row. Values are NOT
     * converted or normalized — downstream callers must surface the currency
     * honestly instead of silently renaming a CNY field to look like AED.
     */
    currency: string | null;
    property_type: string | null;
    guest_capacity: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    rating_overall: number | null;
    review_count: number | null;
    url: string | null;
    /** Latitude (WGS84) as scraped. Null if the source page didn't carry it. */
    lat: number | null;
    /** Longitude (WGS84) as scraped. */
    lng: number | null;
    /**
     * Google Maps link built from lat/lng. Null if coords are missing. This is
     * the "show me on a map" affordance for end-users — cheap, no API key, no
     * network call — so every recommendation can include it.
     */
    map_url: string | null;
    /**
     * Great-circle distance in kilometres from the `anchorLat`/`anchorLng`
     * provided in SearchListingsOpts. Null when no anchor was provided or when
     * the listing is missing coords.
     */
    distance_km: number | null;
    matched_amenities: string[];
    untrusted_description: string;
};
export type SearchListingsOpts = {
    /**
     * Minimum nightly price in the database's native currency (currently CNY —
     * see DubaiListingRow.currency). The caller is responsible for knowing the
     * unit; the service only does numeric comparison.
     */
    minPrice?: number;
    /** Maximum nightly price in the database's native currency. */
    maxPrice?: number;
    /** Required amenity keywords; all must be present (case-insensitive substring match). */
    amenities?: string[];
    minBedrooms?: number;
    maxBedrooms?: number;
    minRating?: number;
    /**
     * Geographic anchor for distance-based filtering. If both `anchorLat` and
     * `anchorLng` are provided, the service computes the great-circle distance
     * from each matched listing to the anchor (Haversine), populates
     * `distance_km` on every row, and — if `maxKm` is also set — drops rows
     * whose distance exceeds the cap.
     *
     * The service does NOT reorder by distance. Sort stays price ASC so the
     * LLM can still reason about trade-offs (closest vs cheapest vs highest
     * rated) over the raw candidate set.
     *
     * Listings missing lat/lng are always dropped when `maxKm` is set, since
     * we can't prove they're in range.
     */
    anchorLat?: number;
    anchorLng?: number;
    maxKm?: number;
    limit?: number;
};
export declare class DubaiListingsService {
    private db;
    constructor(dbPath: string);
    close(): void;
    searchListings(opts: SearchListingsOpts): DubaiListingRow[];
}
