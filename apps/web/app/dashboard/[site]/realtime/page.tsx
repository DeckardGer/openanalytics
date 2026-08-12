import type { Metadata } from "next";
import { RealtimeBoard } from "@/components/dashboard/realtime-board";

export const metadata: Metadata = {
  title: "Realtime | Open Analytics",
};

export default function RealtimePage() {
  return <RealtimeBoard />;
}
