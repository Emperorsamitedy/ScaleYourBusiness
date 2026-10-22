// Bookings — the shapes both sources share (specs/bookings.md). Pure.

/** The closed set every source's status words normalise to. */
export const BOOKING_STATUSES = [
  "completed",
  "no_show",
  "cancelled_late",
  "cancelled",
  "booked_future",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Who the client is, as the source gave it — only ever in memory, on its
 * way to clientKey() (lib/bookings/client-key.ts). The stored row carries
 * the keyed hash, never this.
 */
export interface ClientIdentity {
  kind: "id" | "email" | "phone";
  value: string;
}

/** A client already turned into its keyed hash (the import hashes as it reads). */
export interface KeyedClient {
  kind: "keyed";
  key: string;
}

/** One appointment as a source read it, before it is stored. */
export interface BookingInput {
  /** The source's own id ("square:abc"), or a content key — unique per connection. */
  source_ref: string;
  /** "YYYY-MM-DD" — the day it counts on. */
  day: string;
  /** "HH:MM" when known. */
  start_time: string | null;
  status: BookingStatus;
  service: string | null;
  staff_ref: string | null;
  /** Raw only in memory (Square's customer id); the store keeps the keyed hash. */
  client: ClientIdentity | KeyedClient | null;
  duration_minutes: number | null;
  /** Integer minor units with its currency (rule 1), or both null. */
  price_minor: number | null;
  currency: string | null;
}

/** An appointment as the measures read it: what is stored, nothing more. */
export interface MeasuredAppointment {
  day: string;
  status: BookingStatus;
  client_key: string | null;
  price_minor: number | null;
  currency: string | null;
}
