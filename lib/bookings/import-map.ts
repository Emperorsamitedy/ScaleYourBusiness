// The bookings import's column and status map — specs/bookings-import-map-v1.json,
// read here (rule 4: the mapping is data; this file only applies it). Pure.
//
// Header names and status words are compared after normalising: lower-case,
// everything outside a–z and 0–9 removed. A platform's own names are tried
// before the generic ones, and each role takes the first column that matches
// it, so one column never serves two roles.

import mapSpec from "../../specs/bookings-import-map-v1.json";
import type { BookingStatus } from "./types";

export const COLUMN_ROLES = [
  "ref",
  "start",
  "date",
  "time",
  "status",
  "service",
  "staff",
  "client_id",
  "client_email",
  "client_phone",
  "price",
  "duration",
  "cancelled_at",
] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/**
 * What a status word means before the date is known: "booked" is
 * booked_future after today and not closed out on or before it; "accepted"
 * (Square only) is completed once it is in the past.
 */
export type StatusTarget = Exclude<BookingStatus, "booked_future"> | "booked" | "accepted";

const TARGETS: readonly StatusTarget[] = [
  "completed",
  "no_show",
  "cancelled_late",
  "cancelled",
  "booked",
  "accepted",
];

interface PlatformSpec {
  label: string;
  verified: boolean;
  basis: string;
  columns: Partial<Record<ColumnRole, string[]>>;
  statuses: Partial<Record<StatusTarget, string[]>>;
}

interface MapSpec {
  version: string;
  roles: Record<ColumnRole, string>;
  generic: {
    columns: Record<ColumnRole, string[]>;
    statuses: Partial<Record<StatusTarget, string[]>>;
  };
  platforms: Record<BookingPlatform, PlatformSpec>;
  square_api: { basis: string; statuses: Record<string, StatusTarget> };
}

export const BOOKINGS_MAP = mapSpec as unknown as MapSpec;

export type BookingPlatform = keyof typeof mapSpec.platforms;

export const BOOKING_PLATFORMS = Object.keys(BOOKINGS_MAP.platforms) as BookingPlatform[];

export function isBookingPlatform(value: string): value is BookingPlatform {
  return Object.prototype.hasOwnProperty.call(BOOKINGS_MAP.platforms, value);
}

export function platformLabel(platform: BookingPlatform): string {
  return BOOKINGS_MAP.platforms[platform].label;
}

/** "Client e-mail" → "clientemail". */
export function normaliseName(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export type ColumnMap = Partial<Record<ColumnRole, number>>;

/**
 * Header → column index per role: the platform's names first, then the
 * generic ones. A column already taken by one role is not offered to the
 * next.
 */
export function mapColumns(header: readonly string[], platform: BookingPlatform): ColumnMap {
  const names = header.map(normaliseName);
  const taken = new Set<number>();
  const out: ColumnMap = {};
  const spec = BOOKINGS_MAP.platforms[platform];
  for (const source of [spec.columns, BOOKINGS_MAP.generic.columns]) {
    for (const role of COLUMN_ROLES) {
      if (out[role] !== undefined) continue;
      for (const candidate of source[role] ?? []) {
        const i = names.findIndex((n, idx) => n === normaliseName(candidate) && !taken.has(idx));
        if (i !== -1) {
          out[role] = i;
          taken.add(i);
          break;
        }
      }
    }
  }
  return out;
}

/** A status word → its target, the platform's words first. Null for a word nobody listed. */
export function statusTarget(raw: string, platform: BookingPlatform): StatusTarget | null {
  const word = normaliseName(raw);
  if (word === "") return null;
  const spec = BOOKINGS_MAP.platforms[platform];
  for (const source of [spec.statuses, BOOKINGS_MAP.generic.statuses]) {
    for (const target of TARGETS) {
      if ((source[target] ?? []).some((w) => normaliseName(w) === word)) return target;
    }
  }
  return null;
}

/** Square's BookingStatus enum → its target (the map file's square_api table). */
export function squareStatusTarget(status: string): StatusTarget | null {
  return BOOKINGS_MAP.square_api.statuses[status] ?? null;
}
