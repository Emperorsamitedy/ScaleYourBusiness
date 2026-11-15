// npm run vapid:generate — idea 53 (I-53.3).
//
// Prints a fresh VAPID key pair for phone alerts. It writes nothing
// anywhere: the owner pastes the three lines into Vercel (Project →
// Settings → Environment Variables) themselves. The private key is a
// secret like CONNECTOR_KEY: it never goes in the repo or in .env.example.
// Changing the pair later means every phone switches alerts on again,
// because a subscription is bound to the public key it was made with.

import { generateVapidKeys } from "../lib/push/webpush";

const { publicKey, privateKey } = generateVapidKeys();

console.log(`A new VAPID key pair for ScaleX's phone alerts.

Put these three into Vercel yourself (Settings → Environment Variables,
Production), then redeploy. Don't commit them anywhere.

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:<an address that reads mail about ScaleX>

VAPID_SUBJECT is the contact a push service sees (a mailto: address or an
https: URL). Keep the private key as secret as CONNECTOR_KEY. Replacing the
pair later means every phone has to switch alerts on again.`);
