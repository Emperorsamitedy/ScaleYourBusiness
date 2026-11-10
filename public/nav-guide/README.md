# NAV setup guide: screenshot slots

The owner's Hungarian guide to creating a NAV technical user shows one
screenshot per step. Put each image here under exactly the file name below
(PNG, about 1200 px wide). Capture them from a real Online Számla account
(https://onlineszamla.nav.gov.hu) and blur every tax number, name and email
before saving.

The guide refuses to go live while any slot below is missing; its test
lists the empty ones.

| File                | What it shows                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `step-1-login.png`  | The Online Számla sign-in page (Ügyfélkapu+ / DÁP login)                                   |
| `step-2-users.png`  | The "Felhasználók" (users) menu, where technical users are managed                         |
| `step-3-new.png`    | "Új felhasználó" → choosing "Technikai felhasználó"                                        |
| `step-4-rights.png` | The permissions screen, with ONLY "Számlák lekérdezése" (query invoices) ticked            |
| `step-5-keys.png`   | The generated login, password, signature key (aláírókulcs) and exchange key — keys blurred |
| `step-6-done.png`   | The technical user listed as active                                                        |

Step 5 also shows NAV's exchange key (cserekulcs). The guide tells the
owner SYB never asks for it: SYB only reads.
