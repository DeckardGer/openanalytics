import type { Metadata } from "next";
import { NotFoundBoard } from "@/components/not-found/not-found-board";

export const metadata: Metadata = {
  title: "Page not found | Open Analytics",
};

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center bg-[#f6f6f6] px-4 py-12">
      <NotFoundBoard />
    </main>
  );
}
