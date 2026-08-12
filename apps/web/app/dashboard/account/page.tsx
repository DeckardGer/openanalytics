import type { Metadata } from "next";
import { AccountBoard } from "@/components/dashboard/account-board";

export const metadata: Metadata = {
  title: "Account | Open Analytics",
};

export default function AccountPage() {
  // Account is user-level, like billing — it sits beside the site list
  // rather than inside a site's tabs.
  // The title lives inside the board's left column, so title + menu pin
  // together as one block while the sections scroll.
  return <AccountBoard />;
}
