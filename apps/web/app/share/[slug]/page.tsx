import type { Metadata } from "next";
import { ShareBoard } from "@/components/share/share-board";

export const metadata: Metadata = {
  title: "Shared dashboard | Open Analytics",
};

/**
 * The public share page — `/share/{share_slug}`, no account needed.
 *
 * Everything it may show is decided server-side by the owner's per-surface
 * flags; a disabled surface is simply absent from the api, and every failure
 * (wrong slug, disabled dashboard, rotated link) is an indistinguishable 404.
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <ShareBoard slug={decodeURIComponent(slug)} />;
}
