import type { JsonLdDocument } from "@/lib/structured-data";

/**
 * The one place a JSON-LD document becomes a tag.
 *
 * `JSON.stringify` does not escape `<`, so a string that reached this payload
 * carrying `</script>` would close the block and everything after it would be
 * parsed as markup. Replacing `<` with its unicode escape closes that door;
 * the value is identical to a JSON reader and inert to an HTML one. This is
 * the escape Next's own JSON-LD guide prescribes, and the reason every graph
 * on the site is rendered through this component rather than inline.
 *
 * A plain `<script>` on purpose — `next/script` schedules executable code, and
 * this is data the crawler must find already sitting in the document.
 */
export function JsonLd({ data }: { data: JsonLdDocument }) {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
      type="application/ld+json"
    />
  );
}
