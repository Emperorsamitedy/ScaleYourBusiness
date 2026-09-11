// /register — alias for /signup; both words are typed by real people.

import { redirect } from "next/navigation";

export default function RegisterPage() {
  redirect("/signup");
}
