// Idea 53 (I-53.3): Web Push against the RFCs' own example values.
//
// RFC 8291 §5 and Appendix A give every input and intermediate value of one
// encryption ("When I grow up, I want to be a watermelon"), so the whole
// derivation and the final message body are checked byte for byte. RFC 8292
// §2.4 gives a signed VAPID JWT and the key that signed it; ECDSA
// signatures are randomised, so ours can't equal it, but the RFC's must
// verify under our verifier and ours under the same rules.

import { createDecipheriv, createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_PLAINTEXT,
  WebPushError,
  audienceOf,
  b64url,
  checkVapidKeys,
  deriveKeys,
  encryptPayload,
  fromB64url,
  generateVapidKeys,
  signVapidJwt,
  vapidAuthorization,
  verifyVapidJwt,
} from "./webpush";

// RFC 8291 Appendix A — inputs.
const PLAINTEXT = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
const AS_PUBLIC =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const UA_PUBLIC =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

// RFC 8291 Appendix A — intermediate values.
const ECDH_SECRET = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";
const PRK_KEY = "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k";
const KEY_INFO =
  "V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3" +
  "ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAv" +
  "MBKiiujwa7t45ewP";
const IKM = "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg";
const PRK = "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc";
const CEK = "oIhVW04MRdy2XN9CiKLxTg";
const NONCE = "4h_95klXJ5E_qnoN";
const HEADER =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const CIPHERTEXT = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";
// RFC 8291 §5 — the message body as sent.
const BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

// RFC 8292 §2.4.
const RFC_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3" +
  "B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1ha" +
  "Wx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_H" +
  "LGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
const RFC_K =
  "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";

const hex = (s: string) => fromB64url(s).toString("hex");

/** What a browser does with the body (RFC 8291 from the receiving side). */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const idlen = body[20] as number;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const keys = deriveKeys({
    ecdhSecret: ecdh.computeSecret(asPublic),
    authSecret: auth,
    uaPublic,
    asPublic,
    salt,
  });
  const ct = body.subarray(21 + idlen);
  const decipher = createDecipheriv("aes-128-gcm", keys.cek, keys.nonce);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const padded = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  return { padded, rs: body.readUInt32BE(16) };
}

describe("RFC 8291 payload encryption", () => {
  it("derives every intermediate value of Appendix A", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(fromB64url(AS_PRIVATE));
    expect(b64url(ecdh.getPublicKey())).toBe(AS_PUBLIC);
    const secret = ecdh.computeSecret(fromB64url(UA_PUBLIC));
    const k = deriveKeys({
      ecdhSecret: secret,
      authSecret: fromB64url(AUTH),
      uaPublic: fromB64url(UA_PUBLIC),
      asPublic: fromB64url(AS_PUBLIC),
      salt: fromB64url(SALT),
    });
    expect(b64url(k.ecdh_secret)).toBe(ECDH_SECRET);
    expect(b64url(k.prk_key)).toBe(PRK_KEY);
    expect(hex(b64url(k.key_info))).toBe(hex(KEY_INFO));
    expect(b64url(k.ikm)).toBe(IKM);
    expect(b64url(k.prk)).toBe(PRK);
    expect(b64url(k.cek)).toBe(CEK);
    expect(b64url(k.nonce)).toBe(NONCE);
  });

  it("produces the exact message body of §5 from the RFC's keys and salt", () => {
    const body = encryptPayload({
      plaintext: fromB64url(PLAINTEXT),
      uaPublic: fromB64url(UA_PUBLIC),
      authSecret: fromB64url(AUTH),
      asPrivate: fromB64url(AS_PRIVATE),
      salt: fromB64url(SALT),
    });
    // 86 header + 41 plaintext + 1 delimiter + 16 tag. The RFC's example
    // request says "Content-Length: 145", but its own body decodes to 144.
    expect(body.length).toBe(144);
    expect(b64url(body.subarray(0, 86))).toBe(HEADER);
    expect(b64url(body.subarray(86))).toBe(CIPHERTEXT);
    expect(b64url(body)).toBe(BODY);
  });

  it("is something a browser holding the subscription's private key can read", () => {
    const body = encryptPayload({
      plaintext: Buffer.from('{"title":"ScaleX"}'),
      uaPublic: fromB64url(UA_PUBLIC),
      authSecret: fromB64url(AUTH),
    });
    const { padded, rs } = decryptAsBrowser(
      body,
      fromB64url(UA_PRIVATE),
      fromB64url(UA_PUBLIC),
      fromB64url(AUTH),
    );
    expect(rs).toBe(4096);
    expect(padded.at(-1)).toBe(0x02); // the last-record delimiter
    expect(padded.subarray(0, -1).toString()).toBe('{"title":"ScaleX"}');
  });

  it("draws a fresh key pair and salt for every message", () => {
    const enc = () =>
      encryptPayload({
        plaintext: Buffer.from("x"),
        uaPublic: fromB64url(UA_PUBLIC),
        authSecret: fromB64url(AUTH),
      });
    const a = enc();
    const b = enc();
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });

  it("refuses a bad subscription key, a bad auth secret and an oversized payload", () => {
    const ok = { plaintext: Buffer.from("x"), uaPublic: fromB64url(UA_PUBLIC) };
    expect(() =>
      encryptPayload({ ...ok, uaPublic: Buffer.alloc(65, 1), authSecret: fromB64url(AUTH) }),
    ).toThrow(WebPushError);
    expect(() => encryptPayload({ ...ok, authSecret: Buffer.alloc(15) })).toThrow(WebPushError);
    expect(() =>
      encryptPayload({
        ...ok,
        plaintext: Buffer.alloc(MAX_PLAINTEXT + 1),
        authSecret: fromB64url(AUTH),
      }),
    ).toThrow(WebPushError);
    expect(
      () =>
        encryptPayload({
          ...ok,
          plaintext: Buffer.alloc(MAX_PLAINTEXT),
          authSecret: fromB64url(AUTH),
        }).length,
    ).not.toThrow();
  });
});

