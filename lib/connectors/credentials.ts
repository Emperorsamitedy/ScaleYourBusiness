// What the connect form asks for, per provider. Pure data, no secrets.
//
// A one-field credential (a Stripe key) is sent as the string itself. A
// multi-field credential (a Shopify store address, client ID and client
// secret) travels as one JSON object, so it is encrypted and stored whole
// (rule 10) and the provider module parses it back.

import type { ProviderId } from "./scopes";

export interface CredentialField {
  name: string;
  label: string;
  placeholder: string;
  /** Rendered as a password field and never echoed back. */
  secret: boolean;
  /** Rendered as a textarea: a pasted key file, not a line. */
  multiline?: boolean;
}

export const CREDENTIAL_FIELDS: Readonly<Record<ProviderId, readonly CredentialField[]>> = {
  fixture: [
    { name: "key", label: "Fixture credential", placeholder: "fixture-read-only", secret: true },
  ],
  stripe: [{ name: "key", label: "Restricted key", placeholder: "rk_test_…", secret: true }],
  shopify: [
    {
      name: "shop",
      label: "Store address",
      placeholder: "your-store.myshopify.com",
      secret: false,
    },
    {
      name: "client_id",
      label: "Client ID",
      placeholder: "from the app's Settings",
      secret: false,
    },
    {
      name: "client_secret",
      label: "Client secret",
      placeholder: "from the app's Settings",
      secret: true,
    },
  ],
  woocommerce: [
    {
      name: "site_url",
      label: "Store address",
      placeholder: "https://your-store.com",
      secret: false,
    },
    { name: "consumer_key", label: "Consumer key", placeholder: "ck_…", secret: true },
    { name: "consumer_secret", label: "Consumer secret", placeholder: "cs_…", secret: true },
  ],
  ga4: [
    {
      name: "property_id",
      label: "Property ID",
      placeholder: "the number under Admin, Property details",
      secret: false,
    },
    {
      name: "service_account_json",
      label: "Service account key file",
      placeholder: "paste the whole JSON key file here",
      secret: true,
      multiline: true,
    },
  ],
  meta_ads: [
    {
      name: "ad_account_id",
      label: "Ad account ID",
      placeholder: "act_1234567890",
      secret: false,
    },
    {
      name: "access_token",
      label: "System user access token",
      placeholder: "EAA…",
      secret: true,
    },
  ],
};

/** Encode form values into the single credential string the connect API takes. */
export function encodeCredential(
  fields: readonly CredentialField[],
  values: Readonly<Record<string, string>>,
): string {
  if (fields.length === 1) {
    const only = fields[0];
    return only ? (values[only.name] ?? "").trim() : "";
  }
  return JSON.stringify(
    Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? "").trim()])),
  );
}