describe("RFC 8292 VAPID", () => {
  it("verifies the RFC's own signed JWT under its key", () => {
    expect(verifyVapidJwt(RFC_JWT, RFC_K)).toBe(true);
    const [head, body] = RFC_JWT.split(".") as [string, string];
    expect(JSON.parse(fromB64url(head).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromB64url(body).toString())).toEqual({
      aud: "https://push.example.net",
      exp: 1453523768,
      sub: "mailto:push@example.com",
    });
  });

  it("rejects the RFC's JWT once a claim or the key is changed", () => {
    const [head, , sig] = RFC_JWT.split(".") as [string, string, string];
    const forged = b64url(
      Buffer.from(JSON.stringify({ aud: "https://evil.example", exp: 1453523768, sub: "x" })),
    );
    expect(verifyVapidJwt(`${head}.${forged}.${sig}`, RFC_K)).toBe(false);
    expect(verifyVapidJwt(RFC_JWT, generateVapidKeys().publicKey)).toBe(false);
    expect(verifyVapidJwt("not.a-jwt", RFC_K)).toBe(false);
  });

  it("signs a JWT of RFC 8292's shape that verifies under our public key", () => {
    const pair = generateVapidKeys();
    const keys = { ...pair, subject: "mailto:push@example.com" };
    const jwt = signVapidJwt({ keys, audience: "https://push.example.net", expiresAt: 1453523768 });
    expect(verifyVapidJwt(jwt, pair.publicKey)).toBe(true);
    const [head, body, sig] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(fromB64url(head).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromB64url(body).toString())).toEqual({
      aud: "https://push.example.net",
      exp: 1453523768,
      sub: "mailto:push@example.com",
    });
    expect(fromB64url(sig)).toHaveLength(64); // r ‖ s, not DER
    expect(vapidAuthorization(jwt, pair.publicKey)).toBe(`vapid t=${jwt}, k=${pair.publicKey}`);
  });

  it("names the push service's origin as the audience", () => {
    expect(audienceOf("https://fcm.googleapis.com/fcm/send/abc:def")).toBe(
      "https://fcm.googleapis.com",
    );
    expect(audienceOf("https://web.push.apple.com/QOk-x")).toBe("https://web.push.apple.com");
  });

  it("checks a key pair belongs together and the subject is a contact", () => {
    const a = generateVapidKeys();
    const b = generateVapidKeys();
    expect(checkVapidKeys({ ...a, subject: "mailto:owner@example.com" })).toBeNull();
    expect(checkVapidKeys({ ...a, subject: "https://syb.example" })).toBeNull();
    expect(checkVapidKeys({ ...a, privateKey: b.privateKey, subject: "mailto:o@e.com" })).toMatch(
      /doesn't belong/,
    );
    expect(checkVapidKeys({ ...a, subject: "owner@example.com" })).toMatch(/VAPID_SUBJECT/);
    expect(checkVapidKeys({ ...a, publicKey: "abc", subject: "mailto:o@e.com" })).toMatch(
      /VAPID_PUBLIC_KEY/,
    );
    expect(checkVapidKeys({ ...a, privateKey: "abc", subject: "mailto:o@e.com" })).toMatch(
      /VAPID_PRIVATE_KEY/,
    );
  });

  it("generates a public key a browser takes as applicationServerKey: 65 bytes, 0x04 first", () => {
    for (let i = 0; i < 20; i++) {
      const { publicKey, privateKey } = generateVapidKeys();
      expect(fromB64url(publicKey)).toHaveLength(65);
      expect(fromB64url(publicKey)[0]).toBe(0x04);
      expect(fromB64url(privateKey)).toHaveLength(32);
    }
  });
});
